# M1-6a · ObservabilityRuntime 抽取 — 严格规格 + 验收 + 冒烟清单

> 本文把 6a **定死**：改什么、不改什么、怎么自动验、你怎么手动冒烟。
> 读完本文你就能判断 6a 是否真做完了，不用逆向猜。
> 前置：Step-0 `RuntimeContext`（`M1-6-SPLIT-SPEC.md` §2）**已完成**——见
> `src/runtime/AgentRuntime.tsx:180-181`（模块级共享状态已收进 `createRuntimeContext()`）。
> 6a 只做「可观测性副信道」的收敛，**行为零风险**（不碰编排/事件/UI 逻辑）。

---

## 0. 一句话定义

把散落在 god-file 里的 **3 类可观测性代码** 收进一个真正的
`src/runtime/ObservabilityRuntime.ts` 门面（现在它只是 6 行 barrel），并让 god-file
只通过这一个门面做「记日志 / 记指标 / 装诊断信道」：

| 类别 | 现状（AgentRuntime.tsx） | 6a 后 |
|---|---|---|
| A. 调试日志 | 55 处裸 `process.stderr.write(\`[id] …\n\`)` | 全部走 `logDiag(line)` |
| B. 健康指标 | 5 处 `recordHealthMetric(…)`（经 barrel） | 门面直接 owns，import 收敛到 1 处 |
| C. 诊断信道安装 | 4050-4055 行内联 `stderr = tui.log` hack | `installDiagnosticSink()` |

**只搬位置 + 换 import，不改任何一个字节的输出内容与顺序。**

---

## 1. In-scope（6a 必须做的，逐条可核对）

### A. 调试日志 seam — `logDiag`
- 在 `ObservabilityRuntime.ts` 暴露 `export function logDiag(line: string): void`。
- 默认实现 = `getDiagSink()(line)`；`getDiagSink()` 默认返回 `(s) => process.stderr.write(s)`。
- 暴露 `setDiagSinkForTests(sink: ((s: string) => void) | null)` 供测试注入/复位。
- 把 AgentRuntime.tsx 里 **全部 55 处** `process.stderr.write(X)` 机械替换成 `logDiag(X)`，
  **X 一字不改**（含 `[${opts.id}] `前缀与结尾 `\n`）。
- 判定：`grep -c "process.stderr.write" src/runtime/AgentRuntime.tsx` → **≤1**
  （唯一合法残留 = `setupLogFile()` 里 `process.stderr.write.bind()`，捕获原始 writer 用）。

### B. 健康指标收敛
- `ObservabilityRuntime.ts` 继续 re-export `recordHealthMetric / getHealthMetricsStore /
  formatMetricsReport`（已在）；**再补** `setHealthMetricsStoreForTests`、`HealthMetric`
  类型，使凡涉及指标的地方只 import 自 `./ObservabilityRuntime.js`。
- 5 处 `recordHealthMetric` 调用点 **原地不动**（它们已经 import 自门面），只确保 import 行统一。
- 4 种 event 名单不变（回归资产）：`resume_context_missing` · `hard_circuit_fired` ·
  `test_failed_but_claimed_done` · `agent_done_blocked_by_guard`。

### C. 诊断信道安装
- 把 4046-4055 的内联块搬进 `export function installDiagnosticSink(opts: { isTTY: boolean;
  demo: boolean; logFile: string }): void`。
- 语义完全等价：仅当 `isTTY && !demo` 时，把 `process.stderr.write` 重定向到 `logFile`（append）；
  `try/catch` 吞错回退终端。
- AgentRuntime.tsx 底部改为调用
  `installDiagnosticSink({ isTTY: process.stdout.isTTY, demo: DEMO, logFile: LOG_FILE })`。

---

## 2. Out-of-scope（6a 绝不能碰 — 碰了就是夹带）

- ❌ 任何事件处理逻辑（`startLeaderAgent` / `startWorker` 的 switch 分支）。
- ❌ nudge / idle / converge / 审批 / spawn 校验 —— 那是 6b-6e。
- ❌ 日志**内容、措辞、顺序、条数**的任何改动（哪怕修错别字也不行）。
- ❌ 指标的 severity / event_type / reason / meta 字段。
- ❌ React 组件 / 输入 / slash / 键位。
- ❌ 新增指标埋点（M0 递延的 4 个断言留到 6e，不在 6a）。

---

## 3. 不变量（Invariants — 每条都是硬闸）

| # | 不变量 | 如何验 |
|---|---|---|
| I1 | golden 25 用例逐字节不变 | `node --import tsx/esm --test src/tests/baseline/orchestration-golden.test.ts` → 25/25 |
| I2 | 全量测试 0 fail | `npm test` |
| I3 | typecheck 干净 | `npm run typecheck` |
| I4 | test:full exit 0 | `npm run test:full` |
| I5 | `tui.log` 输出字节等价 | §5 冒烟 diff（同一操作序列前后 log 行集合一致） |
| I6 | god-file 无裸**日志发射** stderr.write | `grep -c process.stderr.write` ≤ 1；唯一残留是 `setupLogFile()` 里 `process.stderr.write.bind()`——捕获原始 writer 的基础设施引用，非日志发射点，合法保留 |

任何一条红 → **停，回退**，说明夹带了变更。

---

## 4. 自动验收用例（新增 `src/tests/observability-runtime-6a.test.ts`）

严格断言门面契约。以下每条都必须绿：

1. **logDiag 路由到默认 sink**
   - `setDiagSinkForTests` 注入捕获数组 → `logDiag("[x] hi\n")` → 数组含且仅含 `"[x] hi\n"`。
   - `logDiag` **不加工**字符串（传入什么写出什么，无前缀/无换行注入）。
2. **sink 复位**
   - `setDiagSinkForTests(null)` 后，`getDiagSink()` 返回的函数写向 `process.stderr`（用 spy 断言调用）。
3. **指标门面同一性**
   - `ObservabilityRuntime.recordHealthMetric === HealthMetrics.recordHealthMetric`（re-export 未包装变形）。
   - `getHealthMetricsStore()` 返回单例（两次调用同引用）。
4. **4 类指标事件可记录且可读回**
   - 用 `setHealthMetricsStoreForTests` 注入干净 store，逐个 record 4 种 event_type，
     `getHealthMetricsStore().all()`（或等价读法）能读回 4 条且 event_type/severity 对得上：
     `resume_context_missing`=warn · `hard_circuit_fired`=critical ·
     `test_failed_but_claimed_done`=critical · `agent_done_blocked_by_guard`=warn。
5. **installDiagnosticSink 语义**
   - `installDiagnosticSink({ isTTY:false, demo:false, logFile })` → **不**改 `process.stderr.write`（非 TTY 跳过）。
   - `installDiagnosticSink({ isTTY:true, demo:true, logFile })` → **不**改（demo 跳过）。
   - `installDiagnosticSink({ isTTY:true, demo:false, logFile })` → 之后 `process.stderr.write("z\n")`
     使 `logFile` 内容含 `"z\n"`（用 tmp 文件；断言后复位 stderr）。

> 注：读回 API 若 `HealthMetricsStore` 无 `all()`，用其已有读法（见 `HealthMetrics.ts` 的 store 接口），
> 断言等价即可——**不为测试新增生产 API**。

---

## 5. 手动冒烟清单（你在 `npm run dev:watch` 上照做）

6a 是副信道，**屏幕上应该看不出任何差别**——冒烟的目的正是「确认没变」+「日志仍在流」。

### 冒烟前准备
```
del tui.log            # 清空旧日志（PowerShell: Remove-Item tui.log -EA SilentlyContinue）
npm run dev:watch      # 起 TUI
```

### 逐项核对（做动作 → 期望现象）
| # | 操作 | 期望（看得见的） | 期望（tui.log 里的） |
|---|---|---|---|
| S1 | 启动 | header + 吉祥物正常，终端无乱码/无 stderr 泄漏到屏幕 | 有启动相关行 |
| S2 | 发一条消息给 PM | PM 正常回，对话正常滚动 | 出现 `[pm] state→…` / `[pm] message to=…` 等行 |
| S3 | 让 PM spawn 一个 TL | TL 出现在 agents 树 | 出现 `[pm] spawn child=… role=…` 行 |
| S4 | 触发一次工具调用（如让 agent 读文件） | 工具结果正常回注 | 出现 `[id] tool.call …` 行 |
| S5 | `/status` 或指标视图 | 指标报表正常显示（若 UI 有） | —— |
| S6 | 退出再看 `tui.log` | —— | 行**格式与 6a 前一致**（`[id] …`），无重复/无缺失 |

### 判定
- ✅ 通过：屏幕行为与 6a 前**无差异**，且 tui.log 持续有 `[id] …` 结构化行。
- ❌ 失败：屏幕出现裸 stderr 文本 / 乱码 / Static 错位；或 tui.log 空/断流/格式变了。
  → 说明信道安装或 logDiag seam 接错，停止并回退。

> 可选严格 diff：若想逐字节验 I5，用同一份脚本化输入跑 6a 前后各一次，
> 对比两份 tui.log 的**行集合**（时间戳/pid 类字段除外）应一致。

---

## 6. 验收总清单（6a Done 的充要条件）

- [ ] `ObservabilityRuntime.ts` 暴露 `logDiag / setDiagSinkForTests / getDiagSink /
      installDiagnosticSink` + re-export 指标 API。
- [ ] AgentRuntime.tsx 内 `process.stderr.write` 计数 ≤1（仅 setupLogFile bind，I6）。
- [ ] 内联诊断信道块已搬走，底部调 `installDiagnosticSink(...)`。
- [ ] `observability-runtime-6a.test.ts` 5 组断言全绿。
- [ ] I1–I4 全绿（golden 25 不变 / 0 fail / typecheck / test:full exit 0）。
- [ ] 手动冒烟 S1–S6 全过，tui.log 格式不变（I5）。
- [ ] 归档：本文 + 一行进 `WORKPLAN.md` 标 6a 完成。

## 7. 与后续步的关系
- 6a 打通「门面 + 可注入 sink」后，6b（ToolRuntime）/6c（MemoryRuntime）搬出来的代码
  照样通过 `logDiag` 记日志、通过门面记指标——**无需再碰 stderr**。
- 6e 补 M0 递延的 4 个指标断言时，直接 import `ObservabilityRuntime` 即可测。
