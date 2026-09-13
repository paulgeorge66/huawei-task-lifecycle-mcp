import { z } from "zod";

import {
  getAgentDeliveryMode,
  getShadowEventIdentity,
  getV3EventDeliveryStatus,
  V3_EVENT_TYPES,
  type V3EventType,
} from "./db-v3";
import { getTask } from "./db";
import { submitTaskEvent } from "./service";
import { taskEventInputSchema, type AgentRecord, type TaskEventInput } from "./types";

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u, "identifier contains unsupported characters");

export const v3EventInputSchema = z
  .object({
    task_id: identifier,
    run_id: identifier.optional(),
    event_id: identifier.optional(),
    type: z.enum(V3_EVENT_TYPES),
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(300).optional(),
    content: z.string().max(5_000).default(""),
    result: z.string().trim().min(1).max(100).optional(),
    project: z.string().trim().min(1).max(120).optional(),
    progress: z.number().int().min(0).max(100).optional(),
    observed_at: z.number().int().min(1_609_459_200).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.type === "task.progress" && value.progress === undefined) {
      context.addIssue({ code: "custom", path: ["progress"], message: "progress is required" });
    }
    if (
      value.observed_at !== undefined &&
      value.observed_at > Math.floor(Date.now() / 1_000) + 31_536_000
    ) {
      context.addIssue({
        code: "custom",
        path: ["observed_at"],
        message: "observed_at must not be more than one year in the future",
      });
    }
  });

export type V3EventInput = z.infer<typeof v3EventInputSchema>;

export interface V3SubmissionResponse {
  success: true;
  acceptance: "recorded";
  event_id: string;
  task_id: string;
  revision: number;
  disposition: string;
  delivery: string;
  trace_id: string;
}

export const v3SubmissionOutputSchema = z.object({
  success: z.literal(true),
  acceptance: z.literal("recorded"),
  event_id: z.string(),
  task_id: z.string(),
  revision: z.number().int().positive(),
  disposition: z.string(),
  delivery: z.string(),
  trace_id: z.string(),
});

function legacyState(
  eventType: V3EventType,
  current: Awaited<ReturnType<typeof getTask>>,
): TaskEventInput["state"] {
  if (eventType === "task.started") return "started";
  if (eventType === "task.progress" || eventType === "task.waiting") return "progress";
  if (eventType === "task.completed") return "completed";
  if (eventType === "task.failed") return "failed";
  if (eventType === "task.canceled") return "canceled";
  return current?.state ?? "started";
}

function defaultResult(eventType: V3EventType, progress: number | undefined): string | undefined {
  if (eventType === "task.waiting") return "等待中";
  if (eventType === "turn.completed") return "本轮已结束";
  if (eventType === "task.renamed") return "任务标题已更新";
  if (eventType === "task.progress" && progress !== undefined) return `进行中 ${progress}%`;
  return undefined;
}

export async function submitV3Event(
  env: Env,
  agent: AgentRecord,
  input: V3EventInput,
  ingress: "mcp" | "webhook" | "codex_hook" | "v3_api",
): Promise<V3SubmissionResponse> {
  const current = await getTask(env.DB, input.task_id, agent.id);
  const state = legacyState(input.type, current);
  const eventId = input.event_id ?? crypto.randomUUID();
  const traceId = crypto.randomUUID();
  const normalized = taskEventInputSchema.parse({
    task_id: input.task_id,
    run_id: input.run_id,
    event_id: eventId,
    state,
    title: input.title,
    summary: input.summary,
    content: input.content,
    result: input.result ?? defaultResult(input.type, input.progress),
    project: input.project,
    progress: state === "progress" ? (input.progress ?? current?.progress ?? 0) : input.progress,
    event_at: input.observed_at,
    force_notify: false,
  });
  const legacy = await submitTaskEvent(env, agent, normalized, {
    shadowEventType: input.type,
    ingress,
    traceId,
    ...(input.type === "task.waiting" ? { notificationPolicyOverride: "waiting" as const } : {}),
  });
  const identity = await getShadowEventIdentity(env.DB, agent.id, eventId);
  if (!identity) throw new Error("v3 event was not persisted");
  const deliveryStatus = await getV3EventDeliveryStatus(env.DB, agent.id, eventId);
  const mode = await getAgentDeliveryMode(env.DB, agent.id);
  let delivery: string = legacy.delivery_status;
  if (legacy.suppression_reason && legacy.suppression_reason !== "v3_delivery_authoritative") {
    delivery = "suppressed";
  } else if (String(env.V3_DELIVERY) === "true" && mode === "v3" && deliveryStatus) {
    delivery =
      deliveryStatus.acceptedRevision >= identity.revision
        ? deliveryStatus.acceptedRevision === identity.revision
          ? "provider_accepted"
          : "superseded"
        : (deliveryStatus.outboxState ?? "pending");
  }
  return {
    success: true,
    acceptance: "recorded",
    event_id: eventId,
    task_id: input.task_id,
    revision: identity.revision,
    disposition: identity.disposition,
    delivery,
    trace_id: traceId,
  };
}
