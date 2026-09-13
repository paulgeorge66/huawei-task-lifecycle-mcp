import { z } from "zod";

import { EventConflictError } from "./submission-policy";

export function submissionErrorStatus(error: unknown): number {
  if (error instanceof EventConflictError) return error.status;
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 400;
  if (error instanceof Error && error.message === "Payload too large") return 413;
  if (error instanceof Error && error.message === "Agent is disabled") return 403;
  return 500;
}

export function apiErrorCode(error: unknown): string {
  if (error instanceof EventConflictError) return "idempotency_conflict";
  if (error instanceof z.ZodError || error instanceof SyntaxError) return "invalid_request";
  if (error instanceof Error && error.message === "Payload too large") return "payload_too_large";
  if (error instanceof Error && error.message === "Agent is disabled") return "agent_disabled";
  return "internal_error";
}

export async function readLimitedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!request.body) throw new Error("Request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Payload too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
