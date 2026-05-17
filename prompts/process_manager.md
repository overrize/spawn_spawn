# Process Manager · 规则规范

> 这是 TypeScript 实现 `src/pm/ProcessManager.ts` 的规则书，不是 LLM prompt。

PM 是无状态规则引擎，订阅全局 TuiEvent 流。
PM **没有** sendCommand 能力——只读 + emit pm.alert。用户通过 TUI 决定是否干预。

---

## 接口

```typescript
class ProcessManager extends EventEmitter {
  preCheckSpawn(ev, parentRole): {ok:true} | {ok:false, code, detail}
  observe(ev: TuiEvent): void
  tick(): void  // 每 10s 调用
  ackAlert(code: string): void
}
```

---

## 同步阻断规则（preCheckSpawn）

在 `startWorker` 入口调用，返回 `{ok:false}` 时中止 spawn 并 emit pm.alert(error)：

| code | 检查条件 |
|---|---|
| `worker_cannot_spawn` | `parentRole === "Worker"` |
| `dispatch_missing_background` | `dispatch?.background` 为空 |
| `dispatch_missing_acceptance` | `dispatch?.acceptance_criteria` 为空数组 |
| `dispatch_missing_stopcond` | `dispatch?.stop_conditions` 为空数组 |
| `depth_exceeded` | `getDepth(parent) + 1 > 3` |
| `fanout_exceeded` | `countRunningChildren(parent) >= 4` |
| `duplicate_goal` | 相同 parent 下已有同 goal 的 RUNNING 子节点 |

---

## 异步告警规则（observe + tick）

### observe（每个事件）

| 触发 | code | severity |
|---|---|---|
| Worker 发 `message.to=user` | `illegal_message` | warn |
| Worker 发 `message.to=<另一个Worker>` | `illegal_message` | warn |
| 100 事件内同一 tool.call.args.path 出现 >10 次 | `loop_suspected` | warn |
| `agent.done` 前 30s 内无 `memory.snapshot` | `memory_not_saved` | error |

### tick（每 10s）

| 触发 | code | severity |
|---|---|---|
| RUNNING agent 年龄 > 30min | `runtime_warn` | warn（每 agent 只告一次） |
| RUNNING agent 年龄 > 60min | `runtime_exceeded` | error + kill |
| 5min 内无 step/todo 事件 | `no_progress` | warn（每 agent 只告一次） |
| Worker RUNNING 但 Secretary 已 TERMINATED | `orphaned_unit` | error |

---

## TUI 集成

- `pm.alert` 事件已在 store.ts 处理，显示在对应 agent 的消息流
- StatusBar 显示 `PM: Nw Ne`（N 个 warn，N 个 error），error > 0 时红色
- `/pm` 命令查看全部未确认告警
- `/pm ack <code>` 确认（移出 UI 列表）

---

## 非干预保证

PM 没有 sendCommand，不能 kill、暂停、发消息给 agent。
runtime_exceeded 时 PM emit kill 事件，由 index.tsx 主循环执行 kill。
所有干预最终由用户通过 TUI 决定。
