# 三种接入方式

三种方式共用同一个 Worker、D1、Queue 和华为推送出口。区别只在于 Agent 如何提交生命周期，以及是否有宿主级兜底。MCP 描述或 Skill 都不能单独保证模型每次必然调用；只有宿主 Hook 能提供独立于模型决策的结束信号，但 Hook 本身又不知道任务的真实成功/失败语义。

| 方式               | 适用客户端                                    | 生命周期来源                            | 身份凭据                 | 能保证什么 | 主要限制 |
| ------------------ | --------------------------------------------- | --------------------------------------- | ------------------------ | ---------- | -------- |
| MCP + Hook         | Codex 等同时支持 MCP 与结束 Hook 的客户端     | MCP 上报语义状态；Hook 记录宿主本轮结束 | OAuth + 同 Agent Hook Token | 即使模型漏报终态，宿主仍留下 `turn.completed` 事实 | Hook 不知道语义终态，必须由服务端仲裁 |
| MCP + Skill        | Gemini/Codex/其他支持 MCP 与 Skill 的 Agent   | Skill 约束模型调用 MCP                  | OAuth                    | 工具、查询和重试语义最完整 | 仍受模型是否调用和平台写操作确认影响 |
| 纯 Skill / Webhook | GPT Work 或不能添加 MCP、但能运行脚本的 Agent | Skill 调用 HTTPS v3 API                 | 长期独立 Agent Token     | 本地 outbox 保持同一事件重试 | 取决于宿主是否执行 Skill 和允许公网/Python |

## 共同语义

- 一个 Agent 内，稳定的 `task_id` 对应一张华为卡片。
- `started`、`progress`、`waiting`、改名和终态持续更新该卡；不同 Agent 的同名任务不会冲突。
- `run_id` 区分同一任务的不同执行；新 run 可以重新开启终态任务，旧 run 的迟到事件会被判为 stale。
- 每个任务最多有一个终态：`completed`、`failed` 或 `canceled`。
- `event_id` 用于事件幂等和投递状态查询，不用于卡片身份。
- 来源名称由管理后台控制，客户端传入的 `source` 不会覆盖后台设置。

## 如何选择

优先选择 MCP + Hook。宿主没有 Hook 时选择 MCP + Skill；完全不能接入 MCP 时使用纯 Skill / Webhook。MCP + Hook 必须给同一 OAuth Agent 生成 Hook Token，并让两条通道复用同一 `task_id`；身份或任务 ID 任一不同都会生成两张卡。v3 把本轮结束拆成 `turn.completed`，与任务终态分离。切换粒度是 Agent；迁入 v3 的 Agent 只走 v3，其他 Agent 只走兼容链路。

## 用户接入流程

1. 先完成 [自建部署](getting-started.md)，不要使用他人的生产 Worker。
2. 每台设备或独立来源创建一个 Agent；给来源起不含真实姓名、设备序列号或内部主机名的显示名称。
3. 按所选模式连接凭据和配套 Skill。
4. 用 `doctor` 做无卡诊断，再用不含敏感信息的短任务验收。
5. 后台核对事件归属、revision 和 provider code，手机核对卡片数量、标题、来源和正文。
6. 确认一个 Agent 无双投后，再接入下一台设备。

## 失败时如何降级

- MCP 临时不可用：保留 Hook 事实；不要让 Hook猜测失败或完成。
- 网络暂时不可用：纯 Skill/Hook 保存本地 outbox，恢复后使用同一 `event_id` 补发。
- v3 投递异常：按 Agent 切回兼容链路，避免同时开启两条真实发送路径。
- 平台完全不能运行 MCP、Skill 或 Hook：无法可靠自动接入；需要平台提供至少一种可执行扩展点。
