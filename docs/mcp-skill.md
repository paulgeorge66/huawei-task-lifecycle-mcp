# MCP + Skill

适合已经支持远程 MCP、并能安装 Skill 或固定系统指令的 Agent。

## 接入

1. 将 MCP URL 设置为 `$WORKER_URL/mcp`。
2. 完成 OAuth 2.1 授权；每个客户端使用独立 OAuth 身份。
3. 安装 `huawei-task-lifecycle` Skill。
4. 在管理后台设置来源名称，并按需要开启开始和进度通知。

Skill 的生命周期约束：

```text
huawei_task_start
  -> huawei_task_progress | huawei_task_wait（可选，可多次）
  -> huawei_task_complete | huawei_task_fail | huawei_task_cancel
```

所有调用必须复用同一个 `task_id`、本次执行的 `run_id` 和稳定标题。每次调用前生成新的 `event_id` 并保留用于查询/重试；不得为了获取 ID 重复调用 start 或终态。再次运行同一任务时保留 `task_id` 并换新 `run_id`。只有真实改名才调用 `huawei_task_rename`。终态的 `content` 放入适合展示给用户的最终结果，不得包含模型隐藏推理、凭据或 OAuth Code。

## Gemini Spark

Gemini Spark 的自定义应用会读取 MCP server instructions 和工具描述。普通 Gemini 对话不提供该自定义 MCP 入口；需要在 Spark 中 `@Huawei Task Lifecycle` 调用。当前项目已经把相同的生命周期规则写入服务端，因此不能导入本地 Skill 时也能使用；但模型级工具调用不是宿主级 Hook，不能承诺每个任务绝对调用。连接后可在“已关联的应用”中确认 `Huawei Task Lifecycle` 已启用并同步全部工具；Gemini 会要求用户逐次确认写操作。

界面和账号可用范围可能变化；配置时同时核对 [Google 官方自定义 MCP 说明](https://support.google.com/gemini/answer/17209137)。不要把 OAuth client secret 放入提示词或公开截图。
