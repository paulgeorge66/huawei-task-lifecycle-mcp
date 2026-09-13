# 故障排查

## 完全没有卡片

1. 检查 `/health/ready` 是否为 `ok: true`。
2. 纯 Skill 先运行 `python3 scripts/push_event.py doctor`。
3. 用返回的 `event_id` 查询 `status`，区分未记录、策略 suppressed、等待投递、华为拒绝和已接受。
4. 在后台确认 Agent 已启用、全局 `V3_DELIVERY=true`、该 Agent 已切到 v3，且项目未静音。
5. 检查华为授权状态。HTTP 202 不是手机送达证明。

## 出现两张卡

通常是 MCP 与 Hook 使用了不同 Agent，或同一任务生成了不同 `task_id`。同一设备的两条入口必须共享 Agent 身份，并复用完全相同的 `task_id`。不要通过新建任务 ID 来重试失败事件。

## 卡片不能展开

正式任务必须有非空稳定 `task_id`，服务端才能派生非空 `scheduleTaskId`。历史空任务 ID 卡可能持续提醒但不可展开，不应作为正式行为使用。

## 标题一直是第一句话或通用“已完成”

Codex Hook 应读取本机状态库的生成标题，并把标题同步到华为摘要。确认使用最新版 `clients/codex_notify.py`，Hook JSON 中存在稳定 `thread-id`，且客户端能只读访问 Codex 状态库。任务真正改名时使用 rename 事件，不要用进度文字替代标题。

## Gemini 看不到工具

自定义 MCP 入口位于 Gemini Spark，而不是普通 Gemini 对话。确认已关联应用处的 `Huawei Task Lifecycle` 已启用，在 Spark 中通过 `@Huawei Task Lifecycle` 使用，并允许写操作。工具列表升级后可能需要客户端重新同步连接。

## OAuth 显示 `Invalid form origin`

确认 Worker 的 `PUBLIC_ORIGIN` 与浏览器实际访问的 HTTPS origin 完全一致，不带路径和末尾 `/`，然后重新部署。不要在源码中硬编码当前域名。

## 网络中断后没有补发

纯 Skill 运行 `flush`；Codex Hook 会在下一次通知时自动补发旧 outbox。查询原 `event_id`，不要生成另一个终态事件。只有服务端明确标记 failed 时才调用 retry；suppressed 或已接受事件不需要重试。

## `desired_revision` 大于 `accepted_revision`

短时间差值可能表示正在排队。持续不收敛时检查 outbox 状态、failure count、provider code、Queue/DLQ 和 Cron。历史 shadow 记录不属于当前可执行积压，应以非 shadow outbox 的 revision lag 判断。
