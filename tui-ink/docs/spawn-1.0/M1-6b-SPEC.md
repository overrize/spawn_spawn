# M1-6b · ToolRuntime 抽取 — 严格规格 + 验收 + 冒烟清单

> 承接 6a（`M1-6a-SPEC.md`）。同一套铁律：**只搬位置 + 换 import，输出逐字节不变，golden 25 不动**。
> 6b 把工具执行/审批里**纯粹、可独立测**的部分收进 `src/runtime/ToolRuntime.ts`（现在只是 registry barrel）。

---

## 0. 一句话定义

god-file 的工具逻辑深嵌在 `startLeaderAgent` / `startWorker` 两个巨型事件处理器的 idle 分支里，
与各自闭包状态（`toolQueue`、coding-guard 计数、`a`、`applyEvent`、done-guard）强耦合。
**6b 只抽出与闭包无关、两处逐字节相同的 3 个纯函数**，其余 reinject 编排**留到 6e**（处理器整体搬走时）。

| 抽出 | 从哪 | 为什么安全 |
|---|---|---|
| `findApproverLeader(childId, ctx)` | 顶层函数 L277 | 纯查询；只读 `agents`/`getState`，注入即可 |
| `runToolBatch(batch, agentId)` | leader L1413 / worker L2211（**同一行**） | `Promise.all(batch.map(executeTool))` 纯扇出 |
| `formatToolResults(batch, results)` | leader L1430 / worker L2269（**逐字节同**） | 纯字符串拼接，无副作用 |

---

## 1. In-scope（逐条可核对）

### A. ToolRuntime 门面新增
`src/runtime/ToolRuntime.ts` 在保留 registry re-export 的基础上，新增：

```ts
import type { TuiEvent } from "../protocol/types.js";   // 以实际路径为准
import type { HttpConvAgent } from "../adapters/httpAgent.js";

export type ToolCall = Extract<TuiEvent, { type: "tool.call" }>;
export interface ToolResult { ok: boolean; output: string }

// 纯扇出：与 executeTool 逐个执行等价，顺序保持
export function runToolBatch(batch: ToolCall[], agentId: string): Promise<ToolResult[]>;

// 基础 combined 串（各 handler 若要追加熔断/收束后缀，在调用点自行 += ——不搬那部分）
export function formatToolResults(batch: ToolCall[], results: ToolResult[]): string;

// 审批人查找：沿 parent 链找最近的 Leader/PM；注入只读上下文
export function findApproverLeader(
  childId: string,
  ctx: { agents: Map<string, unknown>; getState: () => { agents: Map<string, { parent?: string; role?: string }> } },
): HttpConvAgent | null;
```

### B. 调用点替换（机械、等价）
- leader L1413 / worker L2211 的 `await Promise.all(batch.map((c) => executeTool(...)))`
  → `await runToolBatch(batch, opts.id | e.child)`。
- leader L1430-1432 / worker L2269-2271 的 `batch.map(...).join("\n\n")`
  → `formatToolResults(batch, results)`（worker 之后的 `+= 熔断/收束` 后缀**原样保留在调用点**）。
- 顶层 `findApproverLeader`（L277-295）整体移入 ToolRuntime；god-file 改为
  `findApproverLeader(e.child, { agents, getState })`。

### C. import 收敛
工具相关 import（`executeTool`/`toolNeedsApproval`/`buildToolSchemaBlock` + 新 3 函数）统一来自 `./ToolRuntime.js`。

---

## 2. Out-of-scope（6b 绝不碰）

- ❌ `setImmediate` 编排、done-guard、`killedAgents` 检查、`applyEvent` reinject —— 留 6e。
- ❌ worker 的 coding-completion-guard 状态（`wLastTestFailed`/`wConsecToolFails`/`wLastRunTestsSummary`/
  熔断后缀/收束后缀）—— 留在调用点，一字不动。
- ❌ 审批**分发**流程（`leaderApprovalQueue.set` + `approverAgent.sendCommand` 那段 L2157-2169）——
  它编织在 worker spawn-Bash 分支里，耦合 `ev`/`applyEvent`/`a`，留 6e。6b 只抽 `findApproverLeader` **查找**本身。
- ❌ `toolQueue` 本体（每 handler 的闭包数组）——生命周期属处理器，留 6e。
- ❌ 任何 nudge/converge/loop-detect/循环检测文案与逻辑。

> **诚实边界**：6b 不是"把工具执行全搬走"。批执行的 reinject 与两处 handler 的闭包状态深耦合，
> 强行搬会动 golden。6b 只摘"纯函数三件套"，其余明确记为 6e 债务——不假装完成度。

---

## 3. 不变量（每条硬闸）

| # | 不变量 | 验法 |
|---|---|---|
| I1 | golden 25 逐字节不变 | `node --import tsx/esm --test src/tests/baseline/orchestration-golden.test.ts` → 25/25 |
| I2 | 全量 0 fail | `npm test` |
| I3 | typecheck 干净 | `npm run typecheck` |
| I4 | test:full exit 0 | `npm run test:full` |
| I5 | 工具执行/回注**行为等价** | §5 冒烟：工具调用照常执行、结果照常回注、审批照常路由 |
| I6 | god-file 内 `executeTool(` 直接调用点 = **2**（均为审批通过后的单发，非批执行） | `grep -c "executeTool(" src/runtime/AgentRuntime.tsx` |

> I6 说明：批执行两处改走 `runToolBatch` 后，god-file 里直接 `executeTool(` 只剩两处审批通过后的**单发**：
> ① 父 Leader 审批通过（`pending.toolName`）② UI 手动 `y` 审批通过（`m.tool_name`）。二者都是单工具、非批，6b 默认不动。

---

## 4. 自动验收用例（新增 `src/tests/tool-runtime-6b.test.ts`）

1. **runToolBatch 顺序与逐发等价**
   - 对一批只读工具（如两个 `Read` / 一个 `LS`）`runToolBatch` 的结果数组，
     与逐个 `executeTool` 的结果**顺序一致、ok/output 对齐**。
   - 空 batch → 返回 `[]`。
2. **formatToolResults 逐字节等于旧内联**
   - 给定 batch+results，输出严格等于
     `batch.map((c,i)=>\`[tool_result id="${c.id}" ok="${r.ok}"]\n${r.output}\`).join("\n\n")`。
   - 单条不含 `\n\n`；两条正好一个 `\n\n` 分隔。
3. **findApproverLeader 沿链查找**
   - 构造 mock ctx：`worker → tl(Leader) → pm`，`findApproverLeader("worker")` 返回 tl 的 agent 实例。
   - 直挂 pm 下的 child：返回 pm。
   - 断链（parent 不存在）：回退到 pm（root fallback）或按现实现返回值——**与旧函数逐分支同**。
4. **门面 re-export 未变形**
   - `ToolRuntime.executeTool === registry.executeTool`、`toolNeedsApproval`、`buildToolSchemaBlock` 同一引用。

---

## 5. 手动冒烟清单（`npm run dev:watch`）

6b 是工具执行路径的等价重构，**功能上应完全一致**。

| # | 操作 | 期望 |
|---|---|---|
| S1 | 让某 agent 读文件（Read/LS） | 工具正常执行、结果正常回注、对话继续 |
| S2 | 一轮里触发多个工具（批） | 全部执行、combined 结果一次性回注（`[tool_result id=…]` 头正常） |
| S3 | 让 worker 跑测试再改文件 | coding-guard 行为不变（收束/熔断文案照旧出现在该出现时） |
| S4 | worker 发破坏性 Bash（如 `rm`） | 审批浮层照常弹到父 Leader，y/n 生效 |
| S5 | 根 PM 发破坏性 Bash | 照旧返回"无父可批"错误，agent 自恢复 |
| S6 | 看 tui.log | `tool.call` / `loop-detect` / `dropped tool.result` 等行格式不变 |

判定：工具执行、批回注、审批路由、guard 文案**与 6b 前无差异** → 通过。任何一项变了 → 停、回退。

---

## 6. 验收总清单（6b Done 充要）
- [ ] ToolRuntime 暴露 `runToolBatch / formatToolResults / findApproverLeader` + 保留 registry re-export。
- [ ] leader/worker 两处批执行改走 `runToolBatch` + `formatToolResults`；worker 后缀原样保留。
- [ ] `findApproverLeader` 移入 ToolRuntime，调用点注入 `{ agents, getState }`。
- [ ] `tool-runtime-6b.test.ts` 4 组断言全绿。
- [ ] I1–I4 全绿；I6 计数符合预期。
- [ ] 手动冒烟 S1–S6 全过。
- [ ] 6e 债务登记：批执行 reinject 编排 + 审批分发 + toolQueue 生命周期 留 6e。
