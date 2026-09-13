import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const headers = () => ({
  Authorization: `Bearer ${env.CODEX_WEBHOOK_TOKEN}`,
  "Content-Type": "application/json",
});

async function submit(body: Record<string, unknown>) {
  return SELF.fetch("https://example.com/api/v3/events", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
}

async function v3Task(externalTaskId: string) {
  return env.DB.prepare(
    `SELECT state, title, revision, current_run_id AS currentRunId
     FROM tasks_v3 WHERE agent_id = 'codex-legacy' AND external_task_id = ?`,
  )
    .bind(externalTaskId)
    .first<{ state: string; title: string; revision: number; currentRunId: string | null }>();
}

describe("v3 event protocol", () => {
  it("requires an Agent bearer token and exposes stable API errors", async () => {
    const response = await SELF.fetch("https://example.com/api/v3/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: "unauthorized",
      trace_id: expect.any(String),
    });
  });

  it("records waiting as a first-class v3 state and stores ingress tracing", async () => {
    const suffix = crypto.randomUUID();
    const taskId = `waiting:${suffix}`;
    const eventId = `waiting-event:${suffix}`;
    const response = await submit({
      task_id: taskId,
      run_id: `run:${suffix}`,
      event_id: eventId,
      type: "task.waiting",
      title: "等待用户确认",
      summary: "等待中",
      content: "请选择下一步。",
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      acceptance: "recorded",
      event_id: eventId,
      task_id: taskId,
      revision: 1,
      disposition: "applied",
      trace_id: expect.any(String),
    });
    expect(await v3Task(taskId)).toMatchObject({ state: "waiting", revision: 1 });
    expect(
      await env.DB.prepare(
        "SELECT event_type AS eventType, ingress, trace_id AS traceId FROM events_v3 WHERE agent_id = 'codex-legacy' AND id = ?",
      )
        .bind(eventId)
        .first(),
    ).toMatchObject({ eventType: "task.waiting", ingress: "v3_api", traceId: expect.any(String) });
  });

  it("allows an explicit new run to reopen a terminal task", async () => {
    const suffix = crypto.randomUUID();
    const taskId = `rerun:${suffix}`;
    const common = { task_id: taskId, title: "可重复任务", content: "状态正文" };
    for (const [eventId, runId, type] of [
      [`start-a:${suffix}`, `run-a:${suffix}`, "task.started"],
      [`done-a:${suffix}`, `run-a:${suffix}`, "task.completed"],
      [`start-b:${suffix}`, `run-b:${suffix}`, "task.started"],
    ] as const) {
      const response = await submit({
        ...common,
        event_id: eventId,
        run_id: runId,
        type,
      });
      expect(response.status).toBe(202);
    }
    const task = await v3Task(taskId);
    expect(task).toMatchObject({ state: "running", revision: 3 });
    const run = await env.DB.prepare(
      "SELECT external_run_id AS externalRunId, state FROM task_runs WHERE id = ?",
    )
      .bind(task!.currentRunId)
      .first();
    expect(run).toEqual({ externalRunId: `run-b:${suffix}`, state: "running" });
  });

  it("renames a terminal card without regressing its semantic state", async () => {
    const suffix = crypto.randomUUID();
    const taskId = `rename:${suffix}`;
    const runId = `rename-run:${suffix}`;
    await submit({
      task_id: taskId,
      run_id: runId,
      event_id: `rename-done:${suffix}`,
      type: "task.completed",
      title: "旧标题",
      content: "已完成",
    });
    const rename = await submit({
      task_id: taskId,
      run_id: runId,
      event_id: `rename-title:${suffix}`,
      type: "task.renamed",
      title: "新标题",
      content: "标题已校正",
    });
    expect(rename.status).toBe(202);
    await expect(rename.json()).resolves.toMatchObject({ disposition: "observed", revision: 2 });
    expect(await v3Task(taskId)).toMatchObject({
      state: "completed",
      title: "新标题",
      revision: 2,
    });
  });

  it("keeps liveness shallow and readiness dependency-aware", async () => {
    const live = await SELF.fetch("https://example.com/health/live");
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toMatchObject({ ok: true, version: expect.any(String) });

    const ready = await SELF.fetch("https://example.com/health/ready");
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({
      ok: true,
      dependencies: { d1: true, queue: true, secrets: true },
    });
  });

  it("reports authenticated delivery status and can retry a failed event", async () => {
    const suffix = crypto.randomUUID();
    const eventId = `status-event:${suffix}`;
    await submit({
      task_id: `status-task:${suffix}`,
      run_id: `status-run:${suffix}`,
      event_id: eventId,
      type: "task.completed",
      title: "状态查询",
      content: "等待查询",
    });
    const status = await SELF.fetch(
      `https://example.com/api/v3/events/${encodeURIComponent(eventId)}`,
      { headers: { Authorization: `Bearer ${env.CODEX_WEBHOOK_TOKEN}` } },
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      success: true,
      event_id: eventId,
      recorded: true,
      action: "status",
      delivery: { revision: 1, revision_lag: 1, outbox_state: "shadowed" },
    });

    await env.DB.prepare(
      "UPDATE events SET delivery_status = 'failed', last_error = 'synthetic' WHERE id = ?",
    )
      .bind(eventId)
      .run();
    const retried = await SELF.fetch(
      `https://example.com/api/v3/events/${encodeURIComponent(eventId)}/retry`,
      { method: "POST", headers: { Authorization: `Bearer ${env.CODEX_WEBHOOK_TOKEN}` } },
    );
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({
      success: true,
      event_id: eventId,
      action: "retry_requested",
      legacy_delivery: "queued",
    });
  });

  it("provides a non-secret authenticated doctor report", async () => {
    const response = await SELF.fetch("https://example.com/api/v3/doctor", {
      headers: { Authorization: `Bearer ${env.CODEX_WEBHOOK_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const report = await response.json<Record<string, unknown>>();
    expect(report).toMatchObject({
      success: true,
      protocol: "v3",
      agent: { id: "codex-legacy", active: true },
      delivery: { global_v3_enabled: false, agent_mode: "shadow" },
      trace_id: expect.any(String),
    });
    expect(JSON.stringify(report)).not.toContain(env.CODEX_WEBHOOK_TOKEN);
  });

  it("mirrors created and rotated Agent credentials without changing agent identity", async () => {
    const form = new FormData();
    form.set("password", env.OWNER_PASSWORD);
    const login = await SELF.fetch("https://example.com/admin/login", {
      method: "POST",
      body: form,
      redirect: "manual",
    });
    const cookie = login.headers.get("Set-Cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    const dashboard = await SELF.fetch("https://example.com/admin", {
      headers: { Cookie: cookie! },
    });
    const html = await dashboard.text();
    const csrfMatch = /const csrf=("[^"]+");const api/u.exec(html);
    expect(csrfMatch).toBeTruthy();
    const csrf = JSON.parse(csrfMatch![1]!) as string;
    const mutationHeaders = {
      Cookie: cookie!,
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
    };
    const created = await SELF.fetch("https://example.com/api/admin/agents", {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ display_name: "Credential test", source_label: "Credential source" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json<{ agent: { id: string } }>();
    const agentId = createdBody.agent.id;
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM credentials WHERE agent_id = ? AND kind = 'token' AND active = 1",
      )
        .bind(agentId)
        .first<number>("count"),
    ).toBe(1);

    const rotated = await SELF.fetch(
      `https://example.com/api/admin/agents/${encodeURIComponent(agentId)}/token`,
      { method: "POST", headers: { Cookie: cookie!, "X-CSRF-Token": csrf } },
    );
    expect(rotated.status).toBe(200);
    await expect(rotated.json()).resolves.toMatchObject({ agent: { id: agentId } });
    expect(
      await env.DB.prepare(
        `SELECT
           SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN active = 0 AND revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked
         FROM credentials WHERE agent_id = ? AND kind = 'token'`,
      )
        .bind(agentId)
        .first(),
    ).toEqual({ active: 1, revoked: 1 });
  });
});
