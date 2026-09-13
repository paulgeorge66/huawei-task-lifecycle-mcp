import { getEvent } from "./db";
import { getAgentDeliveryMode, getV3EventDeliveryStatus } from "./db-v3";
import { apiErrorCode, readLimitedJson, submissionErrorStatus } from "./http-utils";
import { submitV3Event, v3EventInputSchema } from "./protocol-v3";
import { authenticateAgent, retryEvent } from "./service";
import { SERVICE_VERSION } from "./version";

const MAX_EVENT_BODY_BYTES = 96 * 1024;

function errorResponse(status: number, code: string, message: string, traceId: string): Response {
  return Response.json(
    { success: false, code, message, trace_id: traceId },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

async function authenticate(request: Request, env: Env, traceId: string) {
  const authenticated = await authenticateAgent(request, env);
  if (!authenticated) return errorResponse(401, "unauthorized", "Unauthorized", traceId);
  return authenticated;
}

async function handleSubmit(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  const traceId = crypto.randomUUID();
  const authenticated = await authenticate(request, env, traceId);
  if (authenticated instanceof Response) return authenticated;
  try {
    const input = v3EventInputSchema.parse(await readLimitedJson(request, MAX_EVENT_BODY_BYTES));
    return Response.json(await submitV3Event(env, authenticated.record, input, "v3_api"), {
      status: 202,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(
      submissionErrorStatus(error),
      apiErrorCode(error),
      error instanceof Error ? error.message : "Request failed",
      traceId,
    );
  }
}

async function handleOperation(request: Request, env: Env, pathname: string): Promise<Response> {
  const match = /^\/api\/v3\/events\/([^/]+?)(\/retry)?$/u.exec(pathname);
  const traceId = crypto.randomUUID();
  if (!match) return errorResponse(404, "not_found", "Not found", traceId);
  const retry = match[2] === "/retry";
  const allowedMethod = retry ? "POST" : "GET";
  if (request.method !== allowedMethod)
    return new Response("Method not allowed", { status: 405, headers: { Allow: allowedMethod } });
  const authenticated = await authenticate(request, env, traceId);
  if (authenticated instanceof Response) return authenticated;
  let eventId: string;
  try {
    eventId = decodeURIComponent(match[1]!);
  } catch {
    return errorResponse(400, "invalid_request", "Invalid event ID", traceId);
  }
  if (!eventId || eventId.length > 128)
    return errorResponse(400, "invalid_request", "Invalid event ID", traceId);
  const event = await getEvent(env.DB, eventId);
  if (!event || event.agentId !== authenticated.record.id)
    return errorResponse(404, "not_found", "Event not found", traceId);
  try {
    const current = retry ? await retryEvent(env, eventId) : event;
    const delivery = await getV3EventDeliveryStatus(env.DB, authenticated.record.id, eventId);
    return Response.json(
      {
        success: true,
        event_id: eventId,
        task_id: current.taskId,
        recorded: true,
        legacy_delivery: current.deliveryStatus,
        delivery: delivery
          ? {
              revision: delivery.revision,
              desired_revision: delivery.desiredRevision,
              accepted_revision: delivery.acceptedRevision,
              revision_lag: delivery.revisionLag,
              outbox_state: delivery.outboxState,
              failure_count: delivery.failureCount,
              last_error: delivery.lastError,
              provider_code: delivery.providerCode,
              provider_description: delivery.providerDescription,
            }
          : null,
        action: retry ? "retry_requested" : "status",
        trace_id: traceId,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(
      submissionErrorStatus(error),
      apiErrorCode(error),
      error instanceof Error ? error.message : "Request failed",
      traceId,
    );
  }
}

async function handleDoctor(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET")
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
  const traceId = crypto.randomUUID();
  const authenticated = await authenticate(request, env, traceId);
  if (authenticated instanceof Response) return authenticated;
  return Response.json(
    {
      success: true,
      service: "huawei-task-lifecycle",
      version: SERVICE_VERSION,
      protocol: "v3",
      agent: {
        id: authenticated.record.id,
        display_name: authenticated.record.displayName,
        source_label: authenticated.record.sourceLabel,
        active: authenticated.record.active,
        last_seen_at: authenticated.record.lastSeenAt,
      },
      delivery: {
        global_v3_enabled: String(env.V3_DELIVERY) === "true",
        agent_mode: await getAgentDeliveryMode(env.DB, authenticated.record.id),
      },
      trace_id: traceId,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function handleV3HttpRequest(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response | null> {
  if (pathname === "/api/v3/events") return handleSubmit(request, env);
  if (pathname === "/api/v3/doctor") return handleDoctor(request, env);
  if (pathname.startsWith("/api/v3/events/")) return handleOperation(request, env, pathname);
  return null;
}
