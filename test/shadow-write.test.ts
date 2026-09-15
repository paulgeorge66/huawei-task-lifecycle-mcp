import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createAgent, getEvent, getTask } from "../src/db";
import { getShadowEventIdentity, getShadowSummary, listShadowDiffs } from "../src/db-v3";
import { submitTaskEvent } from "../src/service";
import { EventConflictError } from "../src/submission-policy";

async function agent(id: string) {
  return createAgent(env.DB, {
    id,
    displayName: id,
    sourceLabel: `source:${id}`,
    tokenHash: `hash:${id}`,
    tokenHint: `hint:${id}`,
  });
}

async function taskRow(agentId: string, externalTaskId: string) {
  return env.DB.prepare(
    `SELECT state, revision, delivered_revision AS deliveredRevision
     FROM tasks_v3 WHERE agent_id = ? AND external_task_id = ?`,
  )
    .bind(agentId, externalTaskId)
    .first<{ state: string; revision: number; deliveredRevision: number }>();
}

describe("v3 shadow writes", () => {
  it("atomically records one event, revision, projection, and shadow outbox", async () => {
    const record = await agent("shadow-basic");
    const input = {
      task_id: "task-basic",
      event_id: "event-start",
      state: "started" as const,
      title: "Shadow basic",
      content: "Started",
      force_notify: false as const,
    };

    const first = await submitTaskEvent(env, record, input, { bypassNotificationPolicy: true });
    const repeated = await submitTaskEvent(env, record, input);
    expect(first.delivery_status).toBe("queued");
    expect(repeated.message).toContain("幂等");
    expect(await taskRow(record.id, input.task_id)).toEqual({
      state: "running",
      revision: 1,
      deliveredRevision: 0,
    });
    expect(await getShadowEventIdentity(env.DB, record.id, input.event_id)).toEqual({
      requestHash: expect.any(String),
      disposition: "applied",
      revision: 1,
    });
    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM events_v3 WHERE agent_id = ?) AS events,
         (SELECT COUNT(*) FROM card_projections WHERE task_id IN
           (SELECT id FROM tasks_v3 WHERE agent_id = ?)) AS projections,
         (SELECT COUNT(*) FROM outbox WHERE task_id IN
           (SELECT id FROM tasks_v3 WHERE agent_id = ?)) AS outboxRows`,
    )
      .bind(record.id, record.id, record.id)
      .first<{ events: number; projections: number; outboxRows: number }>();
    expect(counts).toEqual({ events: 1, projections: 1, outboxRows: 1 });
  });

  it("rejects an event ID reused with different content", async () => {
    const record = await agent("shadow-conflict");
    const base = {
      task_id: "task-conflict",
      event_id: "event-conflict",
      state: "completed" as const,
      title: "Conflict",
      content: "Version A",
      force_notify: false as const,
    };
    await submitTaskEvent(env, record, base);
    await expect(
      submitTaskEvent(env, record, { ...base, content: "Version B" }),
    ).rejects.toBeInstanceOf(EventConflictError);
  });

  it("returns HTTP 409 for an idempotency conflict", async () => {
    const eventId = crypto.randomUUID();
    const body = {
      task_id: `http-conflict:${eventId}`,
      event_id: eventId,
      state: "completed",
      title: "HTTP conflict",
      content: "Version A",
      force_notify: false,
    };
    const request = (content: string) =>
      SELF.fetch("https://example.com/hooks/agent", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.CODEX_WEBHOOK_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...body, content }),
      });

    expect((await request("Version A")).status).toBe(202);
    const conflict = await request("Version B");
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      success: false,
      message: "event_id already exists with different content",
    });
  });

  it("rolls back the legacy write if the v3 half of the batch conflicts", async () => {
    const record = await agent("shadow-rollback");
    const eventId = "rollback-event";
    const taskId = "rollback-task";
    await submitTaskEvent(
      env,
      record,
      {
        task_id: taskId,
        event_id: eventId,
        state: "completed",
        title: "Rollback",
        content: "Original",
        force_notify: false,
      },
      { bypassNotificationPolicy: true },
    );
    await env.DB.batch([
      env.DB.prepare("DELETE FROM events WHERE id = ?").bind(eventId),
      env.DB.prepare("DELETE FROM tasks WHERE id = ? AND agent_id = ?").bind(taskId, record.id),
    ]);

    await expect(
      submitTaskEvent(env, record, {
        task_id: taskId,
        event_id: eventId,
        state: "completed",
        title: "Rollback",
        content: "Changed",
        force_notify: false,
      }),
    ).rejects.toBeInstanceOf(EventConflictError);
    expect(await getEvent(env.DB, eventId)).toBeNull();
    expect(await getTask(env.DB, taskId, record.id)).toBeNull();
  });

  it("applies a policy-suppressed event without creating delivery intent", async () => {
    const record = await agent("shadow-suppressed");
    await submitTaskEvent(env, record, {
      task_id: "suppressed-task",
      event_id: "suppressed-start",
      state: "started",
      title: "Suppressed start",
      content: "Working",
      force_notify: false,
    });

    expect(await taskRow(record.id, "suppressed-task")).toMatchObject({
      state: "running",
      revision: 1,
    });
    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM card_projections WHERE task_id = task.id) AS projections,
         (SELECT COUNT(*) FROM outbox WHERE task_id = task.id) AS outboxRows,
         (SELECT COUNT(*) FROM card_delivery_state WHERE task_id = task.id) AS deliveryStateRows
       FROM tasks_v3 task WHERE agent_id = ? AND external_task_id = ?`,
    )
      .bind(record.id, "suppressed-task")
      .first<{ projections: number; outboxRows: number; deliveryStateRows: number }>();
    expect(counts).toEqual({ projections: 1, outboxRows: 0, deliveryStateRows: 0 });
  });

  it("increments revision but marks an old-run update stale after terminal", async () => {
    const record = await agent("shadow-terminal");
    const common = { task_id: "task-terminal", title: "Terminal", force_notify: false as const };
    await submitTaskEvent(env, record, {
      ...common,
      event_id: "terminal-start",
      state: "started",
      content: "Started",
    });
    await submitTaskEvent(env, record, {
      ...common,
      event_id: "terminal-complete",
      state: "completed",
      content: "Done",
    });
    await submitTaskEvent(env, record, {
      ...common,
      event_id: "terminal-late-progress",
      state: "progress",
      progress: 20,
      content: "Late",
    });

    expect(await taskRow(record.id, common.task_id)).toEqual({
      state: "completed",
      revision: 3,
      deliveredRevision: 0,
    });
    expect(await getShadowEventIdentity(env.DB, record.id, "terminal-late-progress")).toMatchObject(
      { disposition: "stale", revision: 3 },
    );
    const projectionCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM card_projections WHERE task_id =
       (SELECT id FROM tasks_v3 WHERE agent_id = ? AND external_task_id = ?)`,
    )
      .bind(record.id, common.task_id)
      .first<number>("count");
    expect(projectionCount).toBe(2);
  });

  it("records turn.completed without changing semantic task state", async () => {
    const record = await agent("shadow-turn");
    const common = { task_id: "task-turn", title: "Turn", force_notify: false as const };
    await submitTaskEvent(env, record, {
      ...common,
      event_id: "turn-start",
      state: "started",
      content: "Working",
    });
    await submitTaskEvent(
      env,
      record,
      {
        ...common,
        event_id: "turn-hook",
        state: "started",
        content: "Assistant answer",
      },
      { bypassNotificationPolicy: true, shadowEventType: "turn.completed" },
    );

    expect(await taskRow(record.id, common.task_id)).toEqual({
      state: "running",
      revision: 2,
      deliveredRevision: 0,
    });
    expect(await getShadowEventIdentity(env.DB, record.id, "turn-hook")).toMatchObject({
      disposition: "observed",
      revision: 2,
    });
    const projection = await env.DB.prepare(
      `SELECT result, content FROM card_projections WHERE task_id =
       (SELECT id FROM tasks_v3 WHERE agent_id = ? AND external_task_id = ?)
       ORDER BY revision DESC LIMIT 1`,
    )
      .bind(record.id, common.task_id)
      .first<{ result: string; content: string }>();
    expect(projection).toEqual({ result: "本轮已结束", content: "Assistant answer" });
  });

  it("records but never delivers a Hook-only task without a semantic lifecycle", async () => {
    const record = await agent("shadow-turn-only");
    const first = await submitTaskEvent(
      env,
      record,
      {
        task_id: "turn-only-task",
        event_id: "turn-only-event",
        state: "completed",
        title: "Turn only",
        content: "Visible answer",
        force_notify: false,
      },
      { bypassNotificationPolicy: true, shadowEventType: "turn.completed" },
    );
    const second = await submitTaskEvent(
      env,
      record,
      {
        task_id: "turn-only-task",
        event_id: "turn-only-event-2",
        state: "completed",
        title: "Turn only renamed",
        content: "Another visible answer",
        force_notify: false,
      },
      { bypassNotificationPolicy: true, shadowEventType: "turn.completed" },
    );

    expect(await taskRow(record.id, "turn-only-task")).toMatchObject({
      state: "new",
      revision: 2,
    });
    expect(await getShadowEventIdentity(env.DB, record.id, "turn-only-event")).toMatchObject({
      disposition: "observed",
      revision: 1,
    });
    expect(first).toMatchObject({
      delivery_status: "suppressed",
      suppression_reason: "hook_without_semantic_task",
    });
    expect(second).toMatchObject({
      delivery_status: "suppressed",
      suppression_reason: "hook_without_semantic_task",
    });
    const counts = await env.DB.prepare(
      `SELECT
           (SELECT COUNT(*) FROM card_projections WHERE task_id = task.id) AS projections,
           (SELECT COUNT(*) FROM outbox WHERE task_id = task.id) AS outboxRows,
           (SELECT COUNT(*) FROM card_delivery_state WHERE task_id = task.id) AS deliveryStateRows
         FROM tasks_v3 task WHERE task.agent_id = ? AND task.external_task_id = ?`,
    )
      .bind(record.id, "turn-only-task")
      .first<{ projections: number; outboxRows: number; deliveryStateRows: number }>();
    expect(counts).toEqual({ projections: 2, outboxRows: 0, deliveryStateRows: 0 });
  });

  it("exposes the shadow summary and differences to an authenticated administrator", async () => {
    const form = new FormData();
    form.set("password", env.OWNER_PASSWORD);
    const login = await SELF.fetch("https://example.com/admin/login", {
      method: "POST",
      body: form,
      redirect: "manual",
    });
    expect(login.status).toBe(303);
    const cookie = login.headers.get("Set-Cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const response = await SELF.fetch("https://example.com/api/admin/shadow?limit=50", {
      headers: { Cookie: cookie! },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      summary: {
        event_outbox_mismatches: 0,
        projection_mismatches: 1,
      },
      total: 1,
      items: [{ kind: "task_projection", taskId: "task-terminal" }],
    });
  });

  it("reports shadow comparison counts", async () => {
    const summary = await getShadowSummary(env.DB);
    expect(summary.tasks).toBeGreaterThan(0);
    expect(summary.events).toBeGreaterThan(0);
    expect(summary.outbox_shadowed).toBeGreaterThan(0);
    expect(summary.stale_events).toBeGreaterThan(0);
    expect(summary.suppressed_events).toBeGreaterThan(0);
    expect(summary.event_outbox_mismatches).toBe(0);
    expect(summary.projection_mismatches).toBe(1);
    await expect(listShadowDiffs(env.DB, 50, 0)).resolves.toMatchObject({
      total: 1,
      items: [
        {
          kind: "task_projection",
          agentId: "shadow-terminal",
          taskId: "task-terminal",
          legacyValue: "progress | Terminal",
          shadowValue: "completed | Terminal",
          reason: "state_or_title_mismatch",
        },
      ],
    });
  });
});
