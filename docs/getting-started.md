# 入门部署与首条通知

本教程面向第一次接触该项目的自建用户。完成后，你会拥有一个只属于自己的 Worker、D1、KV、Queue 和管理后台，并能发送一条不含敏感信息的测试任务。

## 1. 准备

需要：

- 可使用 Workers、D1、KV 和 Queues 的 Cloudflare 账号；
- Node.js 24、Python 3.10+ 和已登录的 Wrangler 4；
- 从自己的华为负一屏动态管理中取得的授权码；
- 一个稳定的 HTTPS Worker 域名。

本项目没有公共共享服务器。不要把华为授权码、管理员口令、Agent Token 或 OAuth secret 粘贴到 Issue、聊天记录或命令参数中。

## 2. 创建 Cloudflare 资源

```bash
npm ci
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV
npx wrangler d1 create huawei-task-lifecycle-db
npx wrangler queues create huawei-task-delivery
npx wrangler queues create huawei-task-delivery-dlq
```

把 KV/D1 返回的 ID 写进本地 `wrangler.jsonc`。同时填写：

- `PUBLIC_ORIGIN`：实际 HTTPS origin，不带末尾 `/`；
- `PUBLIC_REPOSITORY_URL`：你的仓库首页；
- Queue 名称：若改名，生产者、消费者和对应变量必须一致。

`wrangler.jsonc` 被 Git 忽略。不要把生产 ID 回填到 `wrangler.example.jsonc`。

## 3. 设置秘密并部署

以下命令会让 Wrangler 在终端中安全读取值：

```bash
npx wrangler secret put HUAWEI_AUTH_CODE
npx wrangler secret put OWNER_PASSWORD
npx wrangler secret put CODEX_WEBHOOK_TOKEN
npx wrangler d1 migrations apply huawei-task-lifecycle-db --remote
npm run check
npm run release:verify
npm run deploy
```

保留公开模板中的 `V3_DELIVERY=false` 完成首次部署。打开以下地址：

```text
https://YOUR-WORKER.example/health/live
https://YOUR-WORKER.example/health/ready
https://YOUR-WORKER.example/admin
```

live 和 ready 都应返回 `ok: true`。管理后台只应通过 HTTPS 访问。

## 4. 选择第一个客户端

- Codex：使用 [MCP + Hook](mcp-hook.md)。
- Gemini Spark 或其他远程 MCP 客户端：使用 [MCP + Skill](mcp-skill.md)。
- GPT Work 或不能导入 MCP、但能执行 Python 的 Agent：使用 [纯 Skill / Webhook](skill-webhook.md)。

每台设备建议使用独立 Agent。只有同一设备的 MCP 与 Hook 需要绑定同一个 Agent，详见 [多 Agent 接入](multi-agent.md)。

## 5. 灰度 v3 并发送首条通知

1. 先连接一个测试 Agent，并在后台把来源名改成容易识别的名称。
2. 将生产 `wrangler.jsonc` 的 `V3_DELIVERY` 改为 `true`，重新部署。
3. 仅把这个测试 Agent 切到 v3 模式。
4. 先运行 `doctor`；它不会创建手机卡。
5. 执行一项标题为“连接测试”、正文不含个人信息的短任务。
6. 在后台确认没有旧链路双投，且 `accepted_revision == desired_revision`。
7. 在手机端确认只有一张可展开卡，标题、来源和正文符合预期。

确认后再逐个 Agent 切换。不要一次性迁移全部客户端。

## 6. 判断成功

- `acceptance=recorded`：服务端已持久化事件；
- `provider_code=0000000000`：华为接口接受请求；
- `accepted_revision == desired_revision`：当前卡片 revision 已被上游接受；
- 手机实际看到卡片：唯一的设备展示证据。

前三项都不能代替最后一项。出现异常时使用 [故障排查](troubleshooting.md)。
