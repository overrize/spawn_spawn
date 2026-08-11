# M1-6c · MemoryRuntime 抽取 — 严格规格 + 验收 + 冒烟清单

> 承接 6a/6b。同一铁律：**只搬位置 + 换 import，输出逐字节不变，golden 25 不动**。
> 6c 把 secretary 生命周期与 resume 上下文注入里**纯粹、可独立测**的部分收进 `src/runtime/MemoryRuntime.ts`（现在只是 barrel）。

---

## 0. 一句话定义

god-file 里 secretary 的创建/销毁在 leader/worker 两处**几乎逐字节相同**，resume 上下文注入是
`buildSystemPrompt` 里一大段自包含逻辑。6c 抽出这 3 个纯/半纯函数，`secretary?.observe(ev)`
的逐事件转发 glue **留在处理器**（耦合闭包，随 6e 走）。

| 抽出 | 从哪 | 性质 |
|---|---|---|
| `initSecretary(secretaries, id, resumedMemoryId, makeParams)` | leader L957-975 / worker L1709-1720（同构） | load-or-create + new + set |
| `destroySecretary(secretaries, id)` | killAgent L319-320 | teardown |
| `buildResumeContext(resumedMemoryId, agentId, role, goal)` | buildSystemPrompt resume 段 L108-157 | 读记忆→拼 RESUMED CONTEXT 串 |

---

## 1. In-scope

### A. `initSecretary`
- 签名：`(secretaries: Map<string,SecretaryProxy>, id: string, resumedMemoryId: string|undefined,
  makeParams: () => CreateMemoryParams) => SecretaryProxy`。
- 逻辑逐字节等价：
  `existingMem = resumedMemoryId ? loadMemory(id) : null; mem = existingMem ?? createMemory(makeParams());
  sec = new SecretaryProxy(mem, {startNewSession: !existingMem}); secretaries.set(id, sec); return sec;`
- `makeParams` 用 thunk 保持惰性（resume 命中时不构造 createMemory 参数）。
- 两处调用点改为 `initSecretary(secretaries, id, opts.resumedMemoryId, () => ({...createMemory 参数}))`。
  leader 的 forked-task（`opts.isForkedTask`）分支**仍返回 null，不走 initSecretary**。

### B. `destroySecretary`
- `(secretaries, id) => { secretaries.get(id)?.destroy(); secretaries.delete(id); }`。
- killAgent 内两行替换为一次调用。

### C. `buildResumeContext`
- `(resumedMemoryId, agentId, role, goal) => string`：返回要 `+=` 到 tpl 的串（无则 `""`）。
- 完整搬 L108-157 的内部逻辑（`loadMemory`→null 记 `resume_context_missing` 并返回 `""`；有 mem 则
  `retrieveRelevant` top-10 预算内 + decisions + lastTodo + pendingBlock，拼出 `## ⚠️ RESUMED CONTEXT` 串）。
- buildSystemPrompt 内改为：`if (resumedMemoryId) tpl += buildResumeContext(resumedMemoryId, agentId, role, goal);`
- **串一字不改**（含所有中文提示与换行）。

### D. MemoryRuntime import 收敛
- MemoryRuntime 依赖 `logDiag`/`recordHealthMetric`（来自 ObservabilityRuntime，6c 依赖 6a）+ `retrieveRelevant`。
- god-file 的 secretary/resume 相关 import 统一来自 `./MemoryRuntime.js`。

---

## 2. Out-of-scope（留 6e）

- ❌ `secretary?.observe(ev)` / `pm.observe(ev)` 的逐事件转发（编织在 switch，耦合闭包）。
- ❌ `secretary.on("event", …)` 订阅、`observeMessage`、`ingestChildMemory` 调用点。
- ❌ session 滑窗、快照 60s、btw 处理（属 SecretaryProxy 内部，本就不在 god-file）。
- ❌ 任何记忆**逻辑**改动（去重/预算/提取算法）——只搬 glue。

---

## 3. 不变量

| # | 不变量 | 验法 |
|---|---|---|
| I1 | golden 25 逐字节不变 | orchestration-golden → 25/25 |
| I2 | 全量 0 fail | `npm test` |
| I3 | typecheck 干净 | `npm run typecheck` |
| I4 | test:full exit 0 | `npm run test:full` |
| I5 | 记忆/resume **行为等价** | §5 冒烟：新建带 secretary、resume 注入现场、kill 清理 |
| I6 | god-file 内 `new SecretaryProxy(` = 0（两处改走 initSecretary） | grep |

---

## 4. 自动验收用例（新增 `src/tests/memory-runtime-6c.test.ts`）

1. **initSecretary 新建路径**：`resumedMemoryId=undefined` → 调 `makeParams` 建新 mem、
   `secretaries.set(id)` 生效、返回的 sec 是 SecretaryProxy 实例、`startNewSession=true`。
2. **initSecretary resume 路径**：预置一份持久化 mem，`resumedMemoryId=id` → 命中 `loadMemory`、
   **不调 makeParams**（thunk 未触发）、`startNewSession=false`。
3. **destroySecretary**：set 一个 mock sec（带 `destroy` spy）→ destroy 被调用一次、map 里删除。
4. **buildResumeContext**：
   - `loadMemory` 返回 null（不存在的 id）→ 返回 `""` 且记一条 `resume_context_missing`（用注入的 store 读回）。
   - 预置含 facts/decisions/last_todo/pending_tool_calls 的 mem → 返回串含
     `## ⚠️ RESUMED CONTEXT`、facts 行、`中断时未完成的操作`（当 pending 非空）；逐字段断言。
5. **门面 re-export 未变形**：`MemoryRuntime.SecretaryProxy === memory/SecretaryProxy.SecretaryProxy`、
   `loadMemory`/`createMemory` 同一引用。

---

## 5. 手动冒烟清单（`npm run dev:watch`）

| # | 操作 | 期望 |
|---|---|---|
| S1 | 起一个新 PM 发消息 | 正常回复；`.spawn/memory/pm.json` 生成，facts 正常累积 |
| S2 | spawn TL/worker | 各自 `<id>.json` 生成，worker 注入父 TL 近 5 条 facts |
| S3 | `/resume <id>` 恢复一个中断的 agent | 首轮系统 prompt 含 `## ⚠️ RESUMED CONTEXT` + 上次 TODO/facts/pending |
| S4 | kill / 中断一个运行中的 agent | `<id>.json` 删除、`<id>.sessions.json` 保留；无报错 |
| S5 | 看 tui.log | `[resume] context injected: …` / `resume_context_missing` 行格式不变 |

判定：记忆写入、resume 注入、kill 清理**与 6c 前无差异** → 通过。

---

## 6. 验收总清单
- [ ] MemoryRuntime 暴露 `initSecretary / destroySecretary / buildResumeContext` + 保留 barrel re-export。
- [ ] leader/worker secretary 创建改走 `initSecretary`；killAgent 改走 `destroySecretary`；buildSystemPrompt resume 段改走 `buildResumeContext`。
- [ ] `memory-runtime-6c.test.ts` 5 组断言全绿。
- [ ] I1–I4 全绿；I6 `new SecretaryProxy(`=0。
- [ ] 手动冒烟 S1–S5 全过。
- [ ] 6e 债务登记：`secretary.observe/on/observeMessage/ingestChildMemory` 转发 glue 留 6e。
