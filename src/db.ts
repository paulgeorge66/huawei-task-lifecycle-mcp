import type {
  AgentPolicy,
  AgentRecord,
  DeliveryStatus,
  EventRecord,
  TaskEventInput,
  TaskState,
} from "./types";
import { shadowWriteStatements, type ShadowWriteContext } from "./db-v3";

interface AgentRow {
  id: string;
  display_name: string;
  source_label: string;
  token_hint: string | null;
  active: number;
  notifications_enabled: number;
  notify_started: number;
  notify_progress: number;
  notify_completed: number;
  notify_failed: number;
  notify_canceled: number;
  minimum_duration_seconds: number;
  dedupe_window_seconds: number;
  include_full_content: number;
  max_content_length: number;
  muted_projects: string;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
}

interface EventRow {
  id: string;
  task_id: string;
  agent_id: string;
  state: TaskState;
  progress: number | null;
  project: string | null;
  title: string;
  summary: string;
  content: string;
  result: string;
  source: string;
  event_at: number;
  started_at: number | null;
  finished_at: number | null;
  fingerprint: string;
  delivery_status: DeliveryStatus;
  suppression_reason: string | null;
  attempts: number;
  huawei_code: string | null;
  huawei_description: string | null;
  last_error: string | null;
  queued_at: number | null;
  delivered_at: number | null;
  created_at: number;
  updated_at: number;
}

interface TaskRow {
  id: string;
  agent_id: string;
  project: string | null;
  title: string;
  state: TaskState;
  progress: number | null;
  started_at: number | null;
  finished_at: number | null;
  last_event_id: string;
  last_event_at: number;
  created_at: number;
  updated_at: number;
}

export interface TaskRecord {
  id: string;
  agentId: string;
  project: string | null;
  title: string;
  state: TaskState;
  progress: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  lastEventId: string;
  lastEventAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentPolicyUpdate {
  displayName?: string;
  sourceLabel?: string;
  active?: boolean;
  notificationsEnabled?: boolean;
  notifyStarted?: boolean;
  notifyProgress?: boolean;
  notifyCompleted?: boolean;
  notifyFailed?: boolean;
  notifyCanceled?: boolean;
  minimumDurationSeconds?: number;
  dedupeWindowSeconds?: number;
  includeFullContent?: boolean;
  maxContentLength?: number;
  mutedProjects?: string[];
}

export interface NewEventRecord {
  id: string;
  taskId: string;
  agentId: string;
  state: TaskState;
  progress: number | null;
  project: string | null;
  title: string;
  summary: string;
  content: string;
  result: string;
  source: string;
  eventAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  fingerprint: string;
  deliveryStatus: DeliveryStatus;
  suppressionReason: string | null;
  createdAt: number;
}

function booleanValue(value: number): boolean {
  return value === 1;
}

function parseMutedProjects(value: string): string[] {
  try {
    const decoded: unknown = JSON.parse(value);
    return Array.isArray(decoded)
      ? decoded.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function mapAgent(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    sourceLabel: row.source_label,
    tokenHint: row.token_hint,
    active: booleanValue(row.active),
    notificationsEnabled: booleanValue(row.notifications_enabled),
    notifyStarted: booleanValue(row.notify_started),
    notifyProgress: booleanValue(row.notify_progress),
    notifyCompleted: booleanValue(row.notify_completed),
    notifyFailed: booleanValue(row.notify_failed),
    notifyCanceled: booleanValue(row.notify_canceled),
    minimumDurationSeconds: row.minimum_duration_seconds,
    dedupeWindowSeconds: row.dedupe_window_seconds,
    includeFullContent: booleanValue(row.include_full_content),
    maxContentLength: row.max_content_length,
    mutedProjects: parseMutedProjects(row.muted_projects),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

function mapEvent(row: EventRow): EventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    state: row.state,
    progress: row.progress,
    project: row.project,
    title: row.title,
    summary: row.summary,
    content: row.content,
    result: row.result,
    source: row.source,
    eventAt: row.event_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    fingerprint: row.fingerprint,
    deliveryStatus: row.delivery_status,
    suppressionReason: row.suppression_reason,
    attempts: row.attempts,
    huaweiCode: row.huawei_code,
    huaweiDescription: row.huawei_description,
    lastError: row.last_error,
    queuedAt: row.queued_at,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    project: row.project,
    title: row.title,
    state: row.state,
    progress: row.progress,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    lastEventId: row.last_event_id,
    lastEventAt: row.last_event_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function ensureSystemAgent(
  db: D1Database,
  id: string,
  displayName: string,
  sourceLabel: string,
): Promise<AgentRecord> {
  const now = Math.floor(Date.now() / 1_000);
  await db
    .prepare(
      `INSERT INTO agents (id, display_name, source_label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(id, displayName, sourceLabel, now, now)
    .run();
  const record = await getAgentById(db, id);
  if (!record) throw new Error("Failed to load system agent");
  return record;
}

export async function createAgent(
  db: D1Database,
  input: {
    id: string;
    displayName: string;
    sourceLabel: string;
    tokenHash: string;
    tokenHint: string;
  },
): Promise<AgentRecord> {
  const now = Math.floor(Date.now() / 1_000);
  await db
    .prepare(
      `INSERT INTO agents
       (id, display_name, source_label, token_hash, token_hint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.displayName,
      input.sourceLabel,
      input.tokenHash,
      input.tokenHint,
      now,
      now,
    )
    .run();
  const record = await getAgentById(db, input.id);
  if (!record) throw new Error("Failed to load new agent");
  return record;
}

export async function getAgentById(db: D1Database, id: string): Promise<AgentRecord | null> {
  const row = await db.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first<AgentRow>();
  return row ? mapAgent(row) : null;
}

export async function getAgentByTokenHash(
  db: D1Database,
  tokenHash: string,
): Promise<AgentRecord | null> {
  const row = await db
    .prepare("SELECT * FROM agents WHERE token_hash = ? AND active = 1")
    .bind(tokenHash)
    .first<AgentRow>();
  return row ? mapAgent(row) : null;
}

export async function touchAgent(db: D1Database, id: string): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await db
    .prepare("UPDATE agents SET last_seen_at = ?, updated_at = ? WHERE id = ?")
    .bind(now, now, id)
    .run();
}

export async function listAgents(db: D1Database): Promise<AgentRecord[]> {
  const result = await db
    .prepare("SELECT * FROM agents ORDER BY active DESC, updated_at DESC LIMIT 200")
    .all<AgentRow>();
  return result.results.map(mapAgent);
}

export async function updateAgent(
  db: D1Database,
  id: string,
  update: AgentPolicyUpdate,
): Promise<AgentRecord | null> {
  const current = await getAgentById(db, id);
  if (!current) return null;
  const next = { ...current, ...update };
  const now = Math.floor(Date.now() / 1_000);
  await db
    .prepare(
      `UPDATE agents SET
         display_name = ?, source_label = ?, active = ?, notifications_enabled = ?,
         notify_started = ?, notify_progress = ?, notify_completed = ?, notify_failed = ?,
         notify_canceled = ?, minimum_duration_seconds = ?, dedupe_window_seconds = ?,
         include_full_content = ?, max_content_length = ?, muted_projects = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      next.displayName,
      next.sourceLabel,
      next.active ? 1 : 0,
      next.notificationsEnabled ? 1 : 0,
      next.notifyStarted ? 1 : 0,
      next.notifyProgress ? 1 : 0,
      next.notifyCompleted ? 1 : 0,
      next.notifyFailed ? 1 : 0,
      next.notifyCanceled ? 1 : 0,
      next.minimumDurationSeconds,
      next.dedupeWindowSeconds,
      next.includeFullContent ? 1 : 0,
      next.maxContentLength,
      JSON.stringify(next.mutedProjects),
      now,
      id,
    )
    .run();
  return getAgentById(db, id);
}

export async function setAgentToken(
  db: D1Database,
  id: string,
  tokenHash: string,
  tokenHint: string,
): Promise<AgentRecord | null> {
  const result = await db
    .prepare("UPDATE agents SET token_hash = ?, token_hint = ?, updated_at = ? WHERE id = ?")
    .bind(tokenHash, tokenHint, Math.floor(Date.now() / 1_000), id)
    .run();
  if (!result.meta.changes) return null;
  return getAgentById(db, id);
}

export async function getTask(
  db: D1Database,
  id: string,
  agentId: string,
): Promise<TaskRecord | null> {
  const row = await db
    .prepare("SELECT * FROM tasks WHERE id = ? AND agent_id = ?")
    .bind(id, agentId)
    .first<TaskRow>();
  return row ? mapTask(row) : null;
}

export async function hasRecentDuplicate(
  db: D1Database,
  agentId: string,
  fingerprint: string,
  afterTimestamp: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM events
       WHERE agent_id = ? AND fingerprint = ? AND created_at >= ?
         AND delivery_status IN ('pending', 'queued', 'delivering', 'retry_scheduled', 'delivered')
       LIMIT 1`,
    )
    .bind(agentId, fingerprint, afterTimestamp)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function createEvent(
  db: D1Database,
  event: NewEventRecord,
  shadow?: ShadowWriteContext,
): Promise<void> {
  const taskStartedAt =
    event.state === "started" ? (event.startedAt ?? event.eventAt) : event.startedAt;
  const taskFinishedAt = ["completed", "failed", "canceled"].includes(event.state)
    ? (event.finishedAt ?? event.eventAt)
    : event.finishedAt;
  const statements = [
    db
      .prepare(
        `INSERT INTO tasks
         (id, agent_id, project, title, state, progress, started_at, finished_at,
          last_event_id, last_event_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id, agent_id) DO UPDATE SET
           agent_id = excluded.agent_id,
           project = COALESCE(excluded.project, tasks.project),
           title = excluded.title,
           state = excluded.state,
           progress = COALESCE(excluded.progress, tasks.progress),
           started_at = COALESCE(tasks.started_at, excluded.started_at),
           finished_at = COALESCE(excluded.finished_at, tasks.finished_at),
           last_event_id = excluded.last_event_id,
           last_event_at = excluded.last_event_at,
           updated_at = excluded.updated_at
         WHERE excluded.last_event_at >= tasks.last_event_at`,
      )
      .bind(
        event.taskId,
        event.agentId,
        event.project,
        event.title,
        event.state,
        event.progress,
        taskStartedAt,
        taskFinishedAt,
        event.id,
        event.eventAt,
        event.createdAt,
        event.createdAt,
      ),
    db
      .prepare(
        `INSERT INTO events
         (id, task_id, agent_id, state, progress, project, title, summary, content, result,
          source, event_at, started_at, finished_at, fingerprint, delivery_status,
          suppression_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.id,
        event.taskId,
        event.agentId,
        event.state,
        event.progress,
        event.project,
        event.title,
        event.summary,
        event.content,
        event.result,
        event.source,
        event.eventAt,
        event.startedAt,
        event.finishedAt,
        event.fingerprint,
        event.deliveryStatus,
        event.suppressionReason,
        event.createdAt,
        event.createdAt,
      ),
  ];
  if (shadow) statements.push(...shadowWriteStatements(db, event, shadow));
  await db.batch(statements);
}

export async function getEvent(db: D1Database, id: string): Promise<EventRecord | null> {
  const row = await db.prepare("SELECT * FROM events WHERE id = ?").bind(id).first<EventRow>();
  return row ? mapEvent(row) : null;
}

export async function markEventQueued(db: D1Database, id: string): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await db
    .prepare(
      "UPDATE events SET delivery_status = 'queued', queued_at = ?, updated_at = ?, last_error = NULL WHERE id = ?",
    )
    .bind(now, now, id)
    .run();
}

export async function markEventSuppressed(
  db: D1Database,
  id: string,
  reason: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await db
    .prepare(
      `UPDATE events SET delivery_status = 'suppressed', suppression_reason = ?,
       updated_at = ? WHERE id = ? AND delivery_status != 'delivered'`,
    )
    .bind(reason.slice(0, 200), now, id)
    .run();
}

export async function markEventEnqueueFailed(
  db: D1Database,
  id: string,
  error: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await db
    .prepare(
      "UPDATE events SET delivery_status = 'enqueue_failed', last_error = ?, updated_at = ? WHERE id = ?",
    )
    .bind(error.slice(0, 1_000), now, id)
    .run();
}

export async function markEventDelivering(
  db: D1Database,
  id: string,
  attempts: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await db
    .prepare(
      "UPDATE events SET delivery_status = 'delivering', attempts = ?, updated_at = ? WHERE id = ?",
    )
    .bind(attempts, now, id)
    .run();
}

export async function markEventDelivered(
  db: D1Database,
  id: string,
  attempts: number,
  code: string | null,
  description: string | null,
): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await db
    .prepare(
      `UPDATE events SET delivery_status = 'delivered', attempts = ?, huawei_code = ?,
       huawei_description = ?, last_error = NULL, delivered_at = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(attempts, code, description, now, now, id)
    .run();
}

export async function markEventFailed(
  db: D1Database,
  id: string,
  attempts: number,
  error: string,
  retrying: boolean,
  code: string | null,
  description: string | null,
): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await db
    .prepare(
      `UPDATE events SET delivery_status = ?, attempts = ?, huawei_code = ?,
       huawei_description = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(
      retrying ? "retry_scheduled" : "failed",
      attempts,
      code,
      description,
      error.slice(0, 1_000),
      now,
      id,
    )
    .run();
}

export async function recordAttempt(
  db: D1Database,
  input: {
    eventId: string;
    queueMessageId: string | null;
    attemptNumber: number;
    outcome: "started" | "delivered" | "retry" | "failed" | "dead_letter";
    httpStatus?: number | null;
    huaweiCode?: string | null;
    description?: string | null;
    error?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO delivery_attempts
       (event_id, queue_message_id, attempt_number, outcome, http_status, huawei_code,
        description, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.eventId,
      input.queueMessageId,
      input.attemptNumber,
      input.outcome,
      input.httpStatus ?? null,
      input.huaweiCode ?? null,
      input.description ?? null,
      input.error?.slice(0, 1_000) ?? null,
      Math.floor(Date.now() / 1_000),
    )
    .run();
}

export async function resetEventForRetry(db: D1Database, id: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1_000);
  const result = await db
    .prepare(
      `UPDATE events SET delivery_status = 'pending', attempts = 0, last_error = NULL,
       huawei_code = NULL, huawei_description = NULL, delivered_at = NULL, updated_at = ?
       WHERE id = ? AND delivery_status IN ('failed', 'enqueue_failed')`,
    )
    .bind(now, id)
    .run();
  return result.meta.changes > 0;
}

export async function listEvents(
  db: D1Database,
  input: { limit: number; offset: number; status?: DeliveryStatus; agentId?: string },
): Promise<{ total: number; items: EventRecord[] }> {
  const conditions: string[] = [];
  const values: Array<string | number> = [];
  if (input.status) {
    conditions.push("delivery_status = ?");
    values.push(input.status);
  }
  if (input.agentId) {
    conditions.push("agent_id = ?");
    values.push(input.agentId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const results = await db.batch([
    db.prepare(`SELECT COUNT(*) AS total FROM events ${where}`).bind(...values),
    db
      .prepare(`SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(...values, input.limit, input.offset),
  ]);
  const countResult = results[0] as D1Result<{ total: number }>;
  const rowsResult = results[1] as D1Result<EventRow>;
  return {
    total: countResult.results[0]?.total ?? 0,
    items: rowsResult.results.map(mapEvent),
  };
}

export async function getDashboardSummary(db: D1Database): Promise<Record<string, number>> {
  const [agents, activeTasks, queued, delivered, failed, suppressed] = await db.batch([
    db.prepare("SELECT COUNT(*) AS count FROM agents WHERE active = 1"),
    db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE state IN ('started', 'progress')"),
    db.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE delivery_status IN ('pending', 'queued', 'delivering', 'retry_scheduled')",
    ),
    db.prepare("SELECT COUNT(*) AS count FROM events WHERE delivery_status = 'delivered'"),
    db.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE delivery_status IN ('failed', 'enqueue_failed')",
    ),
    db.prepare("SELECT COUNT(*) AS count FROM events WHERE delivery_status = 'suppressed'"),
  ]);
  const count = (result: D1Result): number => {
    const row = result.results[0] as { count?: unknown } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
  };
  return {
    agents: count(agents!),
    active_tasks: count(activeTasks!),
    queued: count(queued!),
    delivered: count(delivered!),
    failed: count(failed!),
    suppressed: count(suppressed!),
  };
}

export async function recordAdminAudit(
  db: D1Database,
  action: string,
  targetId: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db
    .prepare("INSERT INTO admin_audit (action, target_id, detail, created_at) VALUES (?, ?, ?, ?)")
    .bind(action, targetId, JSON.stringify(detail), Math.floor(Date.now() / 1_000))
    .run();
}

export function defaultResultForState(state: TaskState): string {
  const labels: Record<TaskState, string> = {
    started: "任务已开始",
    progress: "任务进行中",
    completed: "任务已完成",
    failed: "任务失败",
    canceled: "任务已取消",
  };
  return labels[state];
}

export function defaultSummaryForEvent(input: TaskEventInput): string {
  if (input.state === "progress" && input.progress !== undefined) {
    return `${input.title}进行中（${input.progress}%）`;
  }
  return `${input.title}：${defaultResultForState(input.state)}`;
}

export function policyForState(policy: AgentPolicy, state: TaskState): boolean {
  const mapping: Record<TaskState, boolean> = {
    started: policy.notifyStarted,
    progress: policy.notifyProgress,
    completed: policy.notifyCompleted,
    failed: policy.notifyFailed,
    canceled: policy.notifyCanceled,
  };
  return mapping[state];
}
