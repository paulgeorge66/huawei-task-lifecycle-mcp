import { z } from "zod";

import { cardIdFor, providerMessageIdFor } from "./identity";
import type { EventRecord } from "./types";

export const MAX_CONTENT_LENGTH = 5_000;
export const MAX_SUMMARY_LENGTH = 300;
export const MAX_TITLE_LENGTH = 120;
const MAX_UPSTREAM_RESPONSE_BYTES = 64 * 1024;

export const pushInputSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
    summary: z.string().trim().min(1).max(MAX_SUMMARY_LENGTH).optional(),
    content: z.string().min(1).max(MAX_CONTENT_LENGTH),
    result: z.string().trim().min(1).max(100).default("任务已完成"),
    source: z.string().trim().min(1).max(80).optional(),
    task_id: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/u)
      .optional(),
    finished_at: z.number().int().min(1_609_459_200).optional(),
    project: z.string().trim().min(1).max(120).optional(),
    force_notify: z
      .literal(false)
      .default(false)
      .describe("Reserved for administrator operations; ordinary agents cannot bypass policy."),
  })
  .strict();

export type PushInput = z.infer<typeof pushInputSchema>;

export interface HuaweiPushResult {
  code: string | null;
  description: string;
}

export interface HuaweiCardInput {
  cardId: string;
  messageId: string;
  title: string;
  summary: string;
  result: string;
  content: string;
  source: string;
  displayAt: number;
}

interface HuaweiResponse {
  code?: string;
  description?: string;
}

export class HuaweiPushError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly httpStatus: number | null = null,
    readonly code: string | null = null,
    readonly description: string | null = null,
  ) {
    super(message);
    this.name = "HuaweiPushError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function parseHuaweiResponse(value: unknown): HuaweiResponse {
  if (!isRecord(value)) return {};
  const explicitCode = stringValue(value.code ?? value.status);
  const code =
    explicitCode ??
    (typeof value.success === "boolean" ? (value.success ? "success" : "failure") : undefined);
  const description = stringValue(value.desc ?? value.description ?? value.message);
  return {
    ...(code ? { code } : {}),
    ...(description ? { description } : {}),
  };
}

function isSuccessCode(code: string | undefined): boolean {
  return Boolean(code && ["0000000000", "0", "200", "success"].includes(code.toLowerCase()));
}

function isRetryableBusinessError(
  code: string | undefined,
  description: string | undefined,
): boolean {
  if (!code) return false;
  const detail = `${code} ${description ?? ""}`.toLowerCase();
  if (/(auth|token|permission|invalid|parameter|参数|鉴权|授权)/u.test(detail)) return false;
  if (code === "0200100004" && /8260001[37]/u.test(detail)) return false;
  return /(busy|timeout|temporar|rate|limit|retry|稍后|频繁|超时|系统繁忙)/u.test(detail);
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_UPSTREAM_RESPONSE_BYTES) {
      await reader.cancel();
      throw new HuaweiPushError("Huawei response exceeded the safety limit", true);
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

export function normalizeEscapedContent(content: string): string {
  if (!content.includes("\n") && content.includes("\\n")) {
    return content.replaceAll("\\n", "\n").replaceAll("\\t", "\t").replaceAll("\\r", "\r");
  }
  return content;
}

export function huaweiErrorGuidance(error: HuaweiPushError): string {
  if (error.code === "0000900034") {
    return "授权码无效或未关联，请在华为负一屏的动态管理中重新获取授权码。";
  }
  if (error.httpStatus === 401 || error.httpStatus === 403) return "请在管理端更新华为授权码。";
  if (error.code === "0200100004") return "华为侧拒绝了消息，请检查负一屏授权状态或内容格式。";
  return error.retryable ? "系统会自动重试。" : "请在管理端检查授权与内容后手动重试。";
}

export async function pushEventToHuawei(env: Env, event: EventRecord): Promise<HuaweiPushResult> {
  // Phone acceptance tests confirmed scheduleTaskId is the mutable card identity.
  // msgId identifies one event and must remain stable across retries of that event.
  const cardId = await cardIdFor(event.agentId, event.taskId);
  const messageId = await providerMessageIdFor(event.agentId, event.id);
  return pushCardToHuawei(env, {
    cardId,
    messageId,
    title: event.title,
    summary: event.summary,
    result: event.result,
    content: event.content,
    source: event.source,
    displayAt: event.finishedAt ?? event.eventAt,
  });
}

export async function pushCardToHuawei(env: Env, card: HuaweiCardInput): Promise<HuaweiPushResult> {
  const payload = {
    authCode: env.HUAWEI_AUTH_CODE,
    msgContent: [
      {
        msgId: card.messageId,
        scheduleTaskId: card.cardId,
        scheduleTaskName: card.title,
        summary: card.summary,
        result: card.result,
        content: normalizeEscapedContent(card.content),
        source: card.source,
        taskFinishTime: card.displayAt,
      },
    ],
  };

  let response: Response;
  try {
    response = await fetch(env.HUAWEI_PUSH_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "x-trace-id": crypto.randomUUID(),
      },
      body: JSON.stringify({ data: payload }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown network error";
    throw new HuaweiPushError(`Huawei push request failed: ${detail}`, true);
  }

  const responseText = await readBoundedText(response);
  let decoded: unknown;
  try {
    decoded = responseText ? JSON.parse(responseText) : null;
  } catch {
    decoded = null;
  }
  const upstream = parseHuaweiResponse(decoded);
  if (!response.ok) {
    throw new HuaweiPushError(
      `Huawei push returned HTTP ${response.status}${upstream.description ? `: ${upstream.description}` : ""}`,
      response.status === 408 || response.status === 429 || response.status >= 500,
      response.status,
      upstream.code ?? null,
      upstream.description ?? null,
    );
  }
  if (!upstream.code) {
    throw new HuaweiPushError(
      "Huawei push returned HTTP success without an explicit business code",
      true,
      response.status,
      null,
      upstream.description ?? null,
    );
  }
  if (!isSuccessCode(upstream.code)) {
    throw new HuaweiPushError(
      `Huawei push rejected the request (${upstream.code})${upstream.description ? `: ${upstream.description}` : ""}`,
      isRetryableBusinessError(upstream.code, upstream.description),
      response.status,
      upstream.code ?? null,
      upstream.description ?? null,
    );
  }
  return {
    code: upstream.code,
    description: upstream.description ?? "华为接口已接受消息",
  };
}
