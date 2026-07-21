# M1-6 · index.tsx 五步拆分 — 交接规格（可照做）

> 目的：让指定实现者**只看本文 + WORKPLAN 就能安全完成 M1-6**，不必逆向猜边界。
> 前置安全网：`orchestration-golden`（25 用例）+ `scenario-eval`（含 EV-011..013 待转正）。
> 铁律：**每一步 golden 25 用例逐字节不变** + `npm test` 0 fail + `npm run test:full` exit 0。
> 技能门槛：这是高阶重构（3995 行、god-object 耦合），指定人需 senior 前端/TS 水平；
> 有本规格 + golden 兜底可做，但不是初级任务。

---

## 1. 现状结构地图（src/index.tsx，3995 行）

| 区块 | 行范围 | 说明 |
|---|---|---|
| 顶层工具函数 | 97–360 | buildSystemPrompt / readIfExists / checkMessageLegal / findApproverLeader / killAgent / replaceAgentForResume / connectFeishu |
| `startLeaderAgent` | 932–1635 | Leader/PM 的 HttpConvAgent 事件处理器（700 行）——最核心 |
| `startWorker` | 1635–2407 | Worker 的事件处理器（770 行） |
| `runDemo` / `runTestSuite` | 2407–2644 | 演示 / 测试入口 |
| `App()` | 2667–3862 | React 组件 + 命令定义（CmdDef）+ 输入/键位处理（1200 行） |

## 2. 核心难点：模块级共享可变状态（god-object）

拆分不是"剪函数"，是**先把这些闭包状态抽成可注入的 `RuntimeContext`**，否则搬走的函数编译不过。

| 状态 | 声明行 | 被引用次数 | 归属 |
|---|---|---|---|
| `agents: Map<string,HttpConvAgent>` | 177 | **117** | RuntimeContext（核心） |
| `killedAgents: Set<string>` | 228 | 31 | RuntimeContext |
| `feishuBusy: Set<string>` | 192 | 22 | RuntimeContext |
| `secretaries: Map` | 178 | 9 | RuntimeContext → MemoryRuntime |
| `pmPendingArtifacts: Map` | 233 | 7 | RuntimeContext |
| `leaderApprovalQueue: Map` | 237 | 5 | RuntimeContext → ToolRuntime |
| `pm: ProcessManager` | 179 | — | RuntimeContext |
| `scheduledTasks: TaskScheduler` | 184 | — | RuntimeContext |

**第 0 步（6a 内完成）**：新建 `src/runtime/RuntimeContext.ts`，把上表状态收进一个 `interface RuntimeContext` + 单例工厂。index.tsx 改为从 context 取用（`ctx.agents` 等）。这一步是纯机械替换，golden 必然不变——**先做这个，验证注入模式，再谈拆函数**。

## 3. 五步模块边界（搬什么进哪个）

| 步 | 模块 | 搬入内容 | 依赖 |
|---|---|---|---|
| 6a | `runtime/ObservabilityRuntime.ts` | RuntimeContext（第0步）+ 所有 `recordHealthMetric` 调用点（resume-missing ~L113、hard-circuit ~L1808）+ trace/journal glue + 坏例捕获 | 无（副信道，行为零风险，先做） |
| 6b | `runtime/ToolRuntime.ts` | tool.call→`executeTool`→tool.result 回注的 setImmediate 批执行 + 审批路由（toolQueue、leaderApprovalQueue、findApproverLeader、Bash 审批分发） | 6a |
| 6c | `runtime/MemoryRuntime.ts` | secretaries 生命周期 + resume 上下文注入（buildSystemPrompt 的 resume 段）+ fact/decision 提取 glue | 6a |
| 6d | `runtime/OrchestratorRuntime.ts` | spawn 前置校验分发、startWorker 派发、parent-child、killAgent、replaceAgentForResume、resume 编排 | 6a-c |
| 6e | `runtime/AgentRuntime.ts` | startLeaderAgent/startWorker 的**逐事件 switch 处理器** + terminal guard；App() 只剩 render+输入+slash glue（目标 <1500 行） | 6a-d |

## 4. 安全拆分协议（每步照做）

1. **一步一 PR**，不跨步混改。
2. 搬代码用"移动 + 改 import"，**不改逻辑**（等价重构）。行为变更禁止夹带——要变行为另开任务。
3. 每步跑：
   ```
   npm run typecheck
   node --import tsx/esm --test src/tests/baseline/orchestration-golden.test.ts   # 必须 25/25 且序列不变
   npm test            # 0 fail
   npm run test:full   # exit 0
   ```
4. golden 若有一条变了 → **停**，说明夹带了行为变更，回退重来。
5. 6e 完成后：`wc -l src/index.tsx` 必须 < 1500。

## 5. 6e 必须补的递延断言（拆出后才可测）

glue 拆到独立模块、可 import 测试后，补齐这些之前在 index.tsx 闭包里测不到的：
- HealthMetric：`hard_circuit_fired` / `resume_context_missing` / `agent_done_blocked_by_guard` / `test_failed_but_claimed_done`（M0 递延）
- `scenario-eval` 的 EV-011/012/013 转正（BC-001 nudge 行为：纯规划轮触发强制催促 + 写 `no_progress_nudge` + 3 次耗尽收敛）

## 6. 验收（M1-6 整体）

- index.tsx < 1500 行；5 个 runtime 模块各自独立可测
- golden 25 全程不变；全量 0 fail；test:full exit 0
- 5 项递延断言补齐并绿
- 归档一份里程碑回归记录 `regression/M1-YYYYMMDD.md`

## 7. 能否"指定人看文档做"？

- **能开工**：本规格给了结构地图、god-object 注入方案、模块边界、逐步协议、验收。
- **前提**：senior TS 水平 + 严格遵守"每步 golden 不变"。golden 是防止拆坏的唯一自动闸——**绝不能为了让测试过而改 golden**。
- **不能保证一次过**：6e（事件处理器）是最难的一步，React 组件/输入焦点/命令分派这些 App 层 golden 保护不到，需人工冒烟（`npm run dev` 起 TUI 手测键位/审批/滚动）。这部分建议指定人做完后由你端到端过一遍。
