# BC-002 · `npm run test:full` 检查全绿但退出码 1 → CI 红

> 状态：已归因，修复任务 M0-7 · 登记 2026-07-21 · 来源：CI 落库后 QA 独立复核
> 性质：**先前存在**（父提交 5961b95~1 同样复现），与 eval 落库提交无关

## 现象

`npm run test:full` 打印「✅ 全部通过 65 通过 / 0 失败」，但进程 **exit code = 1**。
CI（`.github/workflows/ci.yml`）把 `npm run test:full` 作为一步，退出码非零 → **整个 CI job 红**，
即使所有断言通过。`npm test`（node:test，448 绿）和 `test:e2e:full`（exit 0）都正常，唯独 `test:full` 中招。

## 归因（精确到机制）

1. `run-full.ts` 的退出闸：`process.exit(monitor?.state === "done" ? 0 : 1)`，
   只有 `test-monitor` agent 到达 `done` 才 exit 0。
2. `TestSuite.run()` 结尾 `_deleteAgents([...])` 清理临时 agent 后，才 `applyEvent(agent.done, test-monitor)`。
3. 探针实测：跑完后 **`test-monitor` 已不存在**（被某 phase 的清理/重置删除）。
4. `store.applyEvent` 的 agent.done 分支有 `const a = state.agents.get(e.agent); if (a) ...` 守卫，
   对已删除 agent 是**静默 no-op** → monitor 永远拿不到 `done` 状态。
5. 报告显示「全部通过」是因为 phase 结果存在独立的 `this.phases` 计数，与 monitor 存活与否解耦。
   → 检查全绿 + 退出码红 的分裂。
6. 最后触碰该 runner 的提交 `537734b "...cleanup test agents after suite"` 引入了这次清理，属该提交的潜伏回归。

## 影响

CI 一直红（在本次 eval 落库之前就红）。之前 QA 三次提示的"CI 风险"是**缺文件**，已由 5961b95 解决；
本坏例是**独立的第二个 CI red 源**，落库解决不了它。

## 修复方向（执行侧，M0-7）

任一即可（推荐前两者叠加）：
- (a) 清理列表/重置**排除 `monitorId`**，保证 monitor 存活到最后。
- (b) 最后 `agent.done` 前 `ensureAgent(monitor)` 再置 done（幂等兜底）。
- (c) 退出闸改为基于 `phases.every(p => p.failed === 0)` 而非 monitor 存活——更贴合"检查是否全过"的真实意图。
- 并加一条 CI 冒烟：`npm run test:full` 退出码断言（防回归）。

## 关联

[[WORKPLAN M0-7]] · CI red 双源之一（另一源=缺文件，已由 5961b95 解决）· 触发提交 537734b
