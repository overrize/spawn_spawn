# M1-6e · AgentRuntime 收尾拆分 — 设计规格（分阶段）

> 6a-6d 都能摘"依赖干净的纯函数"。**6e 不行**：剩下的是 `startLeaderAgent`(~700)/`startWorker`(~770)
> 两个深度有状态的事件处理器闭包 + `App()`(~1200) 渲染/输入/slash。没有干净子集，只能**分阶段**。
> 铁律不变：每阶段 golden 25 逐字节不变 + 全量 0 fail。但 **App 层 golden 覆盖不到，必须人工冒烟**。

---

## 0. 为什么 6e 难 / 验收被重定义

- 原验收"index.tsx <1500 行"被 Goodhart（改名 AgentRuntime.tsx 就能骗过）。**新验收**：
  **无单一编排文件 >1500 行** + **提取的策略必须接进活代码**（不是并行死代码）。
- 两个处理器闭包各自 close over 几十个 per-turn 可变量（`actedThisTurn`/`continuations`/`gaveUp`/
  `toolQueue`/`wLastTestFailed`/`wConsecToolFails`/`nudgePending`…）。搬走处理器 = 先把这些收进一个
  **per-agent TurnState 对象**，否则搬出的函数编译不过。这是 6e 的核心手术。

---

## 1. 分阶段（每阶段一个 PR，独立可停）

### 6e-1 · 抽 App 层（低风险先做）
- 目标：把 `App()` 的**命令定义（CmdDef 表）+ slash 解析 + 键位处理**搬进 `src/tui/AppCommands.ts` /
  `src/tui/useKeymap.ts`，`App()` 只留组装。
- 依赖注入：命令 handler 通过 `onCommand(name,args)` 注入现有 store 函数，不直接抓模块单例。
- 护栏：golden 不变（App 层不产 TuiEvent 序列）；**人工冒烟键位全矩阵**（见 §3）。

### 6e-2 · 抽 per-turn TurnState（核心手术）
- 把 leader/worker 处理器里的 per-turn 闭包变量收进 `interface LeaderTurnState`/`WorkerTurnState`
  （一个对象，spawn 时 new，处理器读写它而非闭包）。
- 先**不搬处理器**，只把闭包变量换成 `ts.actedThisTurn` 等——纯机械、golden 必然不变，验证 TurnState 模型。
- 这步做完，处理器才可能整体外移。

### 6e-3 · 抽事件处理器 switch
- 把 `startLeaderAgent`/`startWorker` 的**逐事件 switch 分支**搬进 `AgentRuntime` 模块，签名
  `handleLeaderEvent(e, ctx, ts)` / `handleWorkerEvent(ev, ctx, ts)`，`ctx`=RuntimeContext+注入，`ts`=TurnState。
- terminal guard（`dropped X after terminal agent.done`）随之外移。
- 护栏：golden 逐字节 + 全量 0 fail。**这步最险**，一次一分支搬、每搬一分支跑 golden。

### 6e-4 · 补 M0 递延断言 + EV 转正（拆出后才可测）
- 处理器 glue 可 import 后，补这些之前测不到的：
  - HealthMetric 单测：`hard_circuit_fired`（worker 熔断路径）/ `agent_done_blocked_by_guard` /
    `test_failed_but_claimed_done`（done-guard 路径）。
    _注：`resume_context_missing` 已随 6c `buildResumeContext` 转正（见 memory-runtime-6c.test.ts）。_
  - `scenario-eval` 的 **EV-011/012/013 转正**（BC-001 nudge：纯规划轮触发强制催促 + 写
    `no_progress_nudge` + 3 次耗尽收敛）。

---

## 2. 验收（6e 整体）

- [ ] 无单一编排文件 >1500 行（`wc -l src/runtime/AgentRuntime.tsx` 与新模块各自 <1500）。
- [ ] 提取的处理器/策略接进活代码（非并行死代码）——grep 确认 live 调用。
- [ ] golden 25 全程逐字节不变；全量 0 fail；test:full exit 0。
- [ ] M0 递延 3 断言 + EV-011/012/013 转正、全绿。
- [ ] §3 人工冒烟全过。
- [ ] 归档里程碑回归记录 `regression/M1-YYYYMMDD.md`。

---

## 3. 人工冒烟矩阵（App 层，golden 覆盖不到 —— 你必须手测）

起 `npm run dev:watch`，逐项核对：

### 键位
| 键 | 期望 |
|---|---|
| ↑/↓ | agents 页选中上/下 |
| Enter | 进选中 agent 对话 |
| Shift+Tab | 对话→返回 agents（不打断、输入清空） |
| ESC | 对话中只打断当前 agent（载入上条供改后重发） |
| Tab | 循环切 agent |
| `[` / `]` | 滚动对话（旧/新），滚动条底锚不抖 |
| Ctrl+T | Plan 抽屉开关（不在输入栏输入 't'） |
| Ctrl+L | logs/chat 切换 |
| P/F/C | Pause/Fork/查看当前 agent |
| q / Ctrl+C | 退出（二次确认） |

### 斜杠命令
| 操作 | 期望 |
|---|---|
| 输 `/` | 命令面板弹出 |
| ↑/↓ 选命令 + Enter | **执行选中命令**（不是把 `/xxx` 当消息发出——回归 6a 前那个 bug） |
| Tab | 补全选中/LCP |
| `/model` `/resume` `/sessions` `/fanout` 等 | 各自功能不回归 |

### 审批浮层
| 操作 | 期望 |
|---|---|
| worker 破坏性 Bash | 审批浮层弹到父 Leader，`y`/`n` 生效 |
| 有 pending 时输入栏 | 显示 `y approve · n reject` 情境提示 |

### 渲染
| 场景 | 期望 |
|---|---|
| 启动 | header+吉祥物，之后 Enter 进对话 header 顶掉 |
| 流式输出 | 思考中指示闪烁；无 Static 错位/乱码 |
| 窄终端 | 状态栏不换行（右侧只 `log:级别`） |
| 中文/超长/混合 | 不错列（displayWidth 生效） |

---

## 4. 风险 & 建议

- 6e-3 是全项目最险的一步：React 组件/输入焦点/命令分派 golden 保护不到。**强烈建议**：每搬一个
  事件分支就跑 golden + 起 TUI 冒烟对应流程，不要一次性大搬。
- 6e-1（App 命令/键位）可先独立做，收益立现且风险低——**建议作为 6e 的第一个 PR**。
- 前置：6a-6d 的冒烟（[SMOKE-6abc-PROMPTS.md](SMOKE-6abc-PROMPTS.md) P0-P8）先过一遍，确认地基干净再上 6e。
