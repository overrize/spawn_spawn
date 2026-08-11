# M1-6d · OrchestratorRuntime 抽取 — 规格 + 验收

> 承接 6a/6b/6c。同一铁律：**只搬位置 + 换 import，输出逐字节不变，golden 25 不动**。
> 6d 把编排规则里**依赖干净、可独立测**的两个函数收进 `src/runtime/OrchestratorRuntime.ts`。

## 0. 一句话定义

| 抽出 | 从哪 | 依赖 | 性质 |
|---|---|---|---|
| `checkMessageLegal(ev, ctx)` | god-file L206-225 | 注入 `{getState, applyEvent, pm}` | 通信矩阵：Worker→user / Worker→Worker 拦截 |
| `replaceAgentForResume(id, ctx)` | god-file L267-273 | 注入 `{agents, secretaries, killedAgents}` + 直接 import `globalBus`/`destroySecretary` | resume 前置换手 |

**不抽 `killAgent`**：它横切 `feishuForks`/`abortAgent`（Feishu 桥 + store），注入面太宽、Feishu 路径 golden 覆盖弱，**留 6e**（与 handler + Feishu 桥一起重排时再动）。

## 1. In-scope

- `checkMessageLegal(ev, ctx)`：逻辑逐字节等价（senderRole 未知→放行；Worker→user 拦截 + `applyEvent(illegal_message)` + `pm.observe(ev)` + 返回 false；Worker→Worker 拦截 + `applyEvent` + false；否则 true）。
- `replaceAgentForResume(id, ctx)`：`agents.get(id)?.kill?.(); agents.delete(id); globalBus.unregisterAgent(id); destroySecretary(secretaries, id); killedAgents.delete(id);`
- 调用点：L1082 `checkMessageLegal(e, { getState, applyEvent, pm })`；L2964 `replaceAgentForResume(id, { agents, secretaries, killedAgents })`。
- god-file 删除这两个顶层定义。

## 2. Out-of-scope（留 6e）

- ❌ `killAgent`（feishuForks/abortAgent 横切）。
- ❌ spawn-dispatch 守卫（guard1 id 占用 / guard2 normalize parent / `pm.preCheckSpawn` 分发）——编织在 leader handler switch，耦合 `opts`/`a`/`secretary`。`preCheckSpawn` 本身**已在 ProcessManager**，不重复抽。
- ❌ parent-child 收敛、resume 编排主流程（在 handler 内）。

## 3. 不变量

| # | 验法 |
|---|---|
| I1 golden 25 逐字节不变 | orchestration-golden 25/25 |
| I2 全量 0 fail | `npm test` |
| I3 typecheck | `npm run typecheck` |
| I4 test:full exit 0 | `npm run test:full` |
| I5 pm-hierarchy 全绿 | 通信矩阵规则不回归 |
| I6 god-file 无 `function checkMessageLegal`/`function replaceAgentForResume` | grep=0 |

## 4. 自动验收用例（新增 `src/tests/orchestrator-runtime-6d.test.ts`）

1. **checkMessageLegal**：Worker→user → false + 记 illegal_message；Worker→Worker → false；Leader→user → true；Leader→Leader → true；未知 sender → true。用 mock ctx 断言 applyEvent 被调用的 code=illegal_message。
2. **replaceAgentForResume**：预置 agents/secretaries/killedAgents（mock），调用后 agent kill 被调、agents/secretaries 删除、killedAgents 删除。
3. **门面 re-export 未变形**：OrchestratorRuntime 现有 re-export（ProcessManager/TurnController/…）不受影响。

## 5. 冒烟（并入 SMOKE-6abc）

- Worker 试图 `message.to=user` → 被拦截并转发父 Leader（P2 场景可顺带看）。
- `/resume <id>` 换手不报错（P6 场景）。

## 6. 验收
- [ ] OrchestratorRuntime 暴露 `checkMessageLegal`/`replaceAgentForResume` + 保留原 re-export。
- [ ] 两处调用点注入 ctx；god-file 顶层定义删除（I6=0）。
- [ ] `orchestrator-runtime-6d.test.ts` 全绿。
- [ ] I1–I5 全绿。
- [ ] 6e 债务登记：`killAgent` + spawn-dispatch 守卫 + parent-child 收敛。
