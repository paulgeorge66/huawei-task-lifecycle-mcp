import type { NewEventRecord } from "./db";
import type { AgentRecord, TaskState } from "./types";

export const V3_EVENT_TYPES = [
  "task.started",
  "task.progress",
  "task.waiting",
  "task.completed",
  "task.failed",
  "task.canceled",
  "turn.completed",
  "task.renamed",
] as const;

export type V3EventType = (typeof V3_EVENT_TYPES)[number];

export interface ShadowWriteContext {
  agent: AgentRecord;
  eventType: V3EventType;
  requestHash: string;
  internalTaskId: string;
  cardId: string;
  runId: string;
  outboxId: string;
  payloadJson: string;
  contentHash: string;
  projectionResult: string;
  policySuppressionReason: string | null;
  deliveryEnabled: boolean;
  externalRunId: string;
  ingress: string;
  traceId: string;
}

export type AgentDeliveryMode = "shadow" | "v3";

export interface V3DeliveryRecord {
  outboxId: string;
  taskId: string;
  agentId: string;
  externalTaskId: string;
  cardId: string;
  targetRevision: number;
  desiredRevision: number;
  acceptedRevision: number;
  leaseToken: string | null;
  leaseUntil: number | null;
  nextAttemptAt: number | null;
  failureCount: number;
  title: string;
  result: string;
  content: string;
  source: string;
  displayAt: number;
}

export interface ShadowEventIdentity {
  requestHash: string;
  disposition: "applied" | "observed" | "suppressed" | "stale";
  revision: number;
}

export interface ShadowDiffRecord {
  kind: "task_projection" | "event_outbox";
  agentId: string;
  taskId: string;
  eventId: string | null;
  revision: number;
  legacyValue: string;
  shadowValue: string;
  reason: string;
}

export interface V3DeliveryTimelineRecord {
  taskId: string;
  externalTaskId: string;
  agentId: string;
  title: string;
  desiredRevision: number;
  acceptedRevision: number;
  revisionLag: number;
  failureCount: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  providerCode: string | null;
  lastAttemptAt: number | null;
  deliveryMode: AgentDeliveryMode;
}

export interface V3EventDeliveryStatus {
  revision: number;
  desiredRevision: number;
  acceptedRevision: number;
  revisionLag: number;
  outboxState: string | null;
  failureCount: number;
  lastError: string | null;
  providerCode: string | null;
  providerDescription: string | null;
}

export async function recordCredential(
  db: D1Database,
  agent: AgentRecord,
  input: { kind: "token"; secretHash: string; hint: string } | { kind: "oauth"; clientId: string },
): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  const identity = input.kind === "token" ? input.secretHash.slice(0, 32) : input.clientId;
  const credentialId = `credential:${input.kind}:${agent.id}:${identity}`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO agents_v3
         (id, display_name, source_label, active, policy_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           source_label = excluded.source_label,
           active = excluded.active,
           policy_json = excluded.policy_json,
           updated_at = excluded.updated_at`,
      )
      .bind(
        agent.id,
        agent.displayName,
        agent.sourceLabel,
        agent.active ? 1 : 0,
        policyJson(agent),
        agent.createdAt,
        now,
      ),
    db
      .prepare(
        `UPDATE credentials SET active = 0, revoked_at = ?
         WHERE agent_id = ? AND kind = ? AND active = 1 AND id != ?`,
      )
      .bind(now, agent.id, input.kind, credentialId),
    db
      .prepare(
        `INSERT INTO credentials
         (id, agent_id, kind, secret_hash, hint, oauth_client_id, scopes, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '["push:write"]', 1, ?)
         ON CONFLICT(id) DO UPDATE SET
           active = 1, revoked_at = NULL, expires_at = NULL,
           hint = excluded.hint, last_used_at = credentials.last_used_at`,
      )
      .bind(
        credentialId,
        agent.id,
        input.kind,
        input.kind === "token" ? input.secretHash : null,
        input.kind === "token" ? input.hint : null,
        input.kind === "oauth" ? input.clientId : null,
        now,
      ),
  ]);
}

export async function touchCredential(db: D1Database, secretHash: string): Promise<void> {
  await db
    .prepare(
      `UPDATE credentials SET last_used_at = ?
       WHERE kind = 'token' AND secret_hash = ? AND active = 1`,
    )
    .bind(Math.floor(Date.now() / 1_000), secretHash)
    .run();
}

export function v3EventTypeForState(state: TaskState): V3EventType {
  return `task.${state}` as V3EventType;
}

function v3StateForEvent(eventType: V3EventType): string {
  const mapping: Partial<Record<V3EventType, string>> = {
    "task.started": "running",
    "task.progress": "running",
    "task.waiting": "waiting",
    "task.completed": "completed",
    "task.failed": "failed",
    "task.canceled": "canceled",
  };
  return mapping[eventType] ?? "running";
}

function policyJson(agent: AgentRecord): string {
  return JSON.stringify({
    notificationsEnabled: agent.notificationsEnabled,
    notifyStarted: agent.notifyStarted,
    notifyProgress: agent.notifyProgress,
    notifyCompleted: agent.notifyCompleted,
    notifyFailed: agent.notifyFailed,
    notifyCanceled: agent.notifyCanceled,
    minimumDurationSeconds: agent.minimumDurationSeconds,
    dedupeWindowSeconds: agent.dedupeWindowSeconds,
    includeFullContent: agent.includeFullContent,
    maxContentLength: agent.maxContentLength,
    mutedProjects: agent.mutedProjects,
  });
}

export function shadowWriteStatements(
  db: D1Database,
  event: NewEventRecord,
  context: ShadowWriteContext,
): D1PreparedStatement[] {
  const dispositionLookup = `(SELECT disposition FROM events_v3 WHERE agent_id = ? AND id = ?)`;
  const suppressionLookup = `(SELECT suppression_reason FROM events_v3 WHERE agent_id = ? AND id = ?)`;
  const state = v3StateForEvent(context.eventType);
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO agents_v3
         (id, display_name, source_label, active, policy_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           source_label = excluded.source_label,
           active = excluded.active,
           policy_json = excluded.policy_json,
           updated_at = excluded.updated_at`,
      )
      .bind(
        context.agent.id,
        context.agent.displayName,
        context.agent.sourceLabel,
        context.agent.active ? 1 : 0,
        policyJson(context.agent),
        context.agent.createdAt,
        event.createdAt,
      ),
    db
      .prepare(
        `INSERT INTO tasks_v3
         (id, agent_id, external_task_id, card_id, title, state, revision,
          delivered_revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'new', 0, 0, ?, ?)
         ON CONFLICT(agent_id, external_task_id) DO NOTHING`,
      )
      .bind(
        context.internalTaskId,
        event.agentId,
        event.taskId,
        context.cardId,
        event.title,
        event.createdAt,
        event.createdAt,
      ),
  ];

  if (context.eventType.startsWith("task.") && context.eventType !== "task.renamed") {
    statements.push(
      db
        .prepare(
          `INSERT INTO task_runs
           (id, task_id, external_run_id, state, terminal_event_id, started_at,
            finished_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          context.runId,
          context.internalTaskId,
          context.externalRunId,
          state,
          ["completed", "failed", "canceled"].includes(event.state) ? event.id : null,
          event.startedAt ?? event.eventAt,
          event.finishedAt,
          event.createdAt,
          event.createdAt,
        ),
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO events_v3
         (id, agent_id, task_id, run_id, event_type, request_hash, observed_at,
          received_at, revision, payload_json, disposition, suppression_reason,
          trace_id, ingress)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, revision + 1, ?,
           CASE
             WHEN ? = 'turn.completed' THEN 'observed'
             WHEN ? = 'task.renamed' THEN 'observed'
             WHEN ? = 'task.started' AND ? != 'legacy'
               AND (current_run_id IS NULL OR current_run_id != ?) THEN 'applied'
             WHEN state IN ('completed', 'failed', 'canceled') THEN 'stale'
             ELSE 'applied'
           END,
           ?, ?, ?
         FROM tasks_v3 WHERE id = ?`,
      )
      .bind(
        event.id,
        event.agentId,
        context.internalTaskId,
        context.eventType === "turn.completed" ? null : context.runId,
        context.eventType,
        context.requestHash,
        event.eventAt,
        event.createdAt,
        context.payloadJson,
        context.eventType,
        context.eventType,
        context.eventType,
        context.externalRunId,
        context.runId,
        context.policySuppressionReason,
        context.traceId,
        context.ingress,
        context.internalTaskId,
      ),
    db
      .prepare(
        `UPDATE tasks_v3 SET
           revision = revision + 1,
           title = CASE WHEN ${dispositionLookup} IN ('applied', 'observed') THEN ? ELSE title END,
           state = CASE
             WHEN ${dispositionLookup} != 'applied' THEN state
             WHEN ? IN ('task.started', 'task.progress') THEN 'running'
             WHEN ? = 'task.waiting' THEN 'waiting'
             WHEN ? = 'task.completed' THEN 'completed'
             WHEN ? = 'task.failed' THEN 'failed'
             WHEN ? = 'task.canceled' THEN 'canceled'
             ELSE state
           END,
           current_run_id = CASE
             WHEN ${dispositionLookup} = 'applied' AND ? = 'task.started' THEN ?
             WHEN ${dispositionLookup} = 'applied' AND ? != 'turn.completed'
             THEN COALESCE(current_run_id, ?)
             ELSE current_run_id
           END,
           updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        event.agentId,
        event.id,
        event.title,
        event.agentId,
        event.id,
        context.eventType,
        context.eventType,
        context.eventType,
        context.eventType,
        context.eventType,
        event.agentId,
        event.id,
        context.eventType,
        context.runId,
        event.agentId,
        event.id,
        context.eventType,
        context.runId,
        event.createdAt,
        context.internalTaskId,
      ),
  );

  if (context.eventType.startsWith("task.") && context.eventType !== "task.renamed") {
    statements.push(
      db
        .prepare(
          `UPDATE task_runs SET
             state = ?,
             terminal_event_id = CASE WHEN ? IN ('completed', 'failed', 'canceled') THEN ? ELSE terminal_event_id END,
             started_at = COALESCE(started_at, ?),
             finished_at = CASE WHEN ? IN ('completed', 'failed', 'canceled') THEN ? ELSE finished_at END,
             updated_at = ?
           WHERE id = ? AND ${dispositionLookup} = 'applied'`,
        )
        .bind(
          state,
          event.state,
          event.id,
          event.startedAt ?? event.eventAt,
          event.state,
          event.finishedAt,
          event.createdAt,
          context.runId,
          event.agentId,
          event.id,
        ),
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO card_projections
         (task_id, revision, title, result, content, source, display_at, content_hash, created_at)
         SELECT ?, revision, ?, ?, ?, ?, ?, ?, ?
         FROM tasks_v3
         WHERE id = ?
           AND ${dispositionLookup} IN ('applied', 'observed')`,
      )
      .bind(
        context.internalTaskId,
        event.title,
        context.projectionResult,
        event.content,
        event.source,
        event.eventAt,
        context.contentHash,
        event.createdAt,
        context.internalTaskId,
        event.agentId,
        event.id,
      ),
    db
      .prepare(
        `INSERT INTO outbox
         (id, task_id, target_revision, state, available_at, enqueue_attempts,
          last_error, created_at, updated_at)
         SELECT ?, ?, revision, ?, ?, 0, NULL, ?, ?
         FROM tasks_v3
         WHERE id = ?
           AND ${dispositionLookup} IN ('applied', 'observed')
           AND ${suppressionLookup} IS NULL`,
      )
      .bind(
        context.outboxId,
        context.internalTaskId,
        context.deliveryEnabled ? "pending" : "shadowed",
        event.createdAt,
        event.createdAt,
        event.createdAt,
        context.internalTaskId,
        event.agentId,
        event.id,
        event.agentId,
        event.id,
      ),
    db
      .prepare(
        `INSERT INTO card_delivery_state
         (task_id, desired_revision, accepted_revision, failure_count, updated_at)
         SELECT id, revision, 0, 0, ? FROM tasks_v3
         WHERE id = ?
           AND ${dispositionLookup} IN ('applied', 'observed')
           AND ${suppressionLookup} IS NULL
         ON CONFLICT(task_id) DO UPDATE SET
           desired_revision = excluded.desired_revision,
           updated_at = excluded.updated_at`,
      )
      .bind(
        event.createdAt,
        context.internalTaskId,
        event.agentId,
        event.id,
        event.agentId,
        event.id,
      ),
  );

  return statements;
}

export async function getAgentDeliveryMode(
  db: D1Database,
  agentId: string,
): Promise<AgentDeliveryMode> {
  const value = await db
    .prepare("SELECT delivery_mode FROM agents_v3 WHERE id = ?")
    .bind(agentId)
    .first<string>("delivery_mode");
  return value === "v3" ? "v3" : "shadow";
}

export async function setAgentDeliveryMode(
  db: D1Database,
  agentId: string,
  mode: AgentDeliveryMode,
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE agents_v3 SET delivery_mode = ?, updated_at = ? WHERE id = ?")
    .bind(mode, Math.floor(Date.now() / 1_000), agentId)
    .run();
  return Boolean(result.meta.changes);
}

export async function listAgentDeliveryModes(
  db: D1Database,
): Promise<Record<string, AgentDeliveryMode>> {
  const rows = await db
    .prepare("SELECT id, delivery_mode AS mode FROM agents_v3")
    .all<{ id: string; mode: AgentDeliveryMode }>();
  return Object.fromEntries(rows.results.map((row) => [row.id, row.mode]));
}

export async function claimPendingOutbox(
  db: D1Database,
  now: number,
  limit: number,
): Promise<Array<{ outboxId: string; taskId: string; targetRevision: number }>> {
  const candidates = await db
    .prepare(
      `SELECT box.id AS outboxId, box.task_id AS taskId, box.target_revision AS targetRevision
       FROM outbox box
       JOIN tasks_v3 task ON task.id = box.task_id
       JOIN agents_v3 agent ON agent.id = task.agent_id
       WHERE agent.delivery_mode = 'v3'
         AND box.available_at <= ?
         AND (box.state = 'pending' OR (box.state = 'enqueuing' AND box.updated_at <= ?))
       ORDER BY box.available_at, box.created_at LIMIT ?`,
    )
    .bind(now, now - 60, limit)
    .all<{ outboxId: string; taskId: string; targetRevision: number }>();
  const claimed = [];
  for (const candidate of candidates.results) {
    const result = await db
      .prepare(
        `UPDATE outbox SET state = 'enqueuing', enqueue_attempts = enqueue_attempts + 1,
           last_error = NULL, updated_at = ?
         WHERE id = ? AND (state = 'pending' OR (state = 'enqueuing' AND updated_at <= ?))`,
      )
      .bind(now, candidate.outboxId, now - 60)
      .run();
    if (result.meta.changes) claimed.push(candidate);
  }
  return claimed;
}

export async function markOutboxEnqueued(
  db: D1Database,
  outboxId: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE outbox SET state = 'enqueued', enqueued_at = ?, updated_at = ?
       WHERE id = ? AND state = 'enqueuing'`,
    )
    .bind(now, now, outboxId)
    .run();
}

export async function markOutboxEnqueueFailed(
  db: D1Database,
  outboxId: string,
  error: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE outbox SET state = 'pending', available_at = ?, last_error = ?, updated_at = ?
       WHERE id = ? AND state = 'enqueuing'`,
    )
    .bind(now + 30, error.slice(0, 1_000), now, outboxId)
    .run();
}

export async function getShadowEventIdentity(
  db: D1Database,
  agentId: string,
  eventId: string,
): Promise<ShadowEventIdentity | null> {
  const row = await db
    .prepare(
      `SELECT request_hash AS requestHash, disposition, revision
       FROM events_v3 WHERE agent_id = ? AND id = ?`,
    )
    .bind(agentId, eventId)
    .first<ShadowEventIdentity>();
  return row ?? null;
}

export async function getShadowSummary(db: D1Database): Promise<Record<string, number>> {
  const results = await db.batch([
    db.prepare("SELECT COUNT(*) AS count FROM tasks_v3"),
    db.prepare("SELECT COUNT(*) AS count FROM events_v3"),
    db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE state = 'shadowed'"),
    db.prepare("SELECT COUNT(*) AS count FROM events_v3 WHERE disposition = 'stale'"),
    db.prepare("SELECT COUNT(*) AS count FROM events_v3 WHERE suppression_reason IS NOT NULL"),
    db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE state = 'pending'"),
    db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE state = 'failed'"),
    db.prepare(
      `SELECT COALESCE(SUM(state.desired_revision - state.accepted_revision), 0) AS count
       FROM card_delivery_state state
       JOIN tasks_v3 task ON task.id = state.task_id
       JOIN agents_v3 agent ON agent.id = task.agent_id
       WHERE agent.delivery_mode = 'v3'
         AND EXISTS (
           SELECT 1 FROM outbox box
           WHERE box.task_id = task.id AND box.state != 'shadowed'
         )`,
    ),
    db.prepare(
      `SELECT COUNT(*) AS count
       FROM events_v3 event
       LEFT JOIN outbox box
         ON box.task_id = event.task_id AND box.target_revision = event.revision
       WHERE ((event.disposition IN ('applied', 'observed') AND event.suppression_reason IS NULL)
              != (box.id IS NOT NULL))`,
    ),
    db.prepare(
      `SELECT COUNT(*) AS count
       FROM tasks_v3 v3
       JOIN tasks legacy ON legacy.agent_id = v3.agent_id AND legacy.id = v3.external_task_id
       WHERE EXISTS (
         SELECT 1 FROM events_v3 event
         WHERE event.task_id = v3.id AND event.event_type LIKE 'task.%'
       ) AND ((CASE
         WHEN legacy.state IN ('started', 'progress') THEN 'running'
         ELSE legacy.state
       END) != v3.state OR legacy.title != v3.title)`,
    ),
  ]);
  const count = (result: D1Result | undefined): number => {
    const row = result?.results[0] as { count?: unknown } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
  };
  return {
    tasks: count(results[0]),
    events: count(results[1]),
    outbox_shadowed: count(results[2]),
    stale_events: count(results[3]),
    suppressed_events: count(results[4]),
    outbox_pending: count(results[5]),
    outbox_failed: count(results[6]),
    revision_lag: count(results[7]),
    event_outbox_mismatches: count(results[8]),
    projection_mismatches: count(results[9]),
  };
}

export async function listV3DeliveryTimeline(
  db: D1Database,
  limit: number,
): Promise<V3DeliveryTimelineRecord[]> {
  const rows = await db
    .prepare(
      `SELECT task.id AS taskId, task.external_task_id AS externalTaskId,
         task.agent_id AS agentId, task.title, state.desired_revision AS desiredRevision,
         state.accepted_revision AS acceptedRevision,
         state.desired_revision - state.accepted_revision AS revisionLag,
         state.failure_count AS failureCount, state.next_attempt_at AS nextAttemptAt,
         state.last_error AS lastError, state.last_provider_code AS providerCode,
         state.last_attempt_at AS lastAttemptAt, agent.delivery_mode AS deliveryMode
       FROM card_delivery_state state
       JOIN tasks_v3 task ON task.id = state.task_id
       JOIN agents_v3 agent ON agent.id = task.agent_id
       ORDER BY state.updated_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<V3DeliveryTimelineRecord>();
  return rows.results;
}

export async function getV3EventDeliveryStatus(
  db: D1Database,
  agentId: string,
  eventId: string,
): Promise<V3EventDeliveryStatus | null> {
  const row = await db
    .prepare(
      `SELECT event.revision, state.desired_revision AS desiredRevision,
         state.accepted_revision AS acceptedRevision,
         state.desired_revision - state.accepted_revision AS revisionLag,
         box.state AS outboxState, state.failure_count AS failureCount,
         state.last_error AS lastError, state.last_provider_code AS providerCode,
         state.last_provider_description AS providerDescription
       FROM events_v3 event
       JOIN card_delivery_state state ON state.task_id = event.task_id
       LEFT JOIN outbox box
         ON box.task_id = event.task_id AND box.target_revision = event.revision
       WHERE event.agent_id = ? AND event.id = ?`,
    )
    .bind(agentId, eventId)
    .first<V3EventDeliveryStatus>();
  return row ?? null;
}

export async function listV3EventDeliveryStatuses(
  db: D1Database,
  agentId: string,
  eventIds: string[],
): Promise<Record<string, V3EventDeliveryStatus>> {
  if (!eventIds.length) return {};
  const placeholders = eventIds.map(() => "?").join(", ");
  const rows = await db
    .prepare(
      `SELECT event.id AS eventId, event.revision,
         state.desired_revision AS desiredRevision,
         state.accepted_revision AS acceptedRevision,
         state.desired_revision - state.accepted_revision AS revisionLag,
         box.state AS outboxState, state.failure_count AS failureCount,
         state.last_error AS lastError, state.last_provider_code AS providerCode,
         state.last_provider_description AS providerDescription
       FROM events_v3 event
       JOIN card_delivery_state state ON state.task_id = event.task_id
       LEFT JOIN outbox box
         ON box.task_id = event.task_id AND box.target_revision = event.revision
       WHERE event.agent_id = ? AND event.id IN (${placeholders})`,
    )
    .bind(agentId, ...eventIds)
    .all<V3EventDeliveryStatus & { eventId: string }>();
  return Object.fromEntries(rows.results.map(({ eventId, ...status }) => [eventId, status]));
}

export async function retryV3EventDelivery(
  db: D1Database,
  agentId: string,
  eventId: string,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1_000);
  const result = await db
    .prepare(
      `UPDATE outbox SET state = 'pending', available_at = ?, last_error = NULL,
         completed_at = NULL, updated_at = ?
       WHERE id = (
         SELECT box.id FROM outbox box
         JOIN events_v3 event
           ON event.task_id = box.task_id AND event.revision = box.target_revision
         WHERE event.agent_id = ? AND event.id = ?
       ) AND state = 'failed'`,
    )
    .bind(now, now, agentId, eventId)
    .run();
  if (!result.meta.changes) return false;
  await db
    .prepare(
      `UPDATE card_delivery_state SET next_attempt_at = NULL, failure_count = 0,
         last_error = NULL, lease_token = NULL, lease_until = NULL, updated_at = ?
       WHERE task_id = (SELECT task_id FROM events_v3 WHERE agent_id = ? AND id = ?)`,
    )
    .bind(now, agentId, eventId)
    .run();
  return true;
}

export async function listShadowDiffs(
  db: D1Database,
  limit: number,
  offset: number,
): Promise<{ total: number; items: ShadowDiffRecord[] }> {
  const query = `
    SELECT 'task_projection' AS kind, v3.agent_id AS agentId,
           v3.external_task_id AS taskId, NULL AS eventId, v3.revision AS revision,
           legacy.state || ' | ' || legacy.title AS legacyValue,
           v3.state || ' | ' || v3.title AS shadowValue,
           'state_or_title_mismatch' AS reason, v3.updated_at AS sortAt
    FROM tasks_v3 v3
    JOIN tasks legacy
      ON legacy.agent_id = v3.agent_id AND legacy.id = v3.external_task_id
    WHERE EXISTS (
      SELECT 1 FROM events_v3 event
      WHERE event.task_id = v3.id AND event.event_type LIKE 'task.%'
    ) AND ((CASE WHEN legacy.state IN ('started', 'progress') THEN 'running' ELSE legacy.state END)
            != v3.state OR legacy.title != v3.title)
    UNION ALL
    SELECT 'event_outbox' AS kind, event.agent_id AS agentId,
           task.external_task_id AS taskId, event.id AS eventId, event.revision AS revision,
           CASE
             WHEN event.disposition IN ('applied', 'observed') AND event.suppression_reason IS NULL
             THEN 'outbox expected' ELSE 'no outbox expected'
           END AS legacyValue,
           CASE WHEN box.id IS NULL THEN 'outbox missing' ELSE 'outbox present' END AS shadowValue,
           'event_outbox_mismatch' AS reason, event.received_at AS sortAt
    FROM events_v3 event
    JOIN tasks_v3 task ON task.id = event.task_id
    LEFT JOIN outbox box
      ON box.task_id = event.task_id AND box.target_revision = event.revision
    WHERE ((event.disposition IN ('applied', 'observed') AND event.suppression_reason IS NULL)
           != (box.id IS NOT NULL))`;
  const [countResult, rows] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS count FROM (${query})`),
    db
      .prepare(`SELECT * FROM (${query}) ORDER BY sortAt DESC LIMIT ? OFFSET ?`)
      .bind(limit, offset),
  ]);
  const countRow = countResult?.results[0] as { count?: unknown } | undefined;
  return {
    total: typeof countRow?.count === "number" ? countRow.count : 0,
    items: (rows?.results ?? []) as unknown as ShadowDiffRecord[],
  };
}
