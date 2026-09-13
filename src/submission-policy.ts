export interface SubmissionOptions {
  bypassNotificationPolicy?: boolean;
  shadowEventType?: import("./db-v3").V3EventType;
  ingress?: "legacy" | "mcp" | "webhook" | "codex_hook" | "v3_api";
  traceId?: string;
  notificationPolicyOverride?: "waiting";
}

export class EventConflictError extends Error {
  readonly status = 409;

  constructor(message = "event_id already exists with different content") {
    super(message);
    this.name = "EventConflictError";
  }
}

export function assertSubmissionAllowed(agentActive: boolean, forceNotify: boolean): void {
  if (!agentActive) throw new Error("Agent is disabled");
  if (forceNotify) throw new Error("force_notify requires administrator permission");
}
