import {
  claimPendingOutbox,
  getAgentDeliveryMode,
  markOutboxEnqueued,
  markOutboxEnqueueFailed,
  type V3DeliveryRecord,
} from "./db-v3";
import { revisionMessageIdFor } from "./identity";
import {
  HuaweiPushError,
  pushCardToHuawei,
  type HuaweiCardInput,
  type HuaweiPushResult,
} from "./push";
import type { DeliveryMessage, LegacyDeliveryMessage, V3DeliveryMessage } from "./types";

export type V3CardSender = (env: Env, card: HuaweiCardInput) => Promise<HuaweiPushResult>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown v3 delivery error";
}

function retryDelay(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempt - 1), 43_200);
}

function v3Enabled(env: Env): boolean {
  return String(env.V3_DELIVERY) === "true";
}

export function isV3DeliveryMessage(message: DeliveryMessage): message is V3DeliveryMessage {
  return "kind" in message && message.kind === "v3";
}

export async function dispatchPendingOutbox(env: Env, limit = 50): Promise<number> {
  await restoreDisabledV3Deliveries(env, limit);
  if (!v3Enabled(env)) return 0;
  const now = Math.floor(Date.now() / 1_000);
  const rows = await claimPendingOutbox(env.DB, now, limit);
  let sent = 0;
  for (const row of rows) {
    try {
      await env.DELIVERY_QUEUE.send(
        {
          kind: "v3",
          outboxId: row.outboxId,
          taskId: row.taskId,
          targetRevision: row.targetRevision,
        } satisfies V3DeliveryMessage,
        { contentType: "json" },
      );
      await markOutboxEnqueued(env.DB, row.outboxId, now);
      sent += 1;
    } catch (error) {
      await markOutboxEnqueueFailed(env.DB, row.outboxId, errorMessage(error), now);
    }
  }
  return sent;
}

async function restoreDisabledV3Deliveries(env: Env, limit: number): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT box.id AS outboxId, box.task_id AS taskId,
         box.target_revision AS targetRevision
       FROM outbox box
       JOIN tasks_v3 task ON task.id = box.task_id
       JOIN agents_v3 agent ON agent.id = task.agent_id
       JOIN card_delivery_state state ON state.task_id = task.id
       WHERE box.state != 'shadowed' AND box.target_revision > state.accepted_revision
         AND (? = 0 OR agent.delivery_mode != 'v3')
       ORDER BY box.created_at LIMIT ?`,
  )
    .bind(v3Enabled(env) ? 1 : 0, limit)
    .all<{ outboxId: string; taskId: string; targetRevision: number }>();
  for (const row of rows.results) {
    await restoreLegacyDelivery(env, {
      kind: "v3",
      outboxId: row.outboxId,
      taskId: row.taskId,
      targetRevision: row.targetRevision,
    });
  }
  return rows.results.length;
}

async function restoreLegacyDelivery(env: Env, message: V3DeliveryMessage): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT event.id AS eventId
       FROM outbox box
       JOIN events_v3 event
         ON event.task_id = box.task_id AND event.revision = box.target_revision
       WHERE box.id = ?`,
  )
    .bind(message.outboxId)
    .first<{ eventId: string }>();
  if (row) {
    const changed = await env.DB.prepare(
      `UPDATE events SET delivery_status = 'pending', suppression_reason = NULL,
           last_error = NULL, updated_at = ?
         WHERE id = ? AND delivery_status = 'suppressed'
           AND suppression_reason = 'v3_delivery_authoritative'`,
    )
      .bind(Math.floor(Date.now() / 1_000), row.eventId)
      .run();
    const legacy = await env.DB.prepare("SELECT delivery_status AS status FROM events WHERE id = ?")
      .bind(row.eventId)
      .first<{ status: string }>();
    if (
      changed.meta.changes ||
      legacy?.status === "pending" ||
      legacy?.status === "enqueue_failed"
    ) {
      try {
        await env.DELIVERY_QUEUE.send({ eventId: row.eventId } satisfies LegacyDeliveryMessage, {
          contentType: "json",
        });
        await env.DB.prepare(
          "UPDATE events SET delivery_status = 'queued', queued_at = ?, updated_at = ? WHERE id = ?",
        )
          .bind(Math.floor(Date.now() / 1_000), Math.floor(Date.now() / 1_000), row.eventId)
          .run();
      } catch (error) {
        await env.DB.prepare(
          "UPDATE events SET delivery_status = 'enqueue_failed', last_error = ?, updated_at = ? WHERE id = ?",
        )
          .bind(errorMessage(error).slice(0, 1_000), Math.floor(Date.now() / 1_000), row.eventId)
          .run();
        throw error;
      }
    }
  }
  await env.DB.prepare("UPDATE outbox SET state = 'shadowed', updated_at = ? WHERE id = ?")
    .bind(Math.floor(Date.now() / 1_000), message.outboxId)
    .run();
}

async function deliveryRecord(db: D1Database, taskId: string): Promise<V3DeliveryRecord | null> {
  const row = await db
    .prepare(
      `SELECT box.id AS outboxId, task.id AS taskId, task.agent_id AS agentId,
          task.external_task_id AS externalTaskId, task.card_id AS cardId,
          box.target_revision AS targetRevision, state.desired_revision AS desiredRevision,
          state.accepted_revision AS acceptedRevision, state.lease_token AS leaseToken,
          state.lease_until AS leaseUntil, state.next_attempt_at AS nextAttemptAt,
          state.failure_count AS failureCount, projection.title, projection.result,
          projection.content, projection.source, projection.display_at AS displayAt
       FROM tasks_v3 task
       JOIN card_delivery_state state ON state.task_id = task.id
       JOIN card_projections projection
         ON projection.task_id = task.id AND projection.revision = state.desired_revision
       JOIN outbox box
         ON box.task_id = task.id AND box.target_revision = state.desired_revision
       WHERE task.id = ?`,
    )
    .bind(taskId)
    .first<V3DeliveryRecord>();
  return row ?? null;
}

async function recordAttempt(
  db: D1Database,
  record: V3DeliveryRecord,
  providerMessageId: string,
  attempt: number,
  outcome: string,
  startedAtMs: number,
  error?: unknown,
  result?: HuaweiPushResult,
): Promise<void> {
  const huawei = error instanceof HuaweiPushError ? error : null;
  await db
    .prepare(
      `INSERT INTO delivery_attempts_v3
       (task_id, revision, provider, provider_msg_id, attempt, outcome, http_status,
        provider_code, latency_ms, error_class, created_at, description)
       VALUES (?, ?, 'huawei', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.taskId,
      record.desiredRevision,
      providerMessageId,
      attempt,
      outcome,
      huawei?.httpStatus ?? null,
      result?.code ?? huawei?.code ?? null,
      Date.now() - startedAtMs,
      error instanceof Error ? error.name : null,
      Math.floor(Date.now() / 1_000),
      result?.description ?? huawei?.description ?? (error ? errorMessage(error) : null),
    )
    .run();
}

async function releaseLease(
  db: D1Database,
  record: V3DeliveryRecord,
  leaseToken: string,
  error: unknown,
  retrying: boolean,
  delaySeconds: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  const huawei = error instanceof HuaweiPushError ? error : null;
  await db
    .prepare(
      `UPDATE card_delivery_state SET lease_token = NULL, lease_until = NULL,
         failure_count = failure_count + 1, next_attempt_at = ?, last_attempt_at = ?,
         last_error = ?, last_provider_code = ?, last_provider_description = ?, updated_at = ?
       WHERE task_id = ? AND lease_token = ?`,
    )
    .bind(
      retrying ? now + delaySeconds : null,
      now,
      errorMessage(error).slice(0, 1_000),
      huawei?.code ?? null,
      huawei?.description ?? null,
      now,
      record.taskId,
      leaseToken,
    )
    .run();
  if (!retrying) {
    await db
      .prepare(
        `UPDATE outbox SET state = 'failed', last_error = ?, completed_at = ?, updated_at = ?
         WHERE task_id = ? AND target_revision <= ? AND state != 'shadowed'`,
      )
      .bind(errorMessage(error).slice(0, 1_000), now, now, record.taskId, record.desiredRevision)
      .run();
  }
}

export async function consumeV3Message(
  message: Message<V3DeliveryMessage>,
  env: Env,
  sender: V3CardSender = pushCardToHuawei,
): Promise<void> {
  const mode = await getAgentDeliveryModeForTask(env.DB, message.body.taskId);
  if (!v3Enabled(env) || mode !== "v3") {
    await restoreLegacyDelivery(env, message.body);
    message.ack();
    return;
  }
  let record = await deliveryRecord(env.DB, message.body.taskId);
  if (!record || record.acceptedRevision >= record.desiredRevision) {
    message.ack();
    return;
  }
  const now = Math.floor(Date.now() / 1_000);
  if (record.nextAttemptAt !== null && record.nextAttemptAt > now) {
    message.retry({ delaySeconds: Math.max(1, record.nextAttemptAt - now) });
    return;
  }
  const leaseToken = crypto.randomUUID();
  const claim = await env.DB.prepare(
    `UPDATE card_delivery_state SET lease_token = ?, lease_until = ?, last_attempt_at = ?, updated_at = ?
       WHERE task_id = ? AND accepted_revision < desired_revision
         AND (lease_token IS NULL OR lease_until <= ?)
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
  )
    .bind(leaseToken, now + 60, now, now, record.taskId, now, now)
    .run();
  if (!claim.meta.changes) {
    message.retry({ delaySeconds: 15 });
    return;
  }
  record = await deliveryRecord(env.DB, message.body.taskId);
  if (!record) {
    message.retry({ delaySeconds: 60 });
    return;
  }
  const providerMessageId = await revisionMessageIdFor(record.taskId, record.desiredRevision);
  const attempt = record.failureCount + 1;
  const startedAtMs = Date.now();
  try {
    const result = await sender(env, {
      cardId: record.cardId,
      messageId: providerMessageId,
      title: record.title,
      summary: record.title,
      result: record.result,
      content: record.content,
      source: record.source,
      displayAt: record.displayAt,
    });
    const completedAt = Math.floor(Date.now() / 1_000);
    const accepted = await env.DB.prepare(
      `UPDATE card_delivery_state SET accepted_revision = ?, lease_token = NULL,
           lease_until = NULL, next_attempt_at = NULL, failure_count = 0, last_error = NULL,
           last_provider_code = ?, last_provider_description = ?, updated_at = ?
         WHERE task_id = ? AND lease_token = ? AND desired_revision = ?`,
    )
      .bind(
        record.desiredRevision,
        result.code,
        result.description,
        completedAt,
        record.taskId,
        leaseToken,
        record.desiredRevision,
      )
      .run();
    if (accepted.meta.changes) {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE tasks_v3 SET delivered_revision = MAX(delivered_revision, ?) WHERE id = ?",
        ).bind(record.desiredRevision, record.taskId),
        env.DB.prepare(
          `UPDATE outbox SET state = 'enqueued', completed_at = ?, last_error = NULL, updated_at = ?
           WHERE task_id = ? AND target_revision <= ? AND state != 'shadowed'`,
        ).bind(completedAt, completedAt, record.taskId, record.desiredRevision),
      ]);
    }
    await recordAttempt(
      env.DB,
      record,
      providerMessageId,
      attempt,
      accepted.meta.changes ? "delivered" : "accepted_after_lease_lost",
      startedAtMs,
      undefined,
      result,
    );
    message.ack();
  } catch (error) {
    const retrying = error instanceof HuaweiPushError ? error.retryable : true;
    const delay = retryDelay(attempt);
    await releaseLease(env.DB, record, leaseToken, error, retrying, delay);
    await recordAttempt(
      env.DB,
      record,
      providerMessageId,
      attempt,
      retrying ? "retry" : "failed",
      startedAtMs,
      error,
    );
    if (retrying) message.retry({ delaySeconds: delay });
    else message.ack();
  }
}

async function getAgentDeliveryModeForTask(
  db: D1Database,
  taskId: string,
): Promise<"shadow" | "v3"> {
  const agentId = await db
    .prepare("SELECT agent_id FROM tasks_v3 WHERE id = ?")
    .bind(taskId)
    .first<string>("agent_id");
  return agentId ? getAgentDeliveryMode(db, agentId) : "shadow";
}

export async function markV3DeadLetter(
  message: Message<V3DeliveryMessage>,
  env: Env,
): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  const record = await deliveryRecord(env.DB, message.body.taskId);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE outbox SET state = 'failed', last_error = 'Retry limit exhausted',
           completed_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(now, now, message.body.outboxId),
    env.DB.prepare(
      `UPDATE card_delivery_state SET lease_token = NULL, lease_until = NULL,
           last_error = 'Retry limit exhausted', updated_at = ? WHERE task_id = ?`,
    ).bind(now, message.body.taskId),
  ]);
  if (record) {
    await recordAttempt(
      env.DB,
      record,
      await revisionMessageIdFor(record.taskId, record.desiredRevision),
      Math.max(record.failureCount + 1, message.attempts),
      "dead_letter",
      Date.now(),
      new Error("Retry limit exhausted"),
    );
  }
  message.ack();
}
