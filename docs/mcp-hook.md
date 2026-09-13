# MCP + Hook：Codex 推荐方案

该模式用 MCP 提交语义生命周期，并用 Codex `notify` 记录宿主的本轮结束事实。Hook 不知道任务是否成功，因此兼容投影会保留同一任务已有的 `started`、`progress`、`failed`、`canceled` 或 `completed` 状态，不再用“本轮结束”覆盖失败或取消。v3 会把 Hook 独立记录为 `turn.completed`：它可以更新可见正文，但不会凭空把语义任务改为完成。每个 Agent 只选择旧链路或 v3 其中之一。

## 1. 连接 MCP

```bash
codex mcp add huawei-push --url "$WORKER_URL/mcp"
codex mcp login huawei-push
```

每台电脑分别登录，服务端会为每个 OAuth 客户端建立独立 Agent。登录后在管理后台设置清晰的来源名称，例如 `Codex · MacBook`。

## 2. 为同一 OAuth Agent 生成 Hook Token

完成 MCP 登录后，进入管理后台找到对应的 OAuth Agent，在该行点击“生成 Hook Token”。不要新建第二个 Agent；只有 MCP 与 Hook 使用同一 Agent 身份、同一 `task_id`，生命周期才会更新同一张卡。

把一次性 Token 保存到权限为 `600` 的 `~/.config/huawei-push-mcp/client.json`：

```json
{
  "webhook_url": "https://example.workers.dev/hooks/codex",
  "agent_url": "https://example.workers.dev/hooks/agent",
  "token": "hpa_REPLACE_ME"
}
```

轮换 Token 会立即使旧 Token 失效。

## 3. 安装配套 Skill

把 `skills/huawei-task-lifecycle` 复制到 Codex 的 Skills 目录，或安装发布包 `huawei-task-lifecycle-skill.zip`。Skill 要求同一任务复用 `task_id`，并在结束前提交唯一终态。Codex Hook 使用 `codex:<thread-id>`；宿主能提供 thread ID 时，MCP 侧也应使用该值。

## 4. 配置完成 Hook

在 Codex 配置中加入：

```toml
notify = ["python3", "/absolute/path/to/clients/codex_notify.py"]
```

若已有 Computer Use 通知器，改用 `clients/codex_notify_mux.py`。该脚本会先调用已有通知器，再发送华为完成事件。

Hook 会在网络请求前把原始完成事件写入权限为 `600` 的本地 `codex-outbox`。每次后续 Hook 会先按时间顺序补发旧事件；服务端用 thread + turn 派生稳定事件 ID，因此未知结果重试不会产生第二个生命周期事件。Hook 仍保持退出码 0，不因通知故障破坏 Codex 的主任务。

Codex 当前的 legacy `notify` JSON 不直接包含侧边栏任务标题。客户端会用 `thread-id` 只读查询本机 `$CODEX_HOME/state_5.sqlite`：优先使用 `threads.name` 中已经生成或自定义的任务标题，并仅在旧版数据库没有该字段时回退到 `threads.title`。第一轮标题若稍晚写入，客户端会短暂重试；Worker 对明确上报的 `thread-title` 赋最高优先级，因此也能纠正数据库中已经保存的旧错误标题。

## 5. 验证

执行一个短任务后，在后台确认 MCP 与 Hook 事件属于同一 Agent，并检查 `task_id`、`delivery_status` 和 v3 对账。两条通道只有在 `task_id` 相同的情况下更新同一张卡。Hook 的 `event_id` 由 Agent、thread 和 turn 稳定生成，同一 turn 重试不会产生重复事件。v3 中应看到 `turn.completed`，并且该事件不会改变语义任务状态。
