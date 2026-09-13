# 纯 Skill / Webhook

适用于不能添加自定义 MCP，但允许安装 Skill、运行 Python 和访问公网的 Agent。发布包为 `huawei-task-push-webhook-plugin.zip`，包内不含真实凭据。

## 1. 创建独立 Agent

登录管理后台，在“新增 Agent”中创建身份。Token 只显示一次；每个客户端使用独立 Token，便于单独停用和审计。

## 2. 配置 Skill

解压发布包后，在 Skill 目录运行：

```bash
python3 scripts/provision_agent.py \
  --base-url "$WORKER_URL" \
  --display-name "GPT Work" \
  --source-name "GPT Work"
```

脚本会交互式读取管理员口令，并把长期凭据写入同目录 `.env`，权限为 `600`。不要把口令放入命令行历史，也不要上传 `.env`。

需要轮换 Token 时在同一目录运行原命令并增加 `--rotate`。脚本会在原 Agent 内使旧 Token 失效并保存新 Token，不会创建新 Agent，因此既有任务的卡片身份和后台策略保持不变。

## 3. 生命周期

Skill 在实质工作前发送 `started`，只在重要阶段发送 `progress`，等待必要输入时发送 `waiting`，并在结束前发送一个终态。同一张卡复用 `task_id`；同一次执行复用 `run_id`，以后重新运行同一任务时换一个新的 `run_id`。

```bash
python3 scripts/push_event.py started --title "任务标题"
python3 scripts/push_event.py progress --task-id "返回的-task-id" --run-id "返回的-run-id" --title "任务标题" --progress 60 --content "已完成主要检查"
python3 scripts/push_event.py completed --task-id "返回的-task-id" --run-id "返回的-run-id" --title "任务标题" --content-file "/path/to/result.md"
```

客户端会先把完整事件写入权限为 `600` 的本地 `.outbox`，再发往 `/api/v3/events`。网络、限流或 5xx 失败会保留同一个 `event_id`；恢复后运行 `python3 scripts/push_event.py flush`。可用 `status EVENT_ID` 查询 revision/provider 状态，用 `retry EVENT_ID` 重试服务端已判定失败的投递，用 `doctor` 检查 Agent 身份和灰度模式而不创建手机卡。

HTTP `202` 与 `acceptance=recorded` 表示事件已由服务记录，不代表华为 gateway 已接受或手机已显示。最终以 `accepted_revision == desired_revision`、provider code 和手机实际显示分别判断。

普通 Skill 不能强制绕过后台通知开关、静音、状态或去重策略。管理员链路测试使用独立的内部权限通道。
