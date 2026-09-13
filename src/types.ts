import { z } from "zod";

export const TASK_STATES = ["started", "progress", "completed", "failed", "canceled"] as const;
export const DELIVERY_STATUSES = [
  "suppressed",
  "pending",
  "queued",
  "delivering",
  "retry_scheduled",
  "delivered",
  "failed",
  "enqueue_failed",
] as const;

export type TaskState = (typeof TASK_STATES)[number];
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "identifier contains unsupported characters");

export const taskEventBaseSchema = z
  .object({
    task_id: identifierSchema.describe("Stable task ID shared by every lifecycle event."),
    event_id: identifierSchema
      .optional()
      .describe("Unique ID for this event. A UUID is generated when omitted."),
    run_id: identifierSchema
      .optional()
      .describe("Stable run or turn ID. A new started run may reopen a terminal task."),
    state: z.enum(TASK_STATES).describe("Lifecycle state for this event."),
    title: z.string().trim().min(1).max(120).describe("Task name shown on Huawei Today."),
    summary: z.string().trim().min(1).max(300).optional(),
    content: z.string().max(5_000).default(""),
    result: z.string().trim().min(1).max(100).optional(),
    source: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe("Compatibility input only; the displayed source is managed by the owner."),
    project: z.string().trim().min(1).max(120).optional(),
    progress: z.number().int().min(0).max(100).optional(),
    event_at: z.number().int().min(1_609_459_200).optional(),
    started_at: z.number().int().min(1_609_459_200).optional(),
    finished_at: z.number().int().min(1_609_459_200).optional(),
    force_notify: z
      .literal(false)
      .default(false)
      .describe("Reserved for administrator operations; ordinary agents cannot bypass policy."),
  })
  .strict();

export const taskLifecycleInputSchema = taskEventBaseSchema.omit({ state: true });

export const taskEventInputSchema = taskEventBaseSchema.superRefine((value, context) => {
  const latestReasonableTimestamp = Math.floor(Date.now() / 1_000) + 31_536_000;
  for (const field of ["event_at", "started_at", "finished_at"] as const) {
    if (value[field] !== undefined && value[field] > latestReasonableTimestamp) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `${field} must not be more than one year in the future`,
      });
    }
  }
  if (value.state === "progress" && value.progress === undefined) {
    context.addIssue({ code: "custom", path: ["progress"], message: "progress is required" });
  }
  if (
    value.finished_at !== undefined &&
    value.started_at !== undefined &&
    value.finished_at < value.started_at
  ) {
    context.addIssue({
      code: "custom",
      path: ["finished_at"],
      message: "finished_at must not be earlier than started_at",
    });
  }
});

export type TaskEventInput = z.infer<typeof taskEventInputSchema>;

export const submissionOutputSchema = z.object({
  success: z.boolean(),
  event_id: z.string(),
  task_id: z.string(),
  delivery_status: z.enum(DELIVERY_STATUSES),
  message: z.string(),
  suppression_reason: z.string().optional(),
});

export type SubmissionOutput = z.infer<typeof submissionOutputSchema>;

export interface AgentPolicy {
  active: boolean;
  notificationsEnabled: boolean;
  notifyStarted: boolean;
  notifyProgress: boolean;
  notifyCompleted: boolean;
  notifyFailed: boolean;
  notifyCanceled: boolean;
  minimumDurationSeconds: number;
  dedupeWindowSeconds: number;
  includeFullContent: boolean;
  maxContentLength: number;
  mutedProjects: string[];
}

export interface AgentRecord extends AgentPolicy {
  id: string;
  displayName: string;
  sourceLabel: string;
  tokenHint: string | null;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number | null;
}

export interface EventRecord {
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
  attempts: number;
  huaweiCode: string | null;
  huaweiDescription: string | null;
  lastError: string | null;
  queuedAt: number | null;
  deliveredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface LegacyDeliveryMessage {
  eventId: string;
}

export interface V3DeliveryMessage {
  kind: "v3";
  outboxId: string;
  taskId: string;
  targetRevision: number;
}

export type DeliveryMessage = LegacyDeliveryMessage | V3DeliveryMessage;

export interface AuthenticatedAgent {
  record: AgentRecord;
  legacy: boolean;
}
