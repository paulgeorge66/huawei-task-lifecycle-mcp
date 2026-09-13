import {
  AuthorizationError,
  OAuthProvider,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

import { handleAdminRequest } from "./admin";
import { codexHookProjection } from "./codex-hook";
import { constantTimeEqual, sha256Hex } from "./crypto";
import { getEvent, getTask, listEvents } from "./db";
import { getV3EventDeliveryStatus, listV3EventDeliveryStatuses, recordCredential } from "./db-v3";
import { readLimitedJson, submissionErrorStatus } from "./http-utils";
import { handleV3HttpRequest } from "./http-v3";
import { MAX_CONTENT_LENGTH, pushInputSchema, type PushInput } from "./push";
import { dispatchPendingOutbox } from "./delivery-v3";
import {
  authenticateAgent,
  consumeDeliveryBatch,
  ensureOAuthAgent,
  retryEvent,
  submitTaskEvent,
} from "./service";
import {
  DELIVERY_STATUSES,
  submissionOutputSchema,
  taskEventInputSchema,
  taskLifecycleInputSchema,
  type AgentRecord,
  type SubmissionOutput,
  type TaskEventInput,
  type TaskState,
} from "./types";
import { SERVICE_VERSION } from "./version";

interface AuthProps {
  userId: string;
  clientName: string;
  permissions: string[];
  agentId?: string;
}

type OAuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const MAX_HOOK_BODY_BYTES = 96 * 1024;
const PUSH_SCOPE = "push:write";

const statusInputSchema = z.object({ event_id: z.string().trim().min(1).max(128) }).strict();
const listInputSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
    status: z.enum(DELIVERY_STATUSES).optional(),
  })
  .strict();
const retryInputSchema = statusInputSchema;
const eventOutputSchema = z.object({
  success: z.boolean(),
  event: z.record(z.string(), z.unknown()).optional(),
  message: z.string(),
});
const listOutputSchema = z.object({
  success: z.boolean(),
  total: z.number(),
  items: z.array(z.record(z.string(), z.unknown())),
});

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function secureHtml(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

function authorizationPage(action: string, clientName: string, errorMessage?: string): Response {
  return secureHtml(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权华为任务推送</title><style>:root{color-scheme:dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1220;color:#e5e7eb}main{width:min(92vw,430px);padding:28px;border:1px solid #334155;border-radius:18px;background:#111827;box-shadow:0 20px 60px #0008}p{color:#cbd5e1;line-height:1.55}input,button{box-sizing:border-box;width:100%;padding:12px;border-radius:10px;font:inherit}input{border:1px solid #475569;background:#0f172a;color:#fff}button{margin-top:16px;border:0;background:#2563eb;color:#fff;font-weight:700}.error{color:#fca5a5}</style></head><body><main><h1>授权华为负一屏推送</h1><p>客户端 <b>${escapeHtml(clientName)}</b> 请求提交任务生命周期、查看投递状态及重试自己的失败事件。</p>${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ""}<form method="post" action="${escapeHtml(action)}"><input name="password" type="password" required autocomplete="current-password" autofocus placeholder="管理员口令"><button>授权此客户端</button></form></main></body></html>`,
  );
}

function publicHomePage(env: Env): Response {
  return secureHtml(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Huawei Task Lifecycle</title><style>:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#172018;background:#f2f4e9}*{box-sizing:border-box}body{margin:0}.wrap{width:min(1120px,92vw);margin:auto}.hero{padding:78px 0 42px}.tag{display:inline-block;padding:6px 10px;border:1px solid #172018;border-radius:999px;font:700 12px ui-monospace,monospace;letter-spacing:.08em}.hero h1{font-size:clamp(42px,7vw,80px);line-height:.95;letter-spacing:-.06em;max-width:900px;margin:28px 0}.lead{font-size:20px;line-height:1.65;max-width:760px;color:#465046}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin:32px 0 60px}.card{background:#fff;border:1px solid #172018;border-radius:22px;padding:24px;box-shadow:6px 6px 0 #172018}.card b{font-size:20px}.card p{line-height:1.6;color:#526052}.badge{display:inline-block;margin-bottom:18px;padding:5px 9px;border-radius:8px;background:#d9ff57;font:700 12px ui-monospace,monospace;letter-spacing:.08em}.recommended{background:#172018;color:#fff}.recommended p{color:#d6ddd6}.recommended .badge{color:#172018}.flow{padding:30px 0 70px;border-top:1px solid #aeb8aa}.flow code{background:#e2e7da;padding:4px 7px;border-radius:6px}.links{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}.links a{color:inherit;text-decoration:none;border:1px solid;padding:11px 14px;border-radius:10px;background:#fff}.links a:first-child{background:#172018;color:#fff}footer{padding:24px 0 42px;color:#687268;border-top:1px solid #cbd1c5}@media(max-width:800px){.grid{grid-template-columns:1fr}.hero{padding-top:52px}}</style></head><body><main class="wrap"><section class="hero"><span class="tag">CLOUDFLARE WORKERS · MCP · SKILL</span><h1>一项任务，一张持续更新的华为卡片。</h1><p class="lead">把 Codex、Gemini Spark、GPT Work 与其他 Agent 的开始、进度和最终结果汇聚到华为负一屏。D1 记录状态，Queue 负责可靠投递，OAuth 与独立 Agent Token 隔离来源。</p><div class="links"><a href="${env.PUBLIC_REPOSITORY_URL}">查看项目与教程</a><a href="/health/ready">服务健康状态</a><a href="/admin">管理后台</a></div></section><section class="grid"><article class="card recommended"><span class="badge">可靠性最高</span><b>MCP + Hook</b><p>MCP 负责完整生命周期；宿主 Hook 在每轮结束时保底推送。适合 Codex 等同时支持 MCP 与完成通知的客户端。</p></article><article class="card"><span class="badge">语义最完整</span><b>MCP + Skill</b><p>Skill 强制开始、里程碑与唯一终态，MCP 提供 OAuth、查询与重试。适合支持 MCP 和可安装 Skill 的 Agent。</p></article><article class="card"><span class="badge">兼容范围最广</span><b>纯 Skill / Webhook</b><p>不依赖 MCP；Skill 通过内置脚本和长期 Agent Token 调用 HTTPS Webhook。适合 GPT Work 等脚本型环境。</p></article></section><section class="flow"><h2>统一生命周期</h2><p><code>started</code> → <code>progress | waiting</code> → <code>completed | failed | canceled</code></p><p>同一 Agent 内稳定复用 <code>task_id</code>，所有事件更新同一张卡；不同 Agent 的同名任务不会互相覆盖。</p></section></main><footer><div class="wrap">Huawei Task Lifecycle · 单向通知，不上传模型隐藏推理或凭据。</div></footer></body></html>`,
  );
}

function oauthErrorResponse(error: AuthorizationError): Response {
  if (!error.redirectUri) return secureHtml(`<p>${escapeHtml(error.description)}</p>`, 400);
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect, 302);
}

async function parseOAuthRequest(request: Request, env: OAuthEnv): Promise<AuthRequest | Response> {
  try {
    return { ...(await env.OAUTH_PROVIDER.parseAuthRequest(request)), issuer: env.PUBLIC_ORIGIN };
  } catch (error) {
    if (error instanceof AuthorizationError) return oauthErrorResponse(error);
    throw error;
  }
}

async function resolveMcpAgent(env: Env, props: AuthProps): Promise<AgentRecord> {
  const id = props.agentId ?? `oauth-${(await sha256Hex(props.clientName)).slice(0, 24)}`;
  const agent = await ensureOAuthAgent(env, id, props.clientName);
  if (!agent.active) throw new Error("Agent is disabled");
  return agent;
}

function toolSuccess(output: SubmissionOutput) {
  return {
    content: [{ type: "text" as const, text: `${output.message}（${output.delivery_status}）` }],
    structuredContent: output,
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  return {
    content: [{ type: "text" as const, text: `操作失败：${message}` }],
    isError: true as const,
  };
}

async function readiness(env: Env): Promise<Response> {
  const dependencies = {
    d1: false,
    queue: Boolean(env.DELIVERY_QUEUE),
    secrets: Boolean(env.HUAWEI_AUTH_CODE && env.OWNER_PASSWORD && env.CODEX_WEBHOOK_TOKEN),
  };
  try {
    dependencies.d1 = (await env.DB.prepare("SELECT 1 AS ok").first<number>("ok")) === 1;
  } catch {
    dependencies.d1 = false;
  }
  const ok = Object.values(dependencies).every(Boolean);
  return Response.json(
    { ok, service: "huawei-task-lifecycle", version: SERVICE_VERSION, dependencies },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}

function createPushServer(env: Env, props: AuthProps): McpServer {
  const server = new McpServer(
    { name: "Huawei Task Lifecycle", version: SERVICE_VERSION },
    {
      instructions:
        "For every substantive task that produces a result, changes state, runs tools, or continues asynchronously, report its lifecycle to Huawei Today. Call huawei_task_start before substantive work, optionally call huawei_task_progress at meaningful milestones, call huawei_task_wait when required user input or an external dependency pauses work, and call exactly one of huawei_task_complete, huawei_task_fail, or huawei_task_cancel before the task ends. One stable task_id maps to one Huawei card: reuse it across all runs and transitions. Reuse one run_id within an execution; use a new run_id when intentionally reopening a terminal task. Generate a unique event_id before every lifecycle call, retain it for status/retry, and never repeat a lifecycle call merely to discover an event ID. Keep the title stable and use huawei_task_rename only when it genuinely changes. Put only user-visible, non-sensitive status or output in content; never send hidden reasoning, credentials, tokens, OAuth codes, or unrelated private data. A policy-suppressed event is recorded and does not need retrying. Query delivery status before retrying a failed event. The displayed source name is managed by the owner in the admin console.",
    },
  );

  const submit = async (input: TaskEventInput) => {
    if (!props.permissions.includes(PUSH_SCOPE)) throw new Error(`${PUSH_SCOPE} is required`);
    return submitTaskEvent(env, await resolveMcpAgent(env, props), input, { ingress: "mcp" });
  };

  server.registerTool(
    "push_huawei_task",
    {
      title: "Push result to Huawei Today",
      description:
        "Backward-compatible completed-task push. The event is persisted and queued for reliable delivery.",
      inputSchema: pushInputSchema,
      outputSchema: submissionOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input: PushInput) => {
      try {
        return toolSuccess(
          await submit({
            task_id: input.task_id ?? crypto.randomUUID(),
            state: "completed",
            title: input.title,
            summary: input.summary,
            content: input.content,
            result: input.result,
            source: input.source,
            project: input.project,
            finished_at: input.finished_at,
            force_notify: input.force_notify,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "huawei_task_event",
    {
      title: "Submit task lifecycle event",
      description:
        "Record started, progress, completed, failed, or canceled for one stable task_id and enqueue it according to the agent policy.",
      inputSchema: taskEventInputSchema,
      outputSchema: submissionOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input: TaskEventInput) => {
      try {
        return toolSuccess(await submit(input));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  const lifecycle = (name: string, state: TaskState, description: string) => {
    server.registerTool(
      name,
      {
        title: description,
        description,
        inputSchema: taskLifecycleInputSchema,
        outputSchema: submissionOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (input) => {
        try {
          return toolSuccess(await submit(taskEventInputSchema.parse({ ...input, state })));
        } catch (error) {
          return toolError(error);
        }
      },
    );
  };
  lifecycle("huawei_task_start", "started", "Mark a task started");
  lifecycle("huawei_task_progress", "progress", "Report a meaningful task milestone");
  server.registerTool(
    "huawei_task_wait",
    {
      title: "Mark a task waiting",
      description: "Record that a task is waiting for user input or an external dependency.",
      inputSchema: taskLifecycleInputSchema,
      outputSchema: submissionOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        if (!props.permissions.includes(PUSH_SCOPE)) throw new Error(`${PUSH_SCOPE} is required`);
        const agent = await resolveMcpAgent(env, props);
        const current = await getTask(env.DB, input.task_id, agent.id);
        return toolSuccess(
          await submitTaskEvent(
            env,
            agent,
            taskEventInputSchema.parse({
              ...input,
              state: "progress",
              progress: input.progress ?? current?.progress ?? 0,
              result: input.result ?? "等待中",
            }),
            {
              ingress: "mcp",
              shadowEventType: "task.waiting",
              notificationPolicyOverride: "waiting",
            },
          ),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
  lifecycle(
    "huawei_task_complete",
    "completed",
    "Mark a task completed and include its user-visible result",
  );
  lifecycle("huawei_task_fail", "failed", "Mark a task ended by an error or blocker");
  lifecycle("huawei_task_cancel", "canceled", "Mark a task canceled or replaced by the user");
  server.registerTool(
    "huawei_task_rename",
    {
      title: "Rename a Huawei task card",
      description: "Change the stable title of an existing task without changing its task state.",
      inputSchema: taskLifecycleInputSchema,
      outputSchema: submissionOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        if (!props.permissions.includes(PUSH_SCOPE)) throw new Error(`${PUSH_SCOPE} is required`);
        const agent = await resolveMcpAgent(env, props);
        const current = await getTask(env.DB, input.task_id, agent.id);
        if (!current) throw new Error("Task not found");
        return toolSuccess(
          await submitTaskEvent(
            env,
            agent,
            taskEventInputSchema.parse({
              ...input,
              state: current.state,
              progress:
                current.state === "progress"
                  ? (input.progress ?? current.progress ?? 0)
                  : input.progress,
              result: input.result ?? "任务标题已更新",
            }),
            { ingress: "mcp", shadowEventType: "task.renamed" },
          ),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "huawei_get_delivery_status",
    {
      title: "Get Huawei delivery status",
      description: "Read one lifecycle event and its current queued/delivered/failed status.",
      inputSchema: statusInputSchema,
      outputSchema: eventOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ event_id }) => {
      try {
        const agent = await resolveMcpAgent(env, props);
        const event = await getEvent(env.DB, event_id);
        if (!event || event.agentId !== agent.id) throw new Error("Event not found");
        const v3Delivery = await getV3EventDeliveryStatus(env.DB, agent.id, event_id);
        const output = {
          success: true,
          event: { ...event, ...(v3Delivery ? { v3Delivery } : {}) } as unknown as Record<
            string,
            unknown
          >,
          message: v3Delivery
            ? `v3 投递：accepted ${v3Delivery.acceptedRevision} / desired ${v3Delivery.desiredRevision}`
            : `投递状态：${event.deliveryStatus}`,
        };
        return {
          content: [{ type: "text" as const, text: output.message }],
          structuredContent: output,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "huawei_list_deliveries",
    {
      title: "List Huawei deliveries",
      description: "List recent lifecycle delivery records for the authenticated agent.",
      inputSchema: listInputSchema,
      outputSchema: listOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit, offset, status }) => {
      try {
        const agent = await resolveMcpAgent(env, props);
        const page = await listEvents(env.DB, {
          limit,
          offset,
          agentId: agent.id,
          ...(status ? { status } : {}),
        });
        const v3Statuses = await listV3EventDeliveryStatuses(
          env.DB,
          agent.id,
          page.items.map((event) => event.id),
        );
        const output = {
          success: true,
          total: page.total,
          items: page.items.map((event) => ({
            ...event,
            ...(v3Statuses[event.id] ? { v3Delivery: v3Statuses[event.id] } : {}),
          })) as unknown as Record<string, unknown>[],
        };
        return {
          content: [{ type: "text" as const, text: `找到 ${page.total} 条投递记录` }],
          structuredContent: output,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "huawei_retry_delivery",
    {
      title: "Retry failed Huawei delivery",
      description: "Requeue one failed delivery owned by the authenticated agent.",
      inputSchema: retryInputSchema,
      outputSchema: eventOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ event_id }) => {
      try {
        const agent = await resolveMcpAgent(env, props);
        const current = await getEvent(env.DB, event_id);
        if (!current || current.agentId !== agent.id) throw new Error("Event not found");
        const event = await retryEvent(env, event_id);
        const output = {
          success: true,
          event: event as unknown as Record<string, unknown>,
          message: "失败事件已重新入队",
        };
        return {
          content: [{ type: "text" as const, text: output.message }],
          structuredContent: output,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
  return server;
}

export class McpApiHandler extends WorkerEntrypoint<OAuthEnv, AuthProps> {
  fetch(request: Request): Promise<Response> {
    return createMcpHandler(() => createPushServer(this.env, this.ctx.props))(
      request,
      this.env,
      this.ctx,
    );
  }
}

export class AuthorizationHandler extends WorkerEntrypoint<OAuthEnv> {
  async fetch(request: Request): Promise<Response> {
    const admin = await handleAdminRequest(request, this.env);
    if (admin) return admin;
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") return publicHomePage(this.env);
    if (url.pathname === "/api/info" && request.method === "GET") {
      return Response.json(
        {
          name: "Huawei Task Lifecycle",
          version: SERVICE_VERSION,
          repository: this.env.PUBLIC_REPOSITORY_URL,
          endpoints: {
            mcp: `${this.env.PUBLIC_ORIGIN}/mcp`,
            eventsV3: `${this.env.PUBLIC_ORIGIN}/api/v3/events`,
            agentWebhook: `${this.env.PUBLIC_ORIGIN}/hooks/agent`,
            codexHook: `${this.env.PUBLIC_ORIGIN}/hooks/codex`,
            admin: `${this.env.PUBLIC_ORIGIN}/admin`,
            health: `${this.env.PUBLIC_ORIGIN}/health/ready`,
          },
          integrationModes: ["mcp+hook", "mcp+skill", "skill+webhook"],
        },
        { headers: { "Cache-Control": "public, max-age=300" } },
      );
    }
    if (url.pathname === "/health/live" && request.method === "GET")
      return Response.json({
        ok: true,
        service: "huawei-task-lifecycle",
        version: SERVICE_VERSION,
      });
    if (
      (url.pathname === "/health" || url.pathname === "/health/ready") &&
      request.method === "GET"
    )
      return readiness(this.env);
    const v3Response = await handleV3HttpRequest(request, this.env, url.pathname);
    if (v3Response) return v3Response;
    if (url.pathname === "/hooks/codex") return this.handleCodexHook(request);
    if (url.pathname === "/hooks/agent") return this.handleAgentHook(request);
    if (url.pathname !== "/authorize") return new Response("Not found", { status: 404 });
    if (request.method !== "GET" && request.method !== "POST")
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
    const oauthRequest = await parseOAuthRequest(request, this.env);
    if (oauthRequest instanceof Response) return oauthRequest;
    const client = await this.env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
    if (!client) return secureHtml("<p>Unknown OAuth client.</p>", 400);
    const clientName = client.clientName || oauthRequest.clientId;
    if (request.method === "GET") return authorizationPage(url.pathname + url.search, clientName);
    const origin = request.headers.get("Origin");
    const isSameOriginForm =
      origin === new URL(this.env.PUBLIC_ORIGIN).origin ||
      request.headers.get("Sec-Fetch-Site") === "same-origin";
    if (origin && !isSameOriginForm) return secureHtml("<p>Invalid form origin.</p>", 403);
    const form = await request.formData();
    const password = form.get("password");
    if (
      typeof password !== "string" ||
      !(await constantTimeEqual(password, this.env.OWNER_PASSWORD))
    )
      return authorizationPage(url.pathname + url.search, clientName, "管理员口令不正确。");
    const grantedScopes = oauthRequest.scope.filter((scope) => scope === PUSH_SCOPE);
    if (!grantedScopes.includes(PUSH_SCOPE)) grantedScopes.push(PUSH_SCOPE);
    const agentId = `oauth-${(await sha256Hex(oauthRequest.clientId)).slice(0, 24)}`;
    const agent = await ensureOAuthAgent(this.env, agentId, clientName);
    await recordCredential(this.env.DB, agent, {
      kind: "oauth",
      clientId: oauthRequest.clientId,
    });
    const { redirectTo } = await this.env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthRequest,
      userId: "owner",
      metadata: { clientName, agentId },
      scope: grantedScopes,
      props: { userId: "owner", clientName, permissions: grantedScopes, agentId },
      revokeExistingGrants: false,
    });
    return Response.redirect(redirectTo, 302);
  }

  private async handleAgentHook(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    const authenticated = await authenticateAgent(request, this.env);
    if (!authenticated)
      return Response.json({ success: false, message: "Unauthorized" }, { status: 401 });
    try {
      const input = taskEventInputSchema.parse(await readLimitedJson(request, MAX_HOOK_BODY_BYTES));
      return Response.json(
        await submitTaskEvent(this.env, authenticated.record, input, { ingress: "webhook" }),
        {
          status: 202,
        },
      );
    } catch (error) {
      return Response.json(
        { success: false, message: error instanceof Error ? error.message : "Invalid payload" },
        { status: submissionErrorStatus(error) },
      );
    }
  }

  private async handleCodexHook(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    const authenticated = await authenticateAgent(request, this.env);
    if (!authenticated)
      return Response.json({ success: false, message: "Unauthorized" }, { status: 401 });
    try {
      const body = await readLimitedJson(request, MAX_HOOK_BODY_BYTES);
      if (!isRecord(body) || body.type !== "agent-turn-complete")
        return Response.json({ success: true, message: "Ignored unsupported event" });
      const assistantMessage =
        typeof body["last-assistant-message"] === "string"
          ? body["last-assistant-message"].trim()
          : "";
      if (!assistantMessage)
        return Response.json({ success: true, message: "Ignored empty assistant message" });
      const threadId =
        typeof body["thread-id"] === "string" ? body["thread-id"] : crypto.randomUUID();
      const turnId = typeof body["turn-id"] === "string" ? body["turn-id"] : crypto.randomUUID();
      const cwd = typeof body.cwd === "string" ? body.cwd : "";
      const project = cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? "Codex";
      const taskId = `codex:${threadId}`.slice(0, 128).replace(/[^A-Za-z0-9._:-]/gu, "_");
      const existingTask = await getTask(this.env.DB, taskId, authenticated.record.id);
      const reportedTitle = codexReportedTitle(body);
      const inferredTitle = codexTaskTitle(body, project);
      const title =
        reportedTitle ??
        (existingTask && !isCodexFallbackTitle(existingTask.title, project)
          ? existingTask.title
          : inferredTitle);
      const content = assistantMessage.slice(0, MAX_CONTENT_LENGTH);
      const projection = codexHookProjection(existingTask);
      const eventId = `codex-turn:${(
        await sha256Hex(`${authenticated.record.id}\0${threadId}\0${turnId}`)
      ).slice(0, 48)}`;
      return Response.json(
        await submitTaskEvent(
          this.env,
          authenticated.record,
          {
            event_id: eventId,
            task_id: taskId,
            run_id: turnId,
            state: projection.state,
            ...(projection.progress === undefined ? {} : { progress: projection.progress }),
            title,
            // Huawei's card surface foregrounds `summary`; mirror the task title
            // here so the visible card name is never the generic completion text.
            summary: title,
            content,
            result: projection.result,
            source: authenticated.record.sourceLabel,
            project,
            force_notify: false,
          },
          {
            bypassNotificationPolicy: true,
            shadowEventType: "turn.completed",
            ingress: "codex_hook",
          },
        ),
        { status: 202 },
      );
    } catch (error) {
      return Response.json(
        { success: false, message: error instanceof Error ? error.message : "Invalid payload" },
        { status: submissionErrorStatus(error) },
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CODEX_FALLBACK_TITLE = "Codex 任务";
const CODEX_TITLE_MAX_BYTES = 80;

function codexTaskTitle(body: Record<string, unknown>, _project: string): string {
  const reported = codexReportedTitle(body);
  if (reported) return reported;
  const inputs = body["input-messages"];
  if (Array.isArray(inputs)) {
    for (const input of [...inputs].reverse()) {
      const title = codexTitleCandidate(input);
      if (title) return title;
    }
  }
  return CODEX_FALLBACK_TITLE;
}

function codexReportedTitle(body: Record<string, unknown>): string | null {
  for (const field of ["task-title", "thread-title", "title"] as const) {
    const value = body[field];
    const title = codexTitleCandidate(value);
    if (title) return title;
  }
  return null;
}

function codexTitleCandidate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const firstLine = value
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/^#+\s*/u, ""))
    .find(Boolean);
  if (!firstLine || isCodexInternalPrompt(firstLine)) return null;
  return truncateUtf8(firstLine, CODEX_TITLE_MAX_BYTES);
}

function isCodexInternalPrompt(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.startsWith("you are ") ||
    normalized.startsWith("your task ") ||
    normalized.startsWith("we need ") ||
    normalized.startsWith("system message") ||
    normalized.includes("safety and compliance") ||
    normalized.includes("developer instructions") ||
    normalized.includes("valid channels:")
  );
}

function isCodexFallbackTitle(title: string, project: string): boolean {
  return title === CODEX_FALLBACK_TITLE || title === project || title === `Codex · ${project}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = new TextEncoder().encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) break;
    output += character;
    bytes += characterBytes;
  }
  return output || CODEX_FALLBACK_TITLE;
}

function oauthProviderFor(env: OAuthEnv): OAuthProvider<OAuthEnv> {
  return new OAuthProvider<OAuthEnv>({
    apiRoute: "/mcp",
    apiHandler: McpApiHandler,
    defaultHandler: AuthorizationHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [PUSH_SCOPE],
    resourceMetadata: {
      resource: `${env.PUBLIC_ORIGIN}/mcp`,
      authorization_servers: [env.PUBLIC_ORIGIN],
      scopes_supported: [PUSH_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Huawei Task Lifecycle MCP",
    },
    accessTokenTTL: 60 * 60,
    refreshTokenTTL: 60 * 60 * 24 * 180,
  });
}

export default {
  async fetch(request: Request, env: OAuthEnv, ctx: ExecutionContext): Promise<Response> {
    const response = await oauthProviderFor(env).fetch(request, env, ctx);
    const pathname = new URL(request.url).pathname;
    if (
      response.ok &&
      pathname.startsWith("/.well-known/oauth-authorization-server") &&
      response.headers.get("Content-Type")?.includes("application/json")
    ) {
      const metadata = await response.json<Record<string, unknown>>();
      metadata.authorization_response_iss_parameter_supported = false;
      const headers = new Headers(response.headers);
      headers.delete("Content-Length");
      return Response.json(metadata, { status: response.status, headers });
    }
    return response;
  },
  queue(batch: MessageBatch<unknown>, env: OAuthEnv): Promise<void> {
    return consumeDeliveryBatch(batch as MessageBatch<import("./types").DeliveryMessage>, env);
  },
  scheduled(_controller: ScheduledController, env: OAuthEnv): Promise<void> {
    return dispatchPendingOutbox(env).then(() => undefined);
  },
} satisfies ExportedHandler<OAuthEnv>;
