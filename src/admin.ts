import { z } from "zod";

import {
  constantTimeEqual,
  fromBase64Url,
  randomToken,
  sha256Hex,
  signHmac,
  toBase64Url,
  verifyHmac,
} from "./crypto";
import {
  createAgent,
  ensureSystemAgent,
  getDashboardSummary,
  listAgents,
  listEvents,
  recordAdminAudit,
  setAgentToken,
  updateAgent,
} from "./db";
import {
  getShadowSummary,
  listAgentDeliveryModes,
  listShadowDiffs,
  listV3DeliveryTimeline,
  recordCredential,
  setAgentDeliveryMode,
} from "./db-v3";
import { retryEvent, submitTaskEvent } from "./service";
import { DELIVERY_STATUSES } from "./types";

const SESSION_COOKIE = "hpa_admin";
const MAX_BODY_BYTES = 64 * 1024;

interface Session {
  exp: number;
  csrf: string;
}

const createAgentSchema = z
  .object({
    display_name: z.string().trim().min(1).max(80),
    source_label: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

const updateAgentSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    sourceLabel: z.string().trim().min(1).max(80).optional(),
    active: z.boolean().optional(),
    notificationsEnabled: z.boolean().optional(),
    notifyStarted: z.boolean().optional(),
    notifyProgress: z.boolean().optional(),
    notifyCompleted: z.boolean().optional(),
    notifyFailed: z.boolean().optional(),
    notifyCanceled: z.boolean().optional(),
    minimumDurationSeconds: z.number().int().min(0).max(604_800).optional(),
    dedupeWindowSeconds: z.number().int().min(0).max(86_400).optional(),
    includeFullContent: z.boolean().optional(),
    maxContentLength: z.number().int().min(100).max(5_000).optional(),
    mutedProjects: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
    deliveryMode: z.enum(["shadow", "v3"]).optional(),
  })
  .strict();

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

async function makeSession(secret: string): Promise<{ cookie: string; session: Session }> {
  const session = { exp: Math.floor(Date.now() / 1_000) + 8 * 60 * 60, csrf: randomToken(18) };
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(session)));
  const signature = await signHmac(secret, payload);
  return {
    session,
    cookie: `${SESSION_COOKIE}=${payload}.${signature}; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Strict`,
  };
}

async function readSession(request: Request, secret: string): Promise<Session | null> {
  const raw = cookieValue(request, SESSION_COOKIE);
  if (!raw) return null;
  const separator = raw.lastIndexOf(".");
  if (separator < 1) return null;
  const payload = raw.slice(0, separator);
  if (!(await verifyHmac(secret, payload, raw.slice(separator + 1)))) return null;
  try {
    const decoded: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    if (typeof decoded !== "object" || decoded === null) return null;
    const value = decoded as Record<string, unknown>;
    if (typeof value.exp !== "number" || typeof value.csrf !== "string") return null;
    if (value.exp <= Math.floor(Date.now() / 1_000)) return null;
    return { exp: value.exp, csrf: value.csrf };
  } catch {
    return null;
  }
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (length > MAX_BODY_BYTES) throw new Error("Payload too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES)
    throw new Error("Payload too large");
  return JSON.parse(text);
}

function loginPage(error = ""): Response {
  return html(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Push Control</title><style>
  :root{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#171b16;background:#e8eadf}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#dfe7c8,#f4efe2)}main{width:min(92vw,420px);background:#fffdf5;border:3px solid #171b16;box-shadow:10px 10px 0 #ff6038;padding:30px}p{line-height:1.6}.tag{display:inline-block;background:#c8ff38;border:2px solid;padding:4px 8px;font-weight:900}input,button{width:100%;padding:13px;border:2px solid #171b16;font:inherit}button{margin-top:12px;background:#171b16;color:white;font-weight:900;cursor:pointer}.err{color:#c12610}</style></head><body><main><span class="tag">HUAWEI PUSH OPS</span><h1>控制台登录</h1><p>管理 agent、通知策略、生命周期事件和失败重试。</p>${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}<form method="post" action="/admin/login"><input name="password" type="password" required autofocus autocomplete="current-password" placeholder="管理员口令"><button>进入控制台 →</button></form></main></body></html>`);
}

function dashboardPage(csrf: string): Response {
  return html(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Push Control</title><style>
  :root{font-family:Inter,system-ui,sans-serif;color:#171b16;background:#e9eadf}*{box-sizing:border-box}body{margin:0}.top{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;padding:16px 4vw;background:#171b16;color:#fff}.brand{font:900 18px ui-monospace,monospace;letter-spacing:.08em}.live{color:#c8ff38}.wrap{width:min(1180px,92vw);margin:36px auto}.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:12px}.modes{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:22px 0 28px}.mode{padding:16px;background:#fffdf5;border:2px solid #171b16}.mode b{display:block;margin-bottom:7px}.mode.recommended{background:#171b16;color:#fff}.card,.panel{background:#fffdf5;border:2px solid #171b16;box-shadow:5px 5px 0 #171b16}.card{padding:16px}.card b{display:block;font:900 30px ui-monospace,monospace;margin-top:8px}.panel{margin-top:28px;padding:20px;overflow:auto}h1,h2{margin-top:0}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}input,button,select{padding:9px 10px;border:2px solid #171b16;background:#fff;font:inherit}button{background:#c8ff38;font-weight:800;cursor:pointer}.danger{background:#ff6038}.muted{color:#666;font-size:13px}table{width:100%;border-collapse:collapse;min-width:900px}th,td{text-align:left;border-bottom:1px solid #aaa;padding:10px 7px;font-size:13px}code{font-size:12px}.pill{padding:3px 7px;border:1px solid;border-radius:20px}.toggle{width:auto}.flash{position:fixed;right:20px;bottom:20px;background:#171b16;color:white;padding:14px;max-width:520px;white-space:pre-wrap}.token{background:#fff2b8;border:3px solid #ff6038;padding:12px;word-break:break-all}@media(max-width:850px){.grid{grid-template-columns:repeat(2,1fr)}.modes{grid-template-columns:1fr}}</style></head><body>
  <header class="top"><span class="brand">PUSH/CONTROL <span class="live">● LIVE</span></span><button onclick="logout()">退出</button></header><main class="wrap"><h1>Agent 投递控制台</h1><div class="modes"><article class="mode recommended"><b>MCP + Hook</b><span>生命周期由 MCP 提交，宿主结束 Hook 保底。推荐 Codex。</span></article><article class="mode"><b>MCP + Skill</b><span>Skill 约束调用顺序，OAuth 隔离身份。适合可安装 Skill 的 MCP Agent。</span></article><article class="mode"><b>纯 Skill / Webhook</b><span>长期 Agent Token + HTTPS 脚本。适合无法导入 MCP 的环境。</span></article></div><div class="row" style="margin-bottom:22px"><button onclick="sendTest()">发送链路测试</button><span class="muted">创建 Agent 后，在对应客户端完成接入；来源名称和推送策略在下方统一管理。</span></div><div id="stats" class="grid"></div>
  <section class="panel"><h2>新增 Agent</h2><div class="row"><input id="name" placeholder="例如 Codex-MacBook"><input id="source" placeholder="来源标签（可选）"><button onclick="createAgent()">生成独立 Token</button></div><div id="token"></div></section>
  <section class="panel"><h2>Agent 与策略</h2><p class="muted">修改开关后点击该行“保存”。OAuth Agent 可生成专用 Hook Token，让 MCP 与 Hook 共用同一身份；Token 仅显示一次。</p><div id="agents"></div></section>
  <section class="panel"><div class="row"><h2 style="margin:0">v3 对账与投递</h2><button onclick="loadShadow()">刷新</button></div><p class="muted">全局开关与每个 Agent 的投递链路共同控制灰度；revision lag 应最终回到 0。</p><div id="shadowStats" class="grid"></div><div id="deliveryTimeline"></div><div id="shadowDiffs"></div></section>
  <section class="panel"><div class="row"><h2 style="margin:0">最近投递</h2><select id="status" onchange="loadEvents()"><option value="">全部状态</option><option>queued</option><option>retry_scheduled</option><option>delivered</option><option>failed</option><option>suppressed</option><option>enqueue_failed</option></select><button onclick="loadEvents()">刷新</button></div><div id="events"></div></section></main><div id="flash"></div>
  <script>const csrf=${JSON.stringify(csrf)};const api=async(path,options={})=>{options.headers={...(options.headers||{}),'X-CSRF-Token':csrf};const r=await fetch(path,options);const j=await r.json();if(!r.ok)throw new Error(j.message||'请求失败');return j};const say=x=>{const e=document.querySelector('#flash');e.className='flash';e.textContent=x;setTimeout(()=>{e.className='';e.textContent=''},5000)};const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function load(){const [s,a]=await Promise.all([api('/api/admin/summary'),api('/api/admin/agents')]);document.querySelector('#stats').innerHTML=Object.entries(s).map(([k,v])=>'<div class="card"><span>'+esc(k)+'</span><b>'+v+'</b></div>').join('');document.querySelector('#agents').innerHTML='<table><tr><th>Agent</th><th>任务来源名称</th><th>投递链路</th><th>总开关</th><th>开始</th><th>进度</th><th>完成</th><th>失败</th><th>取消</th><th>最短秒数</th><th>正文</th><th>Hook Token</th><th></th></tr>'+a.items.map(x=>'<tr data-id="'+esc(x.id)+'"><td><b>'+esc(x.displayName)+'</b><br><code>'+esc(x.id)+'</code><br><span class="muted">'+esc(x.tokenHint||'仅 OAuth')+'</span></td><td><input data-k="sourceLabel" value="'+esc(x.sourceLabel)+'" maxlength="80" style="width:150px"></td><td><select data-k="deliveryMode"><option value="shadow" '+(x.deliveryMode==='shadow'?'selected':'')+'>旧链路</option><option value="v3" '+(x.deliveryMode==='v3'?'selected':'')+'>v3 灰度</option></select></td>'+['notificationsEnabled','notifyStarted','notifyProgress','notifyCompleted','notifyFailed','notifyCanceled'].map(k=>'<td><input class="toggle" data-k="'+k+'" type="checkbox" '+(x[k]?'checked':'')+'></td>').join('')+'<td><input data-k="minimumDurationSeconds" type="number" min="0" max="604800" value="'+x.minimumDurationSeconds+'" style="width:90px"></td><td><input class="toggle" data-k="includeFullContent" type="checkbox" '+(x.includeFullContent?'checked':'')+'></td><td><button onclick="rotateToken(this)">'+(x.tokenHint?'轮换':'生成')+'</button></td><td><button onclick="save(this)">保存</button></td></tr>').join('')+'</table>';await Promise.all([loadEvents(),loadShadow()])}
  async function save(btn){const tr=btn.closest('tr'),body={};tr.querySelectorAll('[data-k]').forEach(e=>body[e.dataset.k]=e.type==='checkbox'?e.checked:e.type==='number'?Number(e.value):e.value);await api('/api/admin/agents/'+encodeURIComponent(tr.dataset.id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});say('策略已保存');load()}
  async function createAgent(){const j=await api('/api/admin/agents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({display_name:document.querySelector('#name').value,source_label:document.querySelector('#source').value||undefined})});document.querySelector('#token').innerHTML='<div class="token"><b>请立即复制，只显示一次：</b><br><code>'+esc(j.token)+'</code></div>';await load()}
  async function rotateToken(btn){const tr=btn.closest('tr');if(!confirm('生成新 Hook Token 后，旧 Token 会立即失效。继续吗？'))return;const j=await api('/api/admin/agents/'+encodeURIComponent(tr.dataset.id)+'/token',{method:'POST'});document.querySelector('#token').innerHTML='<div class="token"><b>'+esc(j.agent.displayName)+' 的 Hook Token（仅显示一次）：</b><br><code>'+esc(j.token)+'</code></div>';say('Hook Token 已生成，请立即保存');await load()}
  async function loadEvents(){const status=document.querySelector('#status').value;const j=await api('/api/admin/deliveries?limit=50'+(status?'&status='+status:''));document.querySelector('#events').innerHTML='<table><tr><th>时间</th><th>Agent / Task</th><th>状态</th><th>标题</th><th>投递</th><th>操作</th></tr>'+j.items.map(x=>'<tr><td>'+new Date(x.createdAt*1000).toLocaleString()+'</td><td><code>'+esc(x.agentId)+'<br>'+esc(x.taskId)+'</code></td><td>'+esc(x.state)+'</td><td>'+esc(x.title)+'</td><td><span class="pill">'+esc(x.deliveryStatus)+'</span><br><span class="muted">'+esc(x.lastError||x.suppressionReason||'')+'</span></td><td>'+(['failed','enqueue_failed'].includes(x.deliveryStatus)?'<button class="danger" data-id="'+esc(x.id)+'" onclick="retry(this.dataset.id)">重试</button>':'')+'</td></tr>').join('')+'</table>'}
  async function loadShadow(){const j=await api('/api/admin/shadow?limit=50');document.querySelector('#shadowStats').innerHTML=Object.entries(j.summary).map(([k,v])=>'<div class="card"><span>'+esc(k)+'</span><b>'+v+'</b></div>').join('');document.querySelector('#deliveryTimeline').innerHTML='<h3>v3 卡片投递</h3><table><tr><th>Agent / Task</th><th>模式</th><th>标题</th><th>Revision</th><th>失败</th><th>最近结果</th></tr>'+j.timeline.map(x=>'<tr><td><code>'+esc(x.agentId)+'<br>'+esc(x.externalTaskId)+'</code></td><td>'+esc(x.deliveryMode)+'</td><td>'+esc(x.title)+'</td><td>'+x.acceptedRevision+' / '+x.desiredRevision+'（lag '+x.revisionLag+'）</td><td>'+x.failureCount+'</td><td>'+esc(x.lastError||x.providerCode||'尚未投递')+'</td></tr>').join('')+'</table>';document.querySelector('#shadowDiffs').innerHTML=j.total?'<h3>影子差异</h3><table><tr><th>类型</th><th>Agent / Task</th><th>Revision</th><th>旧值</th><th>v3 值</th></tr>'+j.items.map(x=>'<tr><td>'+esc(x.kind)+'</td><td><code>'+esc(x.agentId)+'<br>'+esc(x.taskId)+(x.eventId?'<br>'+esc(x.eventId):'')+'</code></td><td>'+x.revision+'</td><td>'+esc(x.legacyValue)+'</td><td>'+esc(x.shadowValue)+'</td></tr>').join('')+'</table>':'<p>未发现影子差异。</p>'}
  async function retry(id){await api('/api/admin/deliveries/'+encodeURIComponent(id)+'/retry',{method:'POST'});say('已重新入队');load()}async function sendTest(){const j=await api('/api/admin/test',{method:'POST'});say('测试事件已接收：'+j.delivery_status);load()}async function logout(){await api('/admin/logout',{method:'POST'});location='/admin'}load().catch(e=>say(e.message));</script></body></html>`);
}

function requireMutation(request: Request, session: Session): Response | null {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin)
    return json({ success: false, message: "Invalid origin" }, 403);
  if (request.headers.get("X-CSRF-Token") !== session.csrf)
    return json({ success: false, message: "Invalid CSRF token" }, 403);
  return null;
}

export async function handleAdminRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/admin/login" && request.method === "POST") {
    const form = await request.formData();
    const password = form.get("password");
    if (typeof password !== "string" || !(await constantTimeEqual(password, env.OWNER_PASSWORD)))
      return loginPage("管理员口令不正确");
    const { cookie } = await makeSession(env.OWNER_PASSWORD);
    return new Response(null, {
      status: 303,
      headers: { Location: "/admin", "Set-Cookie": cookie },
    });
  }
  if (!url.pathname.startsWith("/admin") && !url.pathname.startsWith("/api/admin")) return null;
  const session = await readSession(request, env.OWNER_PASSWORD);
  if (!session)
    return url.pathname === "/admin"
      ? loginPage()
      : json({ success: false, message: "Unauthorized" }, 401);
  if (url.pathname === "/admin" && request.method === "GET") return dashboardPage(session.csrf);
  if (request.method !== "GET") {
    const invalid = requireMutation(request, session);
    if (invalid) return invalid;
  }
  if (url.pathname === "/admin/logout" && request.method === "POST")
    return json({ success: true }, 200, {
      "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
    });
  if (url.pathname === "/api/admin/summary" && request.method === "GET")
    return json(await getDashboardSummary(env.DB));
  if (url.pathname === "/api/admin/shadow" && request.method === "GET") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 200);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
    const [summary, differences, timeline] = await Promise.all([
      getShadowSummary(env.DB),
      listShadowDiffs(env.DB, limit, offset),
      listV3DeliveryTimeline(env.DB, limit),
    ]);
    return json({ summary, timeline, ...differences });
  }
  if (url.pathname === "/api/admin/agents" && request.method === "GET") {
    const [agents, modes] = await Promise.all([listAgents(env.DB), listAgentDeliveryModes(env.DB)]);
    return json({
      items: agents.map((agent) => ({ ...agent, deliveryMode: modes[agent.id] ?? "shadow" })),
    });
  }
  if (url.pathname === "/api/admin/agents" && request.method === "POST") {
    const input = createAgentSchema.parse(await readJson(request));
    const token = `hpa_${randomToken(32)}`;
    const slug =
      input.display_name
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-|-$/gu, "")
        .slice(0, 40) || "agent";
    const id = `${slug}-${randomToken(5)}`;
    const tokenHash = await sha256Hex(token);
    const tokenHint = `${token.slice(0, 8)}…${token.slice(-4)}`;
    const agent = await createAgent(env.DB, {
      id,
      displayName: input.display_name,
      sourceLabel: input.source_label ?? input.display_name,
      tokenHash,
      tokenHint,
    });
    await recordCredential(env.DB, agent, {
      kind: "token",
      secretHash: tokenHash,
      hint: tokenHint,
    });
    await recordAdminAudit(env.DB, "agent.create", id, { displayName: agent.displayName });
    return json({ success: true, agent, token }, 201);
  }
  const agentMatch = url.pathname.match(/^\/api\/admin\/agents\/([^/]+)$/u);
  if (agentMatch && request.method === "PATCH") {
    const id = decodeURIComponent(agentMatch[1]!);
    const parsed = updateAgentSchema.parse(await readJson(request));
    if (parsed.deliveryMode === "v3" && String(env.V3_DELIVERY) !== "true")
      return json({ success: false, message: "V3_DELIVERY is disabled" }, 409);
    const { deliveryMode, ...legacyFields } = parsed;
    const update = Object.fromEntries(
      Object.entries(legacyFields).filter((entry) => entry[1] !== undefined),
    );
    const agent = await updateAgent(env.DB, id, update);
    if (!agent) return json({ success: false, message: "Agent not found" }, 404);
    if (deliveryMode && !(await setAgentDeliveryMode(env.DB, id, deliveryMode)))
      return json({ success: false, message: "v3 shadow row not initialized" }, 409);
    await recordAdminAudit(env.DB, "agent.update", id);
    return json({ success: true, agent });
  }
  const tokenMatch = url.pathname.match(/^\/api\/admin\/agents\/([^/]+)\/token$/u);
  if (tokenMatch && request.method === "POST") {
    const id = decodeURIComponent(tokenMatch[1]!);
    const token = `hpa_${randomToken(32)}`;
    const tokenHash = await sha256Hex(token);
    const tokenHint = `${token.slice(0, 8)}…${token.slice(-4)}`;
    const agent = await setAgentToken(env.DB, id, tokenHash, tokenHint);
    if (!agent) return json({ success: false, message: "Agent not found" }, 404);
    await recordCredential(env.DB, agent, {
      kind: "token",
      secretHash: tokenHash,
      hint: tokenHint,
    });
    await recordAdminAudit(env.DB, "agent.token.rotate", id);
    return json({ success: true, agent, token });
  }
  if (url.pathname === "/api/admin/deliveries" && request.method === "GET") {
    const rawStatus = url.searchParams.get("status");
    const status =
      rawStatus && DELIVERY_STATUSES.includes(rawStatus as (typeof DELIVERY_STATUSES)[number])
        ? (rawStatus as (typeof DELIVERY_STATUSES)[number])
        : undefined;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 200);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
    return json(await listEvents(env.DB, { limit, offset, ...(status ? { status } : {}) }));
  }
  const retryMatch = url.pathname.match(/^\/api\/admin\/deliveries\/([^/]+)\/retry$/u);
  if (retryMatch && request.method === "POST") {
    const id = decodeURIComponent(retryMatch[1]!);
    const event = await retryEvent(env, id);
    await recordAdminAudit(env.DB, "delivery.retry", id);
    return json({ success: true, event });
  }
  if (url.pathname === "/api/admin/test" && request.method === "POST") {
    const agent = await ensureSystemAgent(env.DB, "admin-test", "Admin Test", "Push Control");
    const now = Math.floor(Date.now() / 1_000);
    const output = await submitTaskEvent(
      env,
      agent,
      {
        task_id: `test:${now}`,
        state: "completed",
        title: "推送链路测试",
        summary: "管理端测试消息",
        content: "D1 → Queue → 华为负一屏链路测试",
        force_notify: false,
      },
      { bypassNotificationPolicy: true },
    );
    await recordAdminAudit(env.DB, "delivery.test", output.event_id);
    return json(output, 202);
  }
  return json({ success: false, message: "Not found" }, 404);
}
