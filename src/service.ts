import { constantTimeEqual, sha256Hex } from "./crypto";
import {
  createEvent,
  defaultResultForState,
  defaultSummaryForEvent,
  ensureSystemAgent,
  getAgentById,
  getAgentByTokenHash,
  getEvent,
  getTask,
  hasRecentDuplicate,
  markEventDelivered,
  markEventDelivering,
  markEventEnqueueFailed,
  markEventFailed,
  markEventQueued,
  markEventSuppressed,
  policyForState,
  recordAttempt,
  resetEventForRetry,
  touchAgent,
} from "./db";
import {
  getAgentDeliveryMode,
  getShadowEventIdentity,
  touchCredential,
  retryV3EventDelivery,
  v3EventTypeForState,
} from "./db-v3";
import {
  consumeV3Message,
  dispatchPendingOutbox,
  isV3DeliveryMessage,
  markV3DeadLetter,
} from "./delivery-v3";
import { cardIdFor } from "./identity";
import { HuaweiPushError, normalizeEscapedContent, pushEventToHuawei } from "./push";
import { deliveryQueueRole } from "./queue-role";
import {
  assertSubmissionAllowed,
  EventConflictError,
  type SubmissionOptions,
} from "./submission-policy";
import type {
  AgentRecord,
  AuthenticatedAgent,
  DeliveryMessage,
  EventRecord,
  SubmissionOutput,
  TaskEventInput,
} from "./types";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown delivery error";
}

export async function authenticateAgent(
  request: Request,
  env: Env,
): Promise<AuthenticatedAgent | null> {
  const token =
    request.headers
      .get("Authorization")
      ?.replace(/^Bearer\s+/iu, "")
      .trim() ?? "";
  if (!token) return null;
  if (await constantTimeEqual(token, env.CODEX_WEBHOOK_TOKEN)) {
    return {
      record: await ensureSystemAgent(env.DB, "codex-legacy", "Codex Legacy", "Codex"),
      legacy: true,
    };
  }
  const tokenHash = await sha256Hex(token);
  const record = await getAgentByTokenHash(env.DB, tokenHash);
  if (!record) return null;
  await Promise.all([touchAgent(env.DB, record.id), touchCredential(env.DB, tokenHash)]);
  return { record, legacy: false };
}

export async function ensureOAuthAgent(
  env: Env,
  agentId: string,
  clientName: string,
): Promise<AgentRecord> {
  return ensureSystemAgent(env.DB, agentId, clientName, `MCP:${clientName}`);
}

function policySuppression(
  agent: AgentRecord,
  input: TaskEventInput,
  startedAt: number | null,
  eventAt: number,
  bypassNotificationPolicy: boolean,
  notificationPolicyOverride?: "waiting",
): string | null {
  if (!agent.active) return "agent_disabled";
  if (bypassNotificationPolicy) return null;
  if (!agent.notificationsEnabled) return "notifications_disabled";
  if (!notificationPolicyOverride && !policyForState(agent, input.state))
    return `state_${input.state}_disabled`;
  if (
    input.project &&
    agent.mutedProjects.some((project) => project.toLowerCase() === input.project?.toLowerCase())
  ) {
    return "project_muted";
  }
  if (
    input.state === "completed" &&
    agent.minimumDurationSeconds > 0 &&
    startedAt !== null &&
    eventAt - startedAt < agent.minimumDurationSeconds
  ) {
    return "below_minimum_duration";
  }
  return null;
}

function submission(event: EventRecord, message?: string): SubmissionOutput {
  return {
    success: event.deliveryStatus !== "failed" && event.deliveryStatus !== "enqueue_failed",
    event_id: event.id,
    task_id: event.taskId,
    delivery_status: event.deliveryStatus,
    message:
      message ??
      (event.deliveryStatus === "suppressed"
        ? "事件已记录，按通知策略未推送"
        : "事件已进入可靠投递队列"),
    ...(event.suppressionReason ? { suppression_reason: event.suppressionReason } : {}),
  };
}

export async function submitTaskEvent(
  env: Env,
  agent: AgentRecord,
  input: TaskEventInput,
  options: SubmissionOptions = {},
): Promise<SubmissionOutput> {
  assertSubmissionAllowed(agent.active, input.force_notify);
  const bypassNotificationPolicy = options.bypassNotificationPolicy === true;
  const v3Delivery =
    String(env.V3_DELIVERY) === "true" && (await getAgentDeliveryMode(env.DB, agent.id)) === "v3";
  const eventId = input.event_id ?? crypto.randomUUID();
  const requestHash = await sha256Hex(
    JSON.stringify([
      agent.id,
      input.task_id,
      input.run_id ?? null,
      input.state,
      input.title,
      input.summary ?? null,
      input.content,
      input.result ?? null,
      input.project ?? null,
      input.progress ?? null,
      input.event_at ?? null,
      input.started_at ?? null,
      input.finished_at ?? null,
    ]),
  );
  const existing = await getEvent(env.DB, eventId);
  if (existing) {
    if (existing.agentId !== agent.id) throw new Error("event_id already belongs to another agent");
    const shadow = await getShadowEventIdentity(env.DB, agent.id, eventId);
    if (shadow && shadow.requestHash !== requestHash) throw new EventConflictError();
    return submission(existing, "幂等命中：该事件已存在");
  }

  const eventAt = input.event_at ?? Math.floor(Date.now() / 1_000);
  const task = await getTask(env.DB, input.task_id, agent.id);
  const startedAt =
    input.started_at ?? task?.startedAt ?? (input.state === "started" ? eventAt : null);
  const finishedAt = ["completed", "failed", "canceled"].includes(input.state)
    ? (input.finished_at ?? eventAt)
    : (input.finished_at ?? null);
  const fallbackContent = input.summary ?? defaultSummaryForEvent(input);
  const normalizedContent = normalizeEscapedContent(input.content) || fallbackContent;
  const fullContent = agent.includeFullContent ? normalizedContent : fallbackContent;
  const content = fullContent.slice(0, agent.maxContentLength);
  const fingerprint = await sha256Hex(
    JSON.stringify([
      agent.id,
      input.task_id,
      input.state,
      input.progress ?? null,
      input.title,
      input.summary ?? "",
      normalizedContent,
    ]),
  );
  let suppressionReason = policySuppression(
    agent,
    input,
    startedAt,
    eventAt,
    bypassNotificationPolicy,
    options.notificationPolicyOverride,
  );
  if (
    !suppressionReason &&
    !bypassNotificationPolicy &&
    agent.dedupeWindowSeconds > 0 &&
    (await hasRecentDuplicate(env.DB, agent.id, fingerprint, eventAt - agent.dedupeWindowSeconds))
  ) {
    suppressionReason = "duplicate_within_window";
  }

  const newEvent: Parameters<typeof createEvent>[1] = {
    id: eventId,
    taskId: input.task_id,
    agentId: agent.id,
    state: input.state,
    progress: input.progress ?? null,
    project: input.project ?? task?.project ?? null,
    title: input.title,
    summary: input.summary ?? defaultSummaryForEvent(input),
    content,
    result: input.result ?? defaultResultForState(input.state),
    source: agent.sourceLabel,
    eventAt,
    startedAt,
    finishedAt,
    fingerprint,
    deliveryStatus: suppressionReason || v3Delivery ? "suppressed" : "pending",
    suppressionReason: suppressionReason ?? (v3Delivery ? "v3_delivery_authoritative" : null),
    createdAt: Math.floor(Date.now() / 1_000),
  };
  const cardId = await cardIdFor(agent.id, input.task_id);
  const externalRunId = input.run_id ?? "legacy";
  const runId = `run:${(await sha256Hex(`${cardId}\0${externalRunId}`)).slice(0, 48)}`;
  const shadowEventType = options.shadowEventType ?? v3EventTypeForState(input.state);
  const traceId = options.traceId ?? crypto.randomUUID();
  try {
    await createEvent(
      env.DB,
      newEvent,
      env.V3_SHADOW_WRITE === "true"
        ? {
            agent,
            eventType: shadowEventType,
            requestHash,
            internalTaskId: cardId,
            cardId,
            runId,
            outboxId: `out:${(await sha256Hex(`${agent.id}\0${eventId}`)).slice(0, 48)}`,
            payloadJson: JSON.stringify(newEvent),
            contentHash: await sha256Hex(
              JSON.stringify([
                input.title,
                input.result ?? defaultResultForState(input.state),
                content,
              ]),
            ),
            projectionResult:
              shadowEventType === "turn.completed"
                ? "本轮已结束"
                : (input.result ?? defaultResultForState(input.state)),
            policySuppressionReason: suppressionReason,
            deliveryEnabled: v3Delivery,
            externalRunId,
            ingress: options.ingress ?? "legacy",
            traceId,
          }
        : undefined,
    );
  } catch (error) {
    const shadow = await getShadowEventIdentity(env.DB, agent.id, eventId);
    if (shadow && shadow.requestHash !== requestHash) throw new EventConflictError();
    const raced = await getEvent(env.DB, eventId);
    if (!raced || raced.agentId !== agent.id) throw error;
    return submission(raced, "幂等命中：该事件已存在");
  }

  if (!suppressionReason && v3Delivery) {
    await dispatchPendingOutbox(env);
  } else if (!suppressionReason) {
    try {
      await env.DELIVERY_QUEUE.send({ eventId } satisfies DeliveryMessage, {
        contentType: "json",
      });
      await markEventQueued(env.DB, eventId);
    } catch (error) {
      await markEventEnqueueFailed(env.DB, eventId, errorMessage(error));
    }
  }
  const created = await getEvent(env.DB, eventId);
  if (!created) throw new Error("Event was not persisted");
  return submission(
    created,
    v3Delivery && !suppressionReason ? "事件已由 v3 可靠投递链路接管" : undefined,
  );
}

export async function retryEvent(env: Env, eventId: string): Promise<EventRecord> {
  const current = await getEvent(env.DB, eventId);
  if (!current) throw new Error("Event not found");
  const agent = await getAgentById(env.DB, current.agentId);
  if (!agent?.active) throw new Error("Agent is disabled");
  if (
    current.suppressionReason === "v3_delivery_authoritative" &&
    (await retryV3EventDelivery(env.DB, current.agentId, eventId))
  ) {
    await dispatchPendingOutbox(env);
    return current;
  }
  if (!(await resetEventForRetry(env.DB, eventId))) {
    const existing = await getEvent(env.DB, eventId);
    if (!existing) throw new Error("Event not found");
    throw new Error(`Only failed events can be retried (current: ${existing.deliveryStatus})`);
  }
  try {
    await env.DELIVERY_QUEUE.send({ eventId } satisfies DeliveryMessage, { contentType: "json" });
    await markEventQueued(env.DB, eventId);
  } catch (error) {
    await markEventEnqueueFailed(env.DB, eventId, errorMessage(error));
    throw error;
  }
  const event = await getEvent(env.DB, eventId);
  if (!event) throw new Error("Event not found after retry");
  return event;
}

function retryDelay(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempt - 1), 43_200);
}

async function consumeMessage(message: Message<DeliveryMessage>, env: Env): Promise<void> {
  if (isV3DeliveryMessage(message.body)) {
    await consumeV3Message(message as Message<import("./types").V3DeliveryMessage>, env);
    return;
  }
  const event = await getEvent(env.DB, message.body.eventId);
  if (!event || ["suppressed", "delivered", "failed"].includes(event.deliveryStatus)) {
    message.ack();
    return;
  }
  const agent = await getAgentById(env.DB, event.agentId);
  if (!agent?.active) {
    await markEventSuppressed(env.DB, event.id, "agent_disabled_before_delivery");
    message.ack();
    return;
  }
  const task = await getTask(env.DB, event.taskId, event.agentId);
  if (task && task.lastEventId !== event.id && task.lastEventAt >= event.eventAt) {
    const newestEvent = await getEvent(env.DB, task.lastEventId);
    if (newestEvent && newestEvent.deliveryStatus !== "suppressed") {
      await markEventSuppressed(env.DB, event.id, "superseded_by_newer_event");
      message.ack();
      return;
    }
  }
  const attempt = message.attempts;
  await markEventDelivering(env.DB, event.id, attempt);
  await recordAttempt(env.DB, {
    eventId: event.id,
    queueMessageId: message.id,
    attemptNumber: attempt,
    outcome: "started",
  });
  try {
    const result = await pushEventToHuawei(env, event);
    await markEventDelivered(env.DB, event.id, attempt, result.code, result.description);
    await recordAttempt(env.DB, {
      eventId: event.id,
      queueMessageId: message.id,
      attemptNumber: attempt,
      outcome: "delivered",
      huaweiCode: result.code,
      description: result.description,
    });
    message.ack();
  } catch (error) {
    const huawei = error instanceof HuaweiPushError ? error : null;
    const retrying = huawei?.retryable ?? true;
    await markEventFailed(
      env.DB,
      event.id,
      attempt,
      errorMessage(error),
      retrying,
      huawei?.code ?? null,
      huawei?.description ?? null,
    );
    await recordAttempt(env.DB, {
      eventId: event.id,
      queueMessageId: message.id,
      attemptNumber: attempt,
      outcome: retrying ? "retry" : "failed",
      httpStatus: huawei?.httpStatus ?? null,
      huaweiCode: huawei?.code ?? null,
      description: huawei?.description ?? null,
      error: errorMessage(error),
    });
    if (retrying) message.retry({ delaySeconds: retryDelay(attempt) });
    else message.ack();
  }
}

async function consumeDeadLetter(message: Message<DeliveryMessage>, env: Env): Promise<void> {
  if (isV3DeliveryMessage(message.body)) {
    await markV3DeadLetter(message as Message<import("./types").V3DeliveryMessage>, env);
    return;
  }
  const event = await getEvent(env.DB, message.body.eventId);
  if (event && event.deliveryStatus !== "delivered") {
    const attempt = Math.max(event.attempts, message.attempts);
    await markEventFailed(
      env.DB,
      event.id,
      attempt,
      event.lastError ?? "Retry limit exhausted",
      false,
      event.huaweiCode,
      event.huaweiDescription,
    );
    await recordAttempt(env.DB, {
      eventId: event.id,
      queueMessageId: message.id,
      attemptNumber: attempt,
      outcome: "dead_letter",
      error: event.lastError ?? "Retry limit exhausted",
    });
  }
  message.ack();
}

export async function consumeDeliveryBatch(
  batch: MessageBatch<DeliveryMessage>,
  env: Env,
): Promise<void> {
  const queueRole = deliveryQueueRole(batch.queue, {
    delivery: env.DELIVERY_QUEUE_NAME,
    deadLetter: env.DEAD_LETTER_QUEUE_NAME,
  });
  if (queueRole === "unknown") {
    console.error(JSON.stringify({ message: "unknown_queue", queue: batch.queue }));
    batch.retryAll({ delaySeconds: 60 });
    return;
  }
  for (const message of batch.messages) {
    try {
      if (queueRole === "dead-letter") await consumeDeadLetter(message, env);
      else await consumeMessage(message, env);
    } catch (error) {
      console.error(
        JSON.stringify({ message: "queue_consumer_failed", error: errorMessage(error) }),
      );
      message.retry({ delaySeconds: 60 });
    }
  }
}
