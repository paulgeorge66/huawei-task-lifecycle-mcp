# 多台电脑与多 Agent 接入

一个 Cloudflare Worker 就是共享中转层，不需要为每台电脑新建 Worker，也不需要常驻 VPS。D1 以 `agent_id` 隔离来源，以 `(agent_id, task_id)` 定位卡片；因此不同 Agent 即使使用相同 `task_id` 也不会覆盖彼此。

## 推荐身份模型

- 每台 Codex 电脑各建一个独立 Agent，例如 `Codex · MacBook`、`Codex · Windows`。
- Gemini Spark 使用自己的 OAuth Agent。
- GPT Work 和其他纯 Skill 客户端使用各自长期 Agent Token。
- 同一台 Codex 的 MCP 与 Hook 必须绑定同一个 Agent；不要为两条入口各建一个身份。
- 多个客户端可以有意共用一个 Agent，但此时会共享来源名称、通知策略和 task 命名空间，不适合需要独立停用或审计的设备。

## 第二台 Codex

在第二台电脑重复 [MCP + Hook 教程](mcp-hook.md)：登录 MCP 后，在后台找到新出现的 OAuth Agent，设置独立来源名称，并从该 Agent 行生成 Hook Token。配置完成后运行一个独立测试任务，核对后台中的 Agent、`task_id`、`event_id`、revision 和华为业务码。

不要复制第一台电脑的 Hook Token，除非明确希望两台电脑作为同一个来源。凭据轮换不会改变 Agent 或历史卡片身份。

## 扩展其他 Agent

支持远程 MCP 的客户端使用 OAuth；能运行脚本但不能连接 MCP 的客户端安装纯 Skill 包；同时具备宿主结束 Hook 的客户端优先采用 MCP + Hook。新接入先保持旧投递模式或单独灰度，确认 `accepted_revision = desired_revision` 且没有双投后再长期启用。

服务端不依赖客户端品牌。只要新适配器能稳定产生 `task_id`、每次执行的 `run_id`、每次事件的唯一 `event_id` 以及用户可见内容，就能复用同一 v3 协议。
