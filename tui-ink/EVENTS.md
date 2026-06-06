# TuiEvent 类型一览

来源：`src/protocol.ts` 第 74-109 行，`TuiEvent` 联合类型的所有子类型。

| type | 方向 | 说明 |
|------|------|------|
| `todo.set` | agent → TUI | 声明/更新 todo 列表，附带 TodoItem[] |
| `step` | agent → TUI | 报告当前执行步骤（≤20 字） |
| `tool.call` | agent → TUI | 调用工具请求，含工具名和参数 |
| `tool.result` | agent → TUI | 工具执行结果回传 TUI |
| `message` | agent → TUI | 发送消息（可指定 to: user / leader / agent_id） |
| `spawn` | agent → TUI | Leader 派生子 agent（含 DispatchSpec） |
| `agent.done` | agent → TUI | agent 任务完成或放弃 |
| `agent.error` | agent → TUI | agent 报告不可恢复的错误 |
| `agent.state` | agent → TUI | 报告自身运行状态（idle/run/wait/done/warn/err） |
| `unit.handup` | agent → TUI | Worker 向 Leader 汇报完成情况（含 findings/flags） |
| `memory.snapshot` | agent → TUI | 记忆快照写入通知（路径+大小） |
| `shutdown.start` | agent → TUI | agent 开始关闭流程 |
| `pm.alert` | agent → TUI | ProcessManager 告警（warn/error） |
| `proposal.new` | agent → TUI | 提案通知（角色边界/原则修改） |
| `task.notification` | agent → TUI | 子任务完成通知（含成功/失败+证据） |
| `proposal.decision` | agent → TUI | 提案审批结果（apply/reject） |
| `tool.approved` | leader → TUI | Leader 审批通过 Worker 的 Bash 调用 |
| `tool.rejected` | leader → TUI | Leader 审批拒绝 Worker 的 Bash 调用 |

> 共 18 种事件类型，均为 agent → TUI 方向。其中 `tool.approved` / `tool.rejected` 特指 Leader 发出的审批指令，其余事件由对应 agent 发出。
