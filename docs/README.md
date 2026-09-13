# 文档索引

# 使用文档

- [入门部署与首条通知](getting-started.md)：从空 Cloudflare 账号到第一张测试卡。
- [接入方式选择](integration-modes.md)：MCP + Hook、MCP + Skill、纯 Skill / Webhook 的保证与限制。
- [MCP + Hook](mcp-hook.md)：Codex 推荐方案。
- [MCP + Skill](mcp-skill.md)：Gemini Spark 等远程 MCP 客户端。
- [纯 Skill / Webhook](skill-webhook.md)：GPT Work 等无法导入 MCP、但能运行 Python 的环境。
- [多台电脑与多 Agent](multi-agent.md)：凭据隔离、来源命名与轮换。
- [故障排查](troubleshooting.md)：从 Worker 接收、队列、华为接受到手机显示逐层定位。
- [生产部署](deployment.md)：资源、Secret、迁移、灰度和回退。
- [v3 HTTP API](api-v3.md)：事件、状态查询、重试和 doctor 契约。
- [隐私与数据流](privacy.md)：保存与发送哪些数据，以及使用者应避免上报的内容。
