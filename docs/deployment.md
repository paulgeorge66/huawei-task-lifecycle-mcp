# 自建部署

第一次部署请先按 [入门部署与首条通知](getting-started.md) 操作；本页记录生产配置、灰度和回退细节。

## 前置条件

- Cloudflare Workers、D1、KV 与 Queues 权限
- Node.js 和 Wrangler 4
- 华为负一屏动态消息授权码

## 资源配置

```bash
npm ci
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV
npx wrangler d1 create huawei-task-lifecycle-db
npx wrangler queues create huawei-task-delivery
npx wrangler queues create huawei-task-delivery-dlq
```

把输出的 KV 与 D1 ID 写入本地 `wrangler.jsonc`。该文件被 Git 忽略；公开模板是 `wrangler.example.jsonc`。

同时设置：

- `PUBLIC_ORIGIN`：当前 Worker 或自定义域名的 HTTPS origin，不带末尾 `/`。
- `PUBLIC_REPOSITORY_URL`：你的仓库地址。
- `DELIVERY_QUEUE_NAME` 与 `DEAD_LETTER_QUEUE_NAME`：上面创建的 Queue 名称。

## Secrets

```bash
npx wrangler secret put HUAWEI_AUTH_CODE
npx wrangler secret put OWNER_PASSWORD
npx wrangler secret put CODEX_WEBHOOK_TOKEN
```

`CODEX_WEBHOOK_TOKEN` 只用于旧版共享 Token 兼容；新客户端应使用后台创建的独立 Agent Token。

## 数据库与部署

```bash
npx wrangler d1 migrations apply huawei-task-lifecycle-db --remote
npm run check
npm run deploy
```

`V3_SHADOW_WRITE=true` 启用原子双写和后台对账。首次部署时保持 `V3_DELIVERY=false`，应用全部迁移并确认后台无差异。`0004_v3_protocol.sql` 新增 ingress/trace，并把现有 Agent/Token 镜像到 v3 身份表。配置还必须包含每分钟 Cron：`"triggers": { "crons": ["* * * * *"] }`。

灰度顺序：

1. 以 `V3_DELIVERY=false` 部署并运行完整检查。
2. 将全局变量改为 `true` 后部署；此时所有 Agent 仍是“旧链路”，手机行为不变。
3. 只把固定测试 Agent 切为“v3 灰度”，发送一个独立测试任务，确认手机只有一张卡且后台 `acceptedRevision = desiredRevision`。
4. 观察 Queue/DLQ 与后台 timeline 后，再逐 Agent 放量。

紧急回退可关闭全局开关或把单个 Agent 改回“旧链路”。消费端与 Cron 都会把尚未接受的 v3 事件恢复到旧队列；v3 表保留用于审计。

部署后检查 `/health/live`、`/health/ready`、`/api/info`、`/` 和 `/admin`。OAuth metadata、表单来源校验、首页与 API info 都从 `PUBLIC_ORIGIN` 绑定读取；更换域名后修改配置并重新部署即可，不需要改源码。

部署前运行 `npm run release:verify`。它会重建 Skill 包、校验白名单与 SHA-256、扫描 tracked/package 内容中的凭据模式、检查文档链接和迁移序号，并做 Wrangler dry-run。

生产资源名、账号 ID、Worker 域名和 OAuth redirect 只应存在于被 Git 忽略的本地配置或 Cloudflare 控制面。公开 Issue、日志和截图必须脱敏。数据流与留存边界见 [隐私说明](privacy.md)。
