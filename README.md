# Huawei Task Lifecycle MCP

[English](README.en.md) · 中文

将多个 AI Agent 的任务生命周期汇聚到华为负一屏：一项任务对应一张持续更新的卡片；一次执行对应一个 `run_id`；开始、进度、等待、重命名和终态都复用同一个 `task_id`。

项目运行在 Cloudflare Workers，使用 OAuth/KV 管理 MCP 身份、D1 保存任务与审计记录、Queues 完成异步投递和失败重试，并提供管理后台统一配置 Agent 来源名称和通知策略。

> 非官方社区项目，与华为、OpenAI、Google 无隶属或背书关系。产品名称和商标归各自权利人所有。

本项目提供的是**自建服务源码**，不是公共托管推送服务。部署者自行管理 Cloudflare、华为授权、OAuth、Agent Token、数据留存和访问权限。

## 三种接入方式

| 方式                   | 适用场景                                     | 特点                                                    |
| ---------------------- | -------------------------------------------- | ------------------------------------------------------- |
| **MCP + Hook**         | Codex 等支持 MCP 和宿主 Hook 的客户端        | MCP 上报语义状态；Hook 记录本轮结束并检测遗漏           |
| **MCP + Skill**        | 支持远程 MCP 与 Skill/固定指令的 Agent       | OAuth 身份隔离，Skill 约束每个任务的调用顺序            |
| **纯 Skill / Webhook** | 不能添加 MCP，但能运行脚本的 GPT Work 等环境 | 内置 Python 客户端，通过长期独立 Agent Token 调用 HTTPS |

详细选择说明见 [三种接入方式](docs/integration-modes.md)。

## 核心能力

- 生命周期：`started`、`progress`、`waiting`、`completed`、`failed`、`canceled`，以及不改变状态的 `renamed` 和 `turn.completed` 事实。
- 实测确认并已实现：华为 `scheduleTaskId` 决定卡片，`msgId` 标识事件。同一任务的 `scheduleTaskId` 稳定；每个事件使用独立 `msgId`，重试同一事件时复用。
- 每个事件拥有独立 `event_id`，支持幂等、状态查询和失败重试。
- v3 区分稳定任务与单次运行：新 `run_id` 可以有意重新开启已结束任务，旧 run 的迟到事件不会让卡片回退。
- v3 将事件、单调 revision、卡片投影与 outbox 在同一 D1 批次提交；同一 `event_id` 内容冲突返回 HTTP 409。
- v3 支持按 Agent 灰度：请求后立即尝试入队，Cron 每分钟补偿；每张卡使用 lease 串行发送，并以 desired/accepted revision 抵抗 Queue 的重复与乱序。
- Agent 独立 OAuth 或 Token、来源名称、状态开关、最短时长、去重窗口、静音项目和正文上限。
- Queue 异步投递、指数退避和 DLQ；永久授权或参数错误不会无限重试。
- 管理后台提供 Agent 创建、策略修改、投递历史、失败重试、链路测试和 v1/v3 影子差异对账。
- 推送内容支持摘要或最多 5000 字符的用户可见正文，不包含模型隐藏推理；Huawei gateway 接受与设备实际显示明确分开。

默认推送完成、失败和取消；开始与进度会记录但不通知，可在后台按 Agent 开启。

## 从哪里开始

1. 阅读 [入门部署与首条通知](docs/getting-started.md)，在自己的 Cloudflare 账号部署 Worker。
2. 按客户端能力从下表选择一种接入，不确定时使用 MCP + Hook。
3. 运行 `doctor` 或查看 `/health/ready`，再执行一项不含敏感信息的短任务。
4. 在后台核对 `accepted_revision == desired_revision`，最后以手机实际显示为准。

| 你的客户端 | 选择 | 下一步 |
| --- | --- | --- |
| 支持远程 MCP，也有完成 Hook | MCP + Hook | [Codex 推荐教程](docs/mcp-hook.md) |
| 支持远程 MCP，但没有 Hook | MCP + Skill | [MCP / Gemini Spark 教程](docs/mcp-skill.md) |
| 不能接 MCP，但能运行 Python | 纯 Skill / Webhook | [纯 Skill 教程](docs/skill-webhook.md) |

更完整的差异和保证边界见 [接入方式选择](docs/integration-modes.md)，多台电脑见 [多 Agent 接入](docs/multi-agent.md)。

## 快速命令

### MCP 客户端

```bash
codex mcp add huawei-push --url "$WORKER_URL/mcp"
codex mcp login huawei-push
```

安装 `skills/huawei-task-lifecycle` 后，Agent 会在实质任务开始前提交 `huawei_task_start`，并在结束前提交唯一终态。

### 纯 Skill / Webhook

```bash
npm run package:skills
```

将 `dist/huawei-task-push-webhook-plugin.zip` 安装到目标 Agent。发布包不含 `.env`；首次使用需运行包内 `scripts/provision_agent.py` 生成独立长期凭据。

## 文档

完整导航见 [文档索引](docs/README.md)。首次使用者通常只需阅读前三项：

- [入门部署与首条通知](docs/getting-started.md)
- [MCP + Hook：Codex 推荐方案](docs/mcp-hook.md)
- [MCP + Skill](docs/mcp-skill.md)
- [纯 Skill / Webhook](docs/skill-webhook.md)
- [多台电脑与多 Agent 接入](docs/multi-agent.md)
- [Cloudflare 自建部署](docs/deployment.md)
- [v3 HTTP API](docs/api-v3.md)
- [隐私与数据流](docs/privacy.md)
- [故障排查](docs/troubleshooting.md)

## MCP 工具

- `huawei_task_start`、`huawei_task_progress`、`huawei_task_wait`、`huawei_task_rename`
- `huawei_task_complete`、`huawei_task_fail`、`huawei_task_cancel`
- `huawei_task_event`：通用生命周期提交
- `huawei_get_delivery_status`、`huawei_list_deliveries`、`huawei_retry_delivery`
- `push_huawei_task`：旧版完成推送兼容入口

MCP 使用 OAuth 2.1。每个 OAuth 客户端自动映射为独立 Agent，只能查询和重试自己的事件。每台电脑建议使用独立 Agent/凭据，以便来源命名、停用、轮换与故障定位互不影响；一个 Worker 可同时承载任意数量的 Agent。
普通 Agent 不能绕过后台通知策略；停用 Agent 后，新提交、失败重试和队列中尚未投递的消息都会被阻止。

## 服务端点

| 路径                     | 用途                                      |
| ------------------------ | ----------------------------------------- |
| `/mcp`                   | Streamable HTTP MCP                       |
| `/api/v3/events`         | 统一 Agent Token 事件入口                 |
| `/api/v3/events/:id`     | 投递状态查询                              |
| `/api/v3/events/:id/retry` | 失败事件重试                            |
| `/api/v3/doctor`         | 无推送的身份与配置诊断                    |
| `/hooks/agent`           | v1 独立 Agent Token 兼容 webhook          |
| `/hooks/codex`           | Codex `agent-turn-complete` 兼容 webhook  |
| `/admin`                 | 管理后台、v1/v3 对账与灰度投递状态        |
| `/health/live`           | 进程存活探针                              |
| `/health/ready`          | D1、Queue 与 secret binding 就绪探针      |
| `/api/info`              | 公开服务元数据与接入方式                  |

## 开发

```bash
npm ci
cp wrangler.example.jsonc wrangler.jsonc
npm run cf-typegen
npm run check
npm run release:verify
npm run dev
```

真实 `wrangler.jsonc`、`.dev.vars`、Skill `.env` 和 `dist/` 均被 Git 忽略。部署步骤见 [docs/deployment.md](docs/deployment.md)。

## 能力边界

- 华为负一屏是单向通知；手机回复或点击不会自动回传 Agent。
- MCP/Skill 指令能提高模型主动上报率，但只有宿主 Hook 能提供系统级结束兜底。
- HTTP `202` 表示事件已经持久化，不等于华为接受或手机显示；请根据 `event_id` 或后台的 revision lag 查询。默认 Agent 仍走旧链路，只有同时开启全局 `V3_DELIVERY` 且在后台选择“v3 灰度”的 Agent 才走 v3 投递链路；两条链路互斥，不会双投。
- 不需要常驻电脑或额外中转服务器；Worker、D1、Queue 和 KV 即为云端中转层。
- 服务会把配置允许的标题、状态和正文发送到部署者的 Cloudflare 资源及华为接口；请先阅读 [隐私与数据流](docs/privacy.md)，不要把秘密或不适合出现在锁屏/负一屏的内容交给通知 Skill。

## 许可与贡献

版本变更见 [CHANGELOG](CHANGELOG.md)，贡献与安全边界见 [CONTRIBUTING](CONTRIBUTING.md) 和 [SECURITY](SECURITY.md)，依赖许可证摘要见 [第三方声明](THIRD_PARTY_NOTICES.md)。本项目采用 [Apache License 2.0](LICENSE)。
