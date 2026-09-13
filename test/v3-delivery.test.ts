import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { createAgent, getEvent } from "../src/db";
import { getShadowSummary, getV3EventDeliveryStatus, setAgentDeliveryMode } from "../src/db-v3";
import { consumeV3Message, dispatchPendingOutbox, type V3CardSender } from "../src/delivery-v3";
import { HuaweiPushError } from "../src/push";
import { retryEvent, submitTaskEvent } from "../src/service";
import type { DeliveryMessage, V3DeliveryMessage } from "../src/types";

interface QueueCapture {
  body: DeliveryMessage;
}

function testEnv(sent: QueueCapture[], fail = false): Env {
  const queue = {
    send: vi.fn(async (body: DeliveryMessage) => {
      if (fail) throw new Error("synthetic enqueue failure");
      sent.push({ body });
    }),
  };
  return new Proxy(env, {
    get(target, property) {
      if (property === "V3_DELIVERY") return "true";
      if (property === "DELIVERY_QUEUE") return queue;
      return Reflect.get(target, property);
    },
  }) as Env;
}

function message(body: V3DeliveryMessage, attempts = 1) {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<V3DeliveryMessage>;
}

async function canaryAgent(id: string) {
  const record = await createAgent(env.DB, {
    id,
    displayName: id,
    sourceLabel: `source:${id}`,
    tokenHash: `hash:${id}`,
    tokenHint: `hint:${id}`,
  });
  await submitTaskEvent(env, record, {
    task_id: "bootstrap",
    event_id: `${id}-bootstrap`,
    state: "started",
    title: "Bootstrap",
    content: "Bootstrap",
    force_notify: false,
  });
  expect(await setAgentDeliveryMode(env.DB, id, "v3")).toBe(true);
  return record;
}

async function submit(envV3: Env, agentId: string, eventId: string, content: string) {
  const record = await import("../src/db").then(({ getAgentById }) =>
    getAgentById(env.DB, agentId),
  );
  if (!record) throw new Error("missing test agent");
  return submitTaskEvent(
    envV3,
    record,
    {
      task_id: "canary-task",
      event_id: eventId,
      state: eventId.endsWith("start") ? "started" : "progress",
      title: "Canary title",
      content,
      progress: eventId.endsWith("start") ? undefined : 50,
      force_notify: false,
    },
    { bypassNotificationPolicy: true },
  );
}

describe("v3 reliable delivery", () => {
  it("does not count historical shadow revisions as active delivery lag", async () => {
    const record = await createAgent(env.DB, {
      id: "v3-shadow-history",
      displayName: "v3-shadow-history",
      sourceLabel: "shadow history",
      tokenHash: "hash:v3-shadow-history",
      tokenHint: "hint:v3-shadow-history",
    });
    await submitTaskEvent(
      env,
      record,
      {
        task_id: "historical-task",
        event_id: "historical-complete",
        state: "completed",
        title: "Historical shadow",
        content: "not a delivery backlog",
        force_notify: false,
      },
      { bypassNotificationPolicy: true },
    );
    const before = (await getShadowSummary(env.DB)).revision_lag;
    expect(await setAgentDeliveryMode(env.DB, record.id, "v3")).toBe(true);
    expect((await getShadowSummary(env.DB)).revision_lag).toBe(before);
  });

  it("uses only v3 for a canary agent and delivers the latest projection", async () => {
    const record = await canaryAgent("v3-only");
    const sent: QueueCapture[] = [];
    const envV3 = testEnv(sent);
    const output = await submit(envV3, record.id, "only-start", "revision one");

    expect(output.message).toContain("v3");
    expect(await getEvent(env.DB, "only-start")).toMatchObject({
      deliveryStatus: "suppressed",
      suppressionReason: "v3_delivery_authoritative",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ kind: "v3", targetRevision: 1 });

    const queued = sent[0]!.body as V3DeliveryMessage;
    const sender = vi.fn<V3CardSender>(async (_env, card) => ({
      code: "0000000000",
      description: card.content,
    }));
    const queuedMessage = message(queued);
    await consumeV3Message(queuedMessage, envV3, sender);
    expect(sender).toHaveBeenCalledOnce();
    expect(sender.mock.calls[0]![1]).toMatchObject({
      title: "Canary title",
      summary: "Canary title",
      content: "revision one",
    });
    expect(queuedMessage.ack).toHaveBeenCalledOnce();
  });

  it("coalesces old and duplicate wakeups onto the newest desired revision", async () => {
    const record = await canaryAgent("v3-coalesce");
    const sent: QueueCapture[] = [];
    const envV3 = testEnv(sent);
    await submit(envV3, record.id, "coalesce-start", "revision one");
    await submit(envV3, record.id, "coalesce-progress", "revision two");
    expect(sent).toHaveLength(2);

    const sender = vi.fn<V3CardSender>(async () => ({ code: "0", description: "ok" }));
    await consumeV3Message(message(sent[0]!.body as V3DeliveryMessage), envV3, sender);
    await consumeV3Message(message(sent[0]!.body as V3DeliveryMessage), envV3, sender);
    await consumeV3Message(message(sent[1]!.body as V3DeliveryMessage), envV3, sender);
    expect(sender).toHaveBeenCalledOnce();
    expect(sender.mock.calls[0]![1].content).toBe("revision two");
  });

  it("serializes a card with a lease and recovers after lease expiry", async () => {
    const record = await canaryAgent("v3-lease");
    const sent: QueueCapture[] = [];
    const envV3 = testEnv(sent);
    await submit(envV3, record.id, "lease-start", "leased");
    const body = sent[0]!.body as V3DeliveryMessage;
    await env.DB.prepare(
      "UPDATE card_delivery_state SET lease_token = 'other', lease_until = ? WHERE task_id = ?",
    )
      .bind(Math.floor(Date.now() / 1_000) + 60, body.taskId)
      .run();
    const blocked = message(body);
    const sender = vi.fn<V3CardSender>();
    await consumeV3Message(blocked, envV3, sender);
    expect(blocked.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
    expect(sender).not.toHaveBeenCalled();

    await env.DB.prepare("UPDATE card_delivery_state SET lease_until = ? WHERE task_id = ?")
      .bind(Math.floor(Date.now() / 1_000) - 1, body.taskId)
      .run();
    sender.mockResolvedValue({ code: "0", description: "ok" });
    await consumeV3Message(message(body), envV3, sender);
    expect(sender).toHaveBeenCalledOnce();
  });

  it("retries unknown failures with the same provider message ID", async () => {
    const record = await canaryAgent("v3-retry");
    const sent: QueueCapture[] = [];
    const envV3 = testEnv(sent);
    await submit(envV3, record.id, "retry-start", "retry me");
    const body = sent[0]!.body as V3DeliveryMessage;
    const ids: string[] = [];
    const sender = vi.fn<V3CardSender>(async (_target, card) => {
      ids.push(card.messageId);
      if (ids.length === 1) throw new Error("connection reset after upload");
      return { code: "0", description: "ok" };
    });
    const first = message(body);
    await consumeV3Message(first, envV3, sender);
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    await env.DB.prepare("UPDATE card_delivery_state SET next_attempt_at = NULL WHERE task_id = ?")
      .bind(body.taskId)
      .run();
    await consumeV3Message(message(body, 2), envV3, sender);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("does not advance delivered revision after losing its lease in flight", async () => {
    const record = await canaryAgent("v3-lease-loss");
    const sent: QueueCapture[] = [];
    const envV3 = testEnv(sent);
    await submit(envV3, record.id, "loss-start", "lease changes during upload");
    const body = sent[0]!.body as V3DeliveryMessage;
    await consumeV3Message(message(body), envV3, async () => {
      await env.DB.prepare(
        "UPDATE card_delivery_state SET lease_token = 'replacement', lease_until = ? WHERE task_id = ?",
      )
        .bind(Math.floor(Date.now() / 1_000) + 60, body.taskId)
        .run();
      return { code: "0", description: "accepted" };
    });
    expect(
      await env.DB.prepare("SELECT delivered_revision FROM tasks_v3 WHERE id = ?")
        .bind(body.taskId)
        .first("delivered_revision"),
    ).toBe(0);
  });

  it("marks permanent Huawei rejection failed without retrying", async () => {
    const record = await canaryAgent("v3-permanent");
    const sent: QueueCapture[] = [];
    const envV3 = testEnv(sent);
    await submit(envV3, record.id, "permanent-start", "bad auth");
    const body = sent[0]!.body as V3DeliveryMessage;
    const queued = message(body);
    await consumeV3Message(queued, envV3, async () => {
      throw new HuaweiPushError("invalid auth", false, 401, "AUTH", "invalid");
    });
    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT state FROM outbox WHERE id = ?")
        .bind(body.outboxId)
        .first("state"),
    ).toBe("failed");
    expect(await getV3EventDeliveryStatus(env.DB, record.id, "permanent-start")).toMatchObject({
      revisionLag: 1,
      outboxState: "failed",
      providerCode: "AUTH",
    });
    const beforeRetry = sent.length;
    await retryEvent(envV3, "permanent-start");
    expect(sent).toHaveLength(beforeRetry + 1);
    expect(sent.at(-1)!.body).toMatchObject({ kind: "v3", outboxId: body.outboxId });
  });

  it("recovers an enqueue gap through the scheduled dispatcher", async () => {
    const record = await canaryAgent("v3-dispatch");
    const failedEnv = testEnv([], true);
    await submit(failedEnv, record.id, "dispatch-start", "recover enqueue");
    const pending = await env.DB.prepare(
      `SELECT id, task_id AS taskId FROM outbox WHERE task_id IN
         (SELECT id FROM tasks_v3 WHERE agent_id = ? AND external_task_id = 'canary-task')`,
    )
      .bind(record.id)
      .first<{ id: string; taskId: string }>();
    expect(pending).toBeTruthy();
    await env.DB.prepare("UPDATE outbox SET available_at = ? WHERE id = ?")
      .bind(Math.floor(Date.now() / 1_000) - 1, pending!.id)
      .run();
    const recovered: QueueCapture[] = [];
    expect(await dispatchPendingOutbox(testEnv(recovered))).toBe(1);
    expect(recovered[0]!.body).toMatchObject({ kind: "v3", outboxId: pending!.id });
  });

  it("falls back to the legacy event when the global kill switch is off", async () => {
    const record = await canaryAgent("v3-rollback");
    const sent: QueueCapture[] = [];
    const envV3 = testEnv(sent);
    await submit(envV3, record.id, "rollback-start", "fallback");
    const v3Body = sent[0]!.body as V3DeliveryMessage;
    const legacySent: QueueCapture[] = [];
    const envOff = new Proxy(env, {
      get(target, property) {
        if (property === "DELIVERY_QUEUE")
          return { send: async (body: DeliveryMessage) => legacySent.push({ body }) };
        return Reflect.get(target, property);
      },
    }) as Env;
    await consumeV3Message(message(v3Body), envOff, vi.fn<V3CardSender>());
    expect(legacySent).toEqual([{ body: { eventId: "rollback-start" } }]);
    expect(await getEvent(env.DB, "rollback-start")).toMatchObject({
      deliveryStatus: "queued",
      suppressionReason: null,
    });
  });

  it("cron restores a v3 event that never reached the queue after shutdown", async () => {
    const record = await canaryAgent("v3-shutdown-gap");
    await submit(testEnv([], true), record.id, "shutdown-start", "not enqueued");
    const legacySent: QueueCapture[] = [];
    const envOff = new Proxy(env, {
      get(target, property) {
        if (property === "DELIVERY_QUEUE")
          return { send: async (body: DeliveryMessage) => legacySent.push({ body }) };
        return Reflect.get(target, property);
      },
    }) as Env;
    expect(await dispatchPendingOutbox(envOff)).toBe(0);
    expect(legacySent).toContainEqual({ body: { eventId: "shutdown-start" } });
    expect(await getEvent(env.DB, "shutdown-start")).toMatchObject({
      deliveryStatus: "queued",
      suppressionReason: null,
    });
  });
});
