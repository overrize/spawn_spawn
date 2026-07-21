# Spawn 1.0 工作计划

> 版本：v1.1.0 · 2026-07-21 · 对齐 [PLAN.md](PLAN.md) Draft v0.3
> 状态：Active
>
> 版本规则：工作计划与 PLAN.md 联动。PLAN 定调变更 → 本文件升 minor（v1.1.0）并将旧版快照存入
> `archive/`；任务级增删改状态 → 直接原地更新并在文末「变更记录」加一行，不升版本。
> 每个里程碑出口必须产出一份回归记录（`regression/`，用 TEMPLATE.md），未归档回归记录的里程碑不得关闭。

---

## 总览

| 里程碑 | 主题 | 出口标准（Gate） | 状态 |
|---|---|---|---|
| M0 | 埋点契约 | G7：核心失败/降级/恢复事件写入结构化 HealthMetric | 完成（回归已归档） |
| M1 | 内核加固 | G2（Zod 强校验）、G5（index.tsx 拆分 <1500 行），测试全绿 | 进行中 |
| M2 | 双轨与工具 | G1（协议双轨）、G6（trace_id 全链路） | 未开始 |
| M3 | 进化地基 | G3（记忆升级）、G4（评估闭环）→ 1.0 发布 | 未开始 |

依赖：M0 先行（后续所有进化能力依赖稳定指标）→ M1 是 M2/M3 前置（拆分后才好插 adapter 与 trace）。
例外：M3-2 评测用例的积累从 M1 即开始，不等 M3 启动。

任务状态取值：`未开始 | 进行中 | 待回归 | 完成 | 取消`。
「回归验证」列是该任务关闭的客观依据，也是里程碑回归记录的检查清单来源。

---

## 分工

> **⚠️ 已废止（2026-07-21）**：用户认为双角分工"不清楚"、增加来回，改为 **Claude 直接实现+验证一把抓**，不再拆 QA/执行侧。下表保留作历史。保留的质量习惯（非角色）：测试先行 it.todo 转绿、DoD 自查、坏例归档、回归记录、golden 不变。

两个角色，边界按"写实现的人不给自己发验收"划分：

| 角色 | 负责 | 不做 |
|---|---|---|
| **执行侧（同事）** | 全部实现类任务：埋点、Zod 改造、runtime 拆分、双轨适配、adapter/MCP、向量记忆、prompt 版本机制、安全模型与 TUI 修复 | 不自行关闭任务（只能置为「待回归」）；不改评测用例的判定标准 |
| **QA / 回归侧（Claude）** | 测试基线与用例集建设、每个 PR 的代码评审、里程碑出口回归执行与记录归档、评测集与坏例标注、PLAN/WORKPLAN/回归文档维护 | 不写功能实现代码；发现问题回给执行侧修，不代改 |

### 任务归属

| 里程碑 | 执行侧（实现） | QA/回归侧（Claude） |
|---|---|---|
| M0 | M0-1 类型与落盘、M0-2..5 四条路径埋点、M0-6 `/metrics` | 各埋点任务的断言用例评审；M0 出口回归 + 归档 |
| M1 | M1-1 Zod 改造、M1-2/3/4 记忆修复实现、M1-6a..e 五步拆分 | **M1-5 事件序列快照基线（QA 产出，拆分前必须先交）**；M1-2 中文重复 fact 用例集；每步拆分 PR 的快照核对；M1 出口回归 |
| M2 | M2-1 capabilities、M2-2 native 轨、M2-3 健康度评分、M2-5 adapter、M2-6 MCP、M2-7 trace 传播 | **M2-4 parser 评测集（从 shadow.log/stderr 沉淀坏例）**；M2-2 双轨等价性测试的判定用例；M2-6"零核心改动"验收演示；M2 出口回归 |
| M3 | M3-1 向量记忆、M3-3 prompt 版本机制、M3-5 进化触发器、M3-6 安全模型、M3-7 TUI 修复 | **M3-2 评测集 ≥30 条（M1 起持续积累）**；M3-4 坏例归档标注与回流；G4 完整流程验收演示；发布回归 + 最终记录 |

### 协作节奏

1. **测试先行**：涉及行为基线的（M1-5 快照、双轨等价性、评测集判定），QA 侧先交用例，执行侧实现到绿——避免"实现完了再补测试"导致基线迁就实现。
2. **关闭权分离**：执行侧完成 → 置「待回归」→ QA 侧核对该任务「回归验证」列 → 置「完成」。
3. **分歧升级**：用例判定标准与实现产生冲突、或同一任务两次回归失败 → 升级到 PLAN 层面重新评估，不在任务内拉锯。

---

## 执行顺序与双轨模型（为什么看起来"没按顺序"）

**两条并行轨道，只有一条需要严格按顺序：**

- **执行侧轨 = 关键路径，严格按依赖顺序。** 有依赖关系，不能乱。当前队列（**执行侧从这里开始**）：
  ```
  M1-3 → M1-4 → M1-6a → 6b → 6c → 6d → 6e →（解锁）→ M2-1 → M2-2(native)
                                          ├→ M3-7b(UI，待 6e)
                                          └→ M1-7 / M1-8（可在 6d/6e 后插）
  M3-1(待 M1-2✓，可与 M1-6 并行) · M3-3→M3-4→M3-5(进化闭环，待 M3-2) · M3-6(独立)
  ```
- **QA 轨 = 测试先行预取，与顺序无关。** 验收基线不依赖实现，可为任意未来任务**提前**预置，目的是执行侧永不等 QA。这解释了为何 M2-2 判定框架"提前"出现——预取零成本、消除未来一次 handoff。已预取：M1-3 / M1-4 / M2-2 测试先行 + M3-2 案例 31 条 + golden 25 安全网。

**关闭规则（消除"跳级"错觉）：**
1. QA 测试先行交付 **≠** 任务完成。状态为「进行中（待实现）」，实现侧把对应 it.todo 转绿。
2. 任务完成 = 实现到 QA 基线全绿 **+** QA 验收置「完成」。
3. 里程碑关闭 = 该里程碑**所有**任务完成（含非案例部分）。

**M3-2 特例（本问触发）**：案例编写（≥30）已达标并修正评审缺口，但 M3-2 整体**不关**——还欠「live QA-TL 执行器」半。该半**归执行侧**（要跑真实 API/dispatch，是运行时构建而非纯测试编写），排在 **M3-3 之后**（prompt 版本化就绪、评测门禁才有意义）。在此之前 M3-2 恒为「进行中」。

---

## 执行侧验收自查清单（Definition of Done）

交付前逐条勾全，全绿再置「待回归」。**通用前置**（每条都要）：`npm run typecheck` 干净 · `npm test` 0 fail · `npm run test:full` exit 0 · 触碰编排路径则 `orchestration-golden` 25 用例逐字节不变。

**M1-3 token 预算**
- [ ] `estimateTokens` 实现：ascii≈len/4、CJK≈1/字、`han(100) ≥ 3×ascii(100)`、单调不减
- [ ] `compactHistoryByTokens` 保留 idx0+末4、按 token 丢中段；resume/trim/compact 三处 char 预算改 token（resume≈15K token）
- [ ] estimateTokens 不可用时降级 char 预算不崩
- [ ] `token-budget-m1-3.test.ts` 5 条 it.todo 全转绿；characterization 3 条被**有意识更新**（不是绕过）

**M1-4 decision 协议化**
- [ ] normalizer `VALID_TYPES` 加 `decision.record`，parseAgentOutput 能产出该事件（先补这个，否则被丢）
- [ ] SecretaryProxy 记录 decision.record → `{text:decision, rationale:reason}`
- [ ] 关键词正则降为 fallback：假阳用例（"这个方案你看过了吗？"）不再被记为 decision
- [ ] `decision-extraction-m1-4.test.ts` 4 条 it.todo 全转绿

**M1-6a..e 五步拆分**（每步一个 PR，小步走）
- [ ] 每步 `orchestration-golden` 25 用例不变（这是硬门）
- [ ] 6a Observability / 6b Tool（+registry 绿）/ 6c Memory（+memory 绿）/ 6d Orchestrator（+pm-hierarchy 绿）/ 6e Agent（index.tsx <1500 行）
- [ ] 6e 补 M0 递延断言：`hard_circuit_fired`/`resume_context_missing`/`agent_done_blocked_by_guard`/`test_failed_but_claimed_done` 拆出后可单测并补
- [ ] 6e 后 `scenario-eval` 3 条 it.todo（EV-011/012/013）转正

**M1-7 BC-001 修复**
- [ ] leader/worker 的 acted 判定统一：纯 `todo.set` 两侧都不算 acted
- [ ] prompt 强化首轮必须带执行动作
- [ ] 示例任务 `no_progress_nudge` 指标显著下降（跑 `/metrics no_progress_nudge` 对比）；EV-010 画像仍成立或按预期更新

**M2-2 native 轨**
- [ ] tool_use/tool_calls → TuiEvent 适配；多动作走 `emit_events`
- [ ] `dual-rail-equivalence-m2-2.test.ts` 7 条 it.todo 全转绿：native 侧 `canonicalize()` 逐条 deepEqual 文本轨金牌
- [ ] native 轨 `fallback_message_emitted` = 0

---

## M0 · 埋点契约

先把"系统怎么坏的"变成长期可查询数据。stderr 保留但不再是数据契约。

| ID | 任务 | 交付物 | 回归验证 | 依赖 | 状态 |
|---|---|---|---|---|---|
| M0-1 | 定义 HealthMetric / TraceEvent / EvalResult 类型与落盘（追加式 JSONL，`.spawn/metrics/`） | `src/runtime/HealthMetrics.ts` + 存储层 | 类型单测；写入/读取/损坏行容错单测 | — | 完成 |
| M0-2 | normalizer 接入：`protocol_parse_failed` / `protocol_repaired` / `fallback_message_emitted` | normalizer 埋点 + `_fallbackWarnCount` 迁移 | 用现有坏输出用例断言事件产出；114+ 测试全绿 | M0-1 | 完成 |
| M0-3 | tool loop / ProcessManager 接入：`tool_call_repeated` / `no_progress_nudge` / `hard_circuit_fired` / `dispatch_timeout` | 守卫路径埋点 | ProcessManager 现有测试扩展断言 HealthMetric | M0-1 | 完成 |
| M0-4 | memory / resume 接入：`memory_fact_merged` / `memory_fact_dropped` / `resume_context_missing` | SecretaryProxy / MemoryStore / resume 路径埋点 | pm-hierarchy + integration 测试扩展 | M0-1 | 完成 |
| M0-5 | 任务收敛事件：`trace_completed` / `trace_failed` / `agent_done_blocked_by_guard` / `test_failed_but_claimed_done` | done-guard 与任务终态埋点 | 完成守卫测试扩展 | M0-1 | 完成 |
| M0-6 | 查询入口：`/metrics` slash command（按 event_type/agent/时间过滤）或等价 CLI | TUI 命令或脚本 | 手工验收 + 快照测试 | M0-1..5 | 完成 |
| M0-7 | **BC-002 修复**（CI 绿的必要条件）：`test:full` 检查全绿却退出码 1——`test-monitor` 被 phase 清理删除，最终 agent.done 落空 no-op（见 `badcases/BC-002`）。清理排除 monitor / 或退出闸改用 phases 计数 + 加 exit-code 冒烟 | run-full 或 TestSuite 修复 + CI 冒烟 | `npm run test:full` exit 0；父提交回归对照 | — | 完成 |

**出口**：G7 达成；跑一次真实任务后 `.spawn/metrics/` 有完整事件流；回归记录归档。
**注**：M0-7 是先前潜伏的 CI-red 源（与 M0 埋点无关，因 CI 复核发现顺手归此里程碑），修复前 CI 无法全绿。

## M1 · 内核加固

| ID | 任务 | 交付物 | 回归验证 | 依赖 | 状态 |
|---|---|---|---|---|---|
| M1-1 | 全工具 argsSchema → Zod：prompt 描述由 schema 生成；执行前强校验，失败发 `tool_error(invalid_args)` 供自纠（≤2 次，超限 handup），并埋 `tool_arg_schema_failed` | registry 全量改造 | 每工具合法/非法参数用例；registry 测试全绿 | M0-1 | 完成 |
| M1-2 | fact 去重改字符级 n-gram Jaccard（CJK 有效），保留权重合并 | SecretaryProxy 去重改造 + 中文重复 fact 用例集 | 中文用例集去重召回 ≥90%；英文用例不回归 | — | 完成 |
| M1-3 | 字符预算 → token 预算（resume 60K / trim 80K / compactHistory） | `src/context/tokens.ts`（estimateTokens/totalTokens）+ `compactHistoryByTokens`；resume→15K tok、trim→20K tok、fork→10K tok | `token-budget-m1-3.test.ts` 8/8 绿（含 5 条原 it.todo 转正 + 单调性）；golden 25 不变 | — | 完成 |
| M1-4 | decision 提取升级：显式 `decision.record` 协议事件为主，关键词正则降为 fallback | protocol TuiEvent + normalizer VALID_TYPES + SecretaryProxy(decision.record→rationale) + store 展示；正则收紧为「决策动词且非疑问句」 | `decision-extraction-m1-4.test.ts` 8/8 绿（4 it.todo 转正 + 2 假阳/GAP characterization 有意识更新）；golden 25 不变 | — | 完成 |
| M1-5 | 事件序列快照测试：为现有编排主流程（spawn/审批/handup/done/resume）建 TuiEvent 序列基线 | `src/tests/baseline/orchestration-golden.test.ts`（25 用例，已入 `npm test`） | 快照全绿——这是 M1-6 的安全网，必须先合 | — | 完成 |
| M1-6a | 拆出 `ObservabilityRuntime`（TraceEvent/HealthMetric/坏例捕获）**含第0步 RuntimeContext 注入**（见 [M1-6-SPLIT-SPEC.md](M1-6-SPLIT-SPEC.md)） | RuntimeContext + 独立模块 | M1-5 快照不变 | M1-5, M0 | 未开始（**规格已就绪，可指派**） |
| M1-6b | 拆出 `ToolRuntime`（tool.call→执行→回注、审批、schema 校验） | 独立模块 | M1-5 快照不变；registry 测试全绿；**补 M1-1 递延项**：invalid_args ≤2 次自纠、超限 handup 的计数治理随 ToolRuntime 实现并可测 | M1-5, M1-1 | 未开始 |
| M1-6c | 拆出 `MemoryRuntime`（SecretaryProxy、session、resume context、提取） | 独立模块 | M1-5 快照不变；memory 测试全绿 | M1-5 | 未开始 |
| M1-6d | 拆出 `OrchestratorRuntime`（spawn、parent-child、kill、resume 编排） | 独立模块 | M1-5 快照不变；pm-hierarchy 全绿 | M1-5 | 未开始 |
| M1-6e | 拆出 `AgentRuntime`（agent send、事件处理、terminal guard）；TUI 只剩渲染/输入/slash glue | **验收改（原 index.tsx<1500 被 Goodhart）**：无单一编排文件 >1500 行 + 提取的策略必须接进活代码 | M1-5 快照不变；全量测试绿；**补 M0 递延断言**：`hard_circuit_fired` / `resume_context_missing` / `agent_done_blocked_by_guard` / `test_failed_but_claimed_done` 埋点随 glue 拆出后必须可单测并补测试 | M1-6a..d | 未开始 |
| M1-7 | **BC-001 修复**（用户可感知：不再"催了才干活"）：统一 leader/worker 的 acted 判定（纯 `todo.set` 不算 acted）+ prompt 强化首轮必须带执行动作 | index.tsx todo.set 不再置 actedThisTurn（对齐 worker）+ leader.md/pm.md 首轮必带执行动作 | golden 25 不变 + 全量 0 fail（无回归）；**真实效果需用户端到端**（🔴 不再"催了才动"、`/metrics no_progress_nudge` 下降）；EV-011/012 自动断言随 M1-6e 补 | M0-3 | 待回归（实现完成，待用户端到端） |
| M1-8 | **resume 完整性**（用户可感知：断了接得上"现场"，不只接得上记忆）：中断时的审批队列 + 未完成 tool.call 写入 tombstone；resume 时重建为待办提示注入首轮（PLAN WS5.3 落地）；`resume_context_missing` 扩展检测部分缺失（缺 history/todo/child state，M0-4 观察项） | tombstone 扩展 + resume 注入 | resume 后首轮提示包含中断时 pending 项（单测）；部分缺失场景各产出一条 metric；明确不承诺恢复 streaming/活跃子进程 | M1-6c/d 后更易做，可提前 | 未开始 |

**出口**：G2、G5 达成；`npm test` + `typecheck` 全绿；回归记录归档。
拆分按 a→e 分 PR 小步走，每步快照必须不变。

## M2 · 双轨与工具

| ID | 任务 | 交付物 | 回归验证 | 依赖 | 状态 |
|---|---|---|---|---|---|
| M2-1 | provider `capabilities: { nativeFC, structuredOutput }` 配置与运行时选轨 | config 扩展 | config-presets 测试扩展 | M1 | 未开始 |
| M2-2 | native 轨：Anthropic tool_use / OpenAI tool_calls → TuiEvent 适配；多动作输出走 `emit_events` 工具 | native 适配层 | 双轨等价性测试：同任务集产出等价 TuiEvent 序列 — QA 已交判定框架 `src/tests/eval/dual-rail-equivalence-m2-2.test.ts`（`canonicalize()` 判等关系 + 6 条文本轨金牌签名含多动作硬用例 + 7 it.todo native 侧） | M2-1 | 进行中（QA 判定框架已交，待 native 实现） |
| M2-3 | 文本轨修复管线指标 → provider 协议健康度评分 | 健康度聚合 | 指标断言测试 | M0-2 | 未开始 |
| M2-4 | parser 评测集：shadow.log / stderr 历史坏输出沉淀为 normalizer 回归用例 | `src/tests/eval/parser-eval.test.ts`（13 用例：7 绿 + 6 XFAIL 账本，源自 tui.log 3500 次真实 parse 失败的挖掘） | 全部用例通过或明确 xfail | — | 完成 |
| M2-5 | ToolRegistry 抽 adapter 层：Local / Mcp / Http 同接口，权限与观测在 adapter 之上收口 | adapter 层 | 现有工具行为不回归（registry 测试）；tool span 产出 | M1-6b | 未开始 |
| M2-6 | MCP 最小接入：stdio MCP server 挂载为工具组 | McpAdapter | 新增一个 MCP 工具全程零核心代码改动（验收演示） | M2-5 | 未开始 |
| M2-7 | trace_id/parent_span 全链路传播 + `/trace <id>` 调用树还原 | trace 传播 + TUI 命令 | 单任务链路日志可还原完整调用树（G6 验收用例） | M1-6a | 未开始 |

**出口**：G1、G6 达成；native 轨 `fallback_message_emitted` = 0；回归记录归档。

## M3 · 进化地基

| ID | 任务 | 交付物 | 回归验证 | 依赖 | 状态 |
|---|---|---|---|---|---|
| M3-1 | 向量化长期记忆：写入时 embedding（sqlite-vec 或纯文件索引）；按 goal 检索 top-k 注入替代时间序注入；GC 改为热数据 50 条 + 全量归档 | 向量记忆层 | 跨 session 相关性注入命中率基线；embedding 失败降级 n-gram 的容错测试 | M1-2 | 未开始 |
| M3-2 | 评测集 ≥30 条端到端用例（任务拆分/工具准确率/协议遵守/收敛/记忆质量），QA-TL 执行器，demo/live 双模式 | eval 用例 + 执行器 | 评测集在 demo 模式全量可跑，live 抽样可跑 | M1 起持续积累 | 进行中（**案例 31 条**：EV-001..031，28 具体 demo 全绿 + 3 递延 M1-6e；剩「live QA-TL 执行器」半） |
| M3-3 | prompt 即数据：frontmatter 版本号、运行时记录 prompt_version、评测门禁、一键回滚 | prompt 版本机制 | 演示：改 prompt → 门禁拦截劣化 → 回滚（G4 验收用例） | M3-2 | 未开始 |
| M3-4 | 坏例归档与回流：评测失败/线上告警 → 带上下文 bad case（事件切片 + session 片段）→ 标注回流评测集 | 归档管线 | 一条真实坏例走完全流程 | M0, M3-2 | 未开始 |
| M3-5 | 进化触发器（建议模式）：指标超阈值 → bad-case report → 可 dispatch QA-TL 分析；patch 仍需评测 + 审批 | 触发器 | 阈值触发测试；不自动合入的守卫测试 | M3-4 | 未开始 |
| M3-6 | `SECURITY_MODEL.md`：WorkspaceBoundary 覆盖全部写路径、banned list、审批矩阵成文并配测试 | 安全文档 + 测试 | 安全矩阵测试覆盖；逃逸用例全拦截 | — | 未开始 |
| M3-7a | **TUI 重构·设计冻结**：`TUI_REDESIGN.md` 四个待确认项（审批浮层/chat 归属/滚动/旧键位迁移）确认关闭 | 设计规格终版 | 用户确认 + QA 评审无遗留缺口 | — | 完成 |
| M3-7b-view | **TUI 视图层（可立即并行，不依赖 M1-6）**：单主视图（Home/Chat/Logs）+ Plan 三态 + 状态栏 + 审批浮层的视图状态机 + 渲染 `f(store)→lines`；建 `src/tui/`，对现有 store 契约（读 useStore/getState，命令用现有 store 函数，斜杠命令走注入 `onCommand`）；displayWidth 收口禁裸 `.length` | 新 `src/tui/` 模块（按 `TUI_REDESIGN.md` 并行接缝节） | 渲染快照矩阵（5 视图 × 英文/中文重/混合超长）零错位；键位状态机全转移单测；审批浮层用例 | M3-7a（**不依赖 M1-6**） | 进行中（核心已建：width/viewState/render + 25 对齐测试 + 预览脚本；余 store→snapshot selector + 视图内滚动） |
| M3-7b-wire | **TUI 接线**：用视图层替换 App() 渲染+输入，接 `onCommand`；旧输入 bug（Tab 卡/cursor 消失/审批锁输入）逐条验证不复现 | index.tsx App() 改造 | 全量绿；`npm run dev` 手工冒烟键位/审批/滚动；旧 bug 清单不复现 | M1-6e, M3-7b-view | 未开始 |
| M3-8 | **指令体验扩充**（用户可感知：操作不僵硬）：① 常用操作补齐（/retry、/kill <id>、/clear、/focus，含旧快捷键迁移 /pause /fork /info）；② 未知命令提示最近似命令而非静默；③ 命令参数容错（大小写/别名/前缀匹配）；④ /help 分组展示；⑤ **`/sessions` 列表增强**：补状态（done/err/中断点）、todo 进度、最后活动时间，支持按 agent/时间过滤；⑥ **Claude Code 对标基线（用户定的产品原则）**：基础操作对齐——新增 `/usage`（token/成本汇总，从 /status 独立）、`/context`（各 agent 上下文占用/预算/截断状态）、`/compact`（手动压缩历史，compactHistory 已有只缺命令）、`/clear`；命名沿用 Claude Code 习惯 | 新 UI 命令层扩充（落在 M3-7b 的薄命令层上） | 命令解析单测（别名/容错/相似提示）；/help 输出快照；/sessions 输出快照（含状态与进度列） | M3-7b | 未开始 |

**出口**：G3、G4 达成；完整演示「线上 bad case → HealthMetric 归档 → QA-TL 分析 → 改 prompt → 门禁 → 回滚」；**1.0 发布**，发布前跑全量回归并归档最终回归记录。

---

## 回归策略

1. **常规回归**：每个任务合入前 `npm run typecheck` + `npm test` 全绿；触碰编排路径的必须过 M1-5 事件序列快照。
2. **里程碑回归**：里程碑出口跑全量测试 + 该里程碑「回归验证」列全部核对，按 `regression/TEMPLATE.md` 记录归档为 `regression/<里程碑>-<YYYYMMDD>.md`。
3. **发布回归**：1.0 发布前额外跑 M3-2 评测集（demo 全量 + live 抽样），HealthMetric 摘要写入发布回归记录。
4. 回归失败 → 任务退回「进行中」，修复后重跑；连续两次失败升级到 PLAN 层面重新评估任务拆分。

## 变更记录

| 2026-07-22 | v1.1.0 | **M1-6 退回整改（QA 独立复核抓到指标 Goodhart + 假信心）**：文件已落库（7c18c63，CI 安全），但拆分未达目标。真的：RuntimeContext（状态收进 context，L174 实例化）、index.tsx→1行入口、golden 25 不变、524/517/0 fail。**三个整改项**：① AgentRuntime.tsx **3984 行**——god-file 只是改名不是拆解，「index.tsx<1500」是被 Goodhart 的代理指标，验收改为「无单一编排文件>1500 行」；② Observability/Tool/Memory/Orchestrator 是 6-11 行 re-export 桶文件、零逻辑——要么装真逻辑要么删掉当噪音；③ **最严重**：`decideAgentIdleAfterNoTools` 活代码调用 0 次、内联 nudge 逻辑仍在（×11）——AgentIdlePolicy 是平行实现，EV-011/012/013 测的不是活路径=假信心（同 worker-circuit 老坑）。整改：把活代码的 idle 处理真正委托给 AgentIdlePolicy，EV 才有效 | Claude |
| 2026-07-22 | v1.1.0 | **M3-7b-view 核心建成（并行轨，不依赖 M1-6）**：`src/tui/` — width.ts（CJK 对齐基元）、viewState.ts（Home/Chat/Logs + Plan 三态状态机纯 reducer）、render.ts（纯 `f(snapshot)→lines`，全视图 + Plan 层 + 审批浮层 + 状态栏）；`render.test.ts` 25 用例：**每视图每行 displayWidth 精确=cols**（英文/中文重/混合超长/审批，@88+@100）+ 状态机全转移。`scripts/tui-preview.mts` 可视预览——中文帧右边框与英文精确对齐，错位 bug 结构性消除。typecheck 干净、全量 524/514/0 fail。余：store→snapshot selector + 视图内滚动 | Claude |（"尽早拿到新 TUI"）**：视图层（Home/Chat/Logs+Plan+审批浮层的状态机与渲染）建 `src/tui/`、对现有 store 契约，**不依赖 M1-6，可立即开工**；仅接线步依赖 M1-6e。并行接缝写入 `TUI_REDESIGN.md`：两轨互不改对方文件（view 只加 src/tui/、M1-6 只动 src/runtime/+index.tsx 内部），冲突面仅 App() 且延到 wire 步——可不同人/会话同时推 | Claude |

| 2026-07-22 | v1.1.0 | **M1-6 交接规格就绪 `M1-6-SPLIT-SPEC.md`（回答"能否指定人看文档做"）**：给出 index.tsx 结构地图、god-object 共享状态清单（agents 被引用 117 次等）+ RuntimeContext 注入方案（第0步）、5 步模块边界（搬什么进哪个）、安全拆分协议（每步 golden 逐字节不变/等价重构禁夹带行为变更）、6e 递延断言清单、验收。结论：senior TS 可照做，6e 需人工冒烟 + 用户端到端；golden 是防拆坏的唯一自动闸 | Claude |
| 2026-07-22 | v1.1.0 | **M1-7 实现完成（Claude 直接实现），置「待回归·待用户端到端」**：index.tsx todo.set 处理去掉 `actedThisTurn=true`——纯规划轮不再算 acted，与 worker 对齐，走「强制执行」催促而非温和催促（BC-001 修复）；leader.md/pm.md 加"首轮必须带执行动作（spawn/tool.call/message 之一）"。golden 25 不变 + 全量 499/489/0 fail + test:full exit 0（无回归）。真实效果（不再"催了才动"）在 index.tsx 闭包内、拆分前不可自动断言 → 归 🔴 待用户端到端 + EV-011/012 随 M1-6e 转正 | Claude |
| 2026-07-22 | v1.1.0 | **M1-4 完成（Claude 直接实现）**：`decision.record` 加入 protocol TuiEvent + normalizer VALID_TYPES（原被当未知类型丢弃的 GAP 修复）；SecretaryProxy 新增 decision.record 分支（decision→text、reason→rationale）；store 加展示（🧭 debug）；关键词正则收紧为 `looksLikeDecision`（需决策动词 决定/采用/… 且排除疑问句），消除"方案你看过了吗？"假阳。8/8 绿（4 it.todo 转正 + 假阳/GAP 两条 characterization 有意识翻转）、golden 25 不变、test:full exit 0、全量 499/489/0 fail | Claude |
| 2026-07-21 | v1.1.0 | **M1-3 完成（Claude 直接实现）**：新增 `context/tokens.ts` estimateTokens（CJK≈1/字、ASCII≈len/4、单调、han(100)≥3×ascii(100)）+ `compactHistoryByTokens`；resume 60K字→15K tok、trim 80K字→20K tok、fork 40K字→10K tok 全切 token 预算；char 版 compactHistory 降级保留。5 条 it.todo 转正、golden 25 不变、test:full exit 0、全量 499/485/0 fail。**偏差**：原「estimateTokens 不可用降级 char」的 it.todo 取消——实现为纯启发式无网络、恒可用，改测单调性+欠预算直通 | Claude |
| 2026-07-21 | v1.1.0 | **分工模型废止**：用户指示 Claude 直接实现+验证，不再拆 QA/执行侧两角。「分工」节加废止横幅、记忆 `feedback-prompt-style` 已更新。执行顺序/DoD/双轨预取等质量机制保留 | Claude |
| 2026-07-21 | v1.1.0 | **新增「执行侧验收自查清单（DoD）」节**：为 M1-3/M1-4/M1-6a..e/M1-7/M2-2 逐条列出完成必满足项 + 通用前置（typecheck/npm test/test:full/golden 不变），执行侧交付前自查勾全再置「待回归」，省一轮来回 | Claude (QA) |
| 2026-07-21 | v1.1.0 | **新增「执行顺序与双轨模型」节**（回应"为什么不按顺序"）：明确执行侧轨=关键路径按依赖顺序（给出 M1-3→…→M1-6e→M2/M3 的起步队列）、QA 轨=测试先行预取与顺序无关；固化关闭规则（测试先行≠完成、里程碑需全任务完成）；澄清 M3-2 恒「进行中」直至 live QA-TL 执行器（归执行侧，排 M3-3 后）完成 | Claude (QA) |
| 2026-07-21 | v1.1.0 | **M2-2 双轨等价性判定框架交付（QA 测试先行，执行侧建 native 轨前）**：定义 `canonicalize()` 判等关系（type + 语义字段签名，忽略 id/时间戳/_fallback 等轨道噪声）；6 条文本轨金牌签名钉住目标（单 message/tool.call/spawn、**多动作轮 message+spawn 硬用例**、plan-then-act、done）；7 条 it.todo 为 native 侧（含 emit_events 多动作 + 全 M3-2 意图集等价）。执行侧建 native 适配层时实现到 it.todo 逐条 deepEqual 文本轨金牌。全量 499/480 绿/0 fail/19 todo，typecheck 干净 | Claude (QA) |
| 2026-07-21 | v1.1.0 | **回应评审：EV-017 命名/语义修正 + 补真·父级聚合 EV-031**（执行侧+用户双方指出）：EV-017 改名为「facts_to_promote 落入该 agent 自己的 Secretary」并加注说明（unit.handup 走 `ev.agent===id` 自提升，非父聚合）；新增 EV-031 验 `PM Secretary.ingestChildMemory` 真父级聚合（子 TL 事实带 `[tl-1]` 来源前缀）。全量 486/474 绿/0 fail/12 todo | Claude (QA) |
| 2026-07-21 | v1.1.0 | **M3-2 案例编写达标 30/30**：续扩 20→30——新增 EV-021 tombstone 落盘重载、022 消息持久化 loadMessages、023 err tombstone、024 token 累计 per-agent/session、025 loop 计数告警、026 leader→leader 正例、027 worker→worker 拦截、028 dispatch 缺 stop_conditions、029 同 goal 不同父放行、030 未知工具返错不抛。27 具体 demo 全绿 + 3 递延（M1-6e）。剩 M3-2 的「live QA-TL 执行器」半仍待做。全量 485/473 绿/0 fail/12 todo，typecheck 干净 | Claude (QA) |
| 2026-07-21 | v1.1.0 | **QA 并行批量交付（减少一收一放）**：一次交三样待实现/我方任务的产出——① M1-4 测试先行 `decision-extraction-m1-4.test.ts`（4 characterization 钉现状：真决定/假阳「方案」误捕/假阴无关键词漏捕/**GAP：decision.record 未入 normalizer VALID_TYPES 会被丢**；4 it.todo 目标契约）；② M3-2 评测集扩容 10→20（新增 EV-014 fanout、015 深度、016 err 不复活、017 handup facts 提升、018 todo done 落 decision、019 prune 子树隐藏 pm 免疫、020 spawn 自动聚焦）；③ M1-6 安全网加宽评估后跳过——kill/orchestrator 逻辑在 index.tsx 内、拆分前不可测（正是拆分本身解锁），不做低质填充。全量 475/463 绿/0 fail/12 todo，typecheck 干净。M1-4 置「进行中(待实现)」、M3-2「进行中(20/30)」 | Claude (QA) |
| 2026-07-21 | v1.1.0 | **M1-3 测试先行交付（QA，协作节奏#1）**：`token-budget-m1-3.test.ts` 先于实现交付——A 半 characterization 钉死当前 char 预算行为（含"BUG: char 预算语言盲，等 char 的中英文截断结果相同、无视 token 成本差"）；B 半 5 条 it.todo 写死 token 预算目标契约（estimateTokens：ascii≈len/4、CJK≈1/字、han(100)≥3×ascii(100)；compactHistoryByTokens 保留 idx0+末4 按 token 丢中段；等 token EN/CN 公平截断；resume 重表述 ~15K token；estimateTokens 不可用时降级 char）。M1-3 置「进行中（待实现）」，执行侧实现到 5 条 it.todo 转绿。全量 460/452 绿/0 fail/8 todo，typecheck 干净 | Claude (QA) |
| 2026-07-21 | v1.1.0 | **M0-7 回归通过置「完成」，BC-002 关闭，CI 全绿达成**：修复 8c24027 采纳 BC-002 推荐叠加方案——退出闸改 `suite.isSuccessful()`（phase 计数 + length>0 防空）+ `ensureMonitor()` 幂等兜底 + `run-full-exit.test.ts` 子进程退出码断言。QA 独立复核 CI 全部步骤：typecheck 干净、npm test 452/449 绿/0 fail/3 todo、test:headless 82/82、**test:full exit 0（65/0，修复目标达成）**、test:e2e:full exit 0（62/0，无连带回归）。CI red 两源（缺文件 5961b95 + 退出码 8c24027）均已解决 | Claude (QA) |
| 2026-07-21 | v1.1.0 | **CI 落库复核 + 发现第二个 CI-red 源**：验证 5961b95 落库完整自洽（31 测试文件全跟踪、src/config 树与 HEAD 一致、无未跟踪 src import）；独立跑 CI 全部步骤——`npm test` 448 绿、`test:headless` 82 绿、`test:e2e:full` exit 0，但 **`test:full` 检查全绿却 exit 1**。归因：`test-monitor` 被 phase 清理删除→最终 agent.done no-op→退出闸判定失败（探针实测 monitor 不存在）。先前存在（父提交同样复现），归档 BC-002 + 新增 M0-7。缺文件的 CI 风险已由落库解决，此为独立第二源 | Claude (QA) |

| 日期 | 版本 | 变更 | 记录人 |
|---|---|---|---|
| 2026-07-20 | v1.0.0 | 初版：对齐 PLAN v0.2（双主线 + G7 + HealthMetric 契约 + M0 阶段 + 5-runtime 拆分） | Claude |
| 2026-07-20 | v1.0.0 | 增加「分工」节：执行侧（同事）做实现，QA/回归侧（Claude）做基线/评审/回归/文档；关闭权分离 | Claude |
| 2026-07-20 | v1.0.0 | M0-1/M0-2 实现完成，状态置为「待回归」：HealthMetric JSONL 存储 + normalizer 协议失败/修复/fallback 埋点 | 执行侧 |
| 2026-07-20 | v1.0.0 | M0-3 实现完成，状态置为「待回归」：ProcessManager `loop_suspected/no_progress/dispatch_timeout` 和 worker `hard_circuit_fired` 已接入 HealthMetric | 执行侧 |
| 2026-07-20 | v1.0.0 | M0-4 实现完成，状态置为「待回归」：SecretaryProxy `memory_fact_merged/memory_fact_dropped` 与 resume `resume_context_missing` 已接入 HealthMetric；memory 路径已补断言 | 执行侧 |
| 2026-07-20 | v1.0.0 | M0-5 实现完成，状态置为「待回归」：`agent.done` 终态写 `trace_completed/trace_failed`，完成守卫写 `agent_done_blocked_by_guard/test_failed_but_claimed_done` | 执行侧 |
| 2026-07-20 | v1.0.0 | **M0-3 回归不通过，退回「进行中」**（typecheck 干净、411/411 绿，但断言不满足验证标准）：① `tool_call_repeated` 已断言 ✓；② `no_progress_nudge`/`dispatch_timeout` 只有映射无断言——整改：导出 `metricTypeForAlert` 纯函数并补 4 分支单测（3 映射 + default null）；③ `hard_circuit_fired` 埋点在 index.tsx 闭包内不可单测（worker-circuit.test.ts 测的是重实现的决策函数，不覆盖真实埋点）——接受递延：随 M1-6e 拆出后补测，已写入 M1-6e 回归验证列 | Claude (QA) |
| 2026-07-20 | v1.0.0 | **M0-4 回归通过置「完成」**：`memory_fact_merged`/`memory_fact_dropped` 实现与断言齐备（含 previousWeight/droppedCount 等 meta），411/411 绿。递延项：`resume_context_missing` 在 index.tsx 内不可单测 → 随 M1-6e 补测（同上）。观察项：当前只覆盖 loadMemory 整体缺失，PLAN 契约中"缺 history/todo/child state"的部分缺失场景未检测 → 建议 M0-6 或 M1-6e 时一并补 | Claude (QA) |
| 2026-07-20 | v1.0.0 | M1-5 完成：orchestration-golden 基线 25 用例（spawn 治理/审批/通信矩阵/handup·done/协议解析/终态保护/记忆序列），真实组件接线，已接入 `npm test` | Claude (QA) |
| 2026-07-20 | v1.0.0 | M0-1/M0-2 回归通过置「完成」：typecheck 干净 + 全量 409 用例绿；health-metrics 与 orchestration-golden 已补入 `npm test` 列表。观察项：未设测试 store 的套件跑 parseAgentOutput 会写真实 cwd 的 `.spawn/metrics/`（已 gitignore，不阻塞，M0 出口复核）。基线新发现：文本协议 todo.set 可携带非法 state（如 "doing"）无校验透传 → 归入 M1-1 Zod 范围 | Claude (QA) |
| 2026-07-20 | v1.0.0 | M0-6 实现完成，状态置为「待回归」：新增 `/metrics [event_type|agentId]` 查询最近 HealthMetric；按 QA 整改补齐 `metricTypeForAlert` 映射单测，让 M0-3 回到「待回归」 | 执行侧 |
| 2026-07-20 | v1.0.0 | **M0-3 回归通过置「完成」**：`metricTypeForAlert` 已导出，4 分支映射单测齐备（412/412 绿）。`hard_circuit_fired` 递延项维持 M1-6e | Claude (QA) |
| 2026-07-20 | v1.0.0 | **M0-5 回归通过置「完成」**：`trace_completed/trace_failed` 放进 store.applyEvent（可测层，好设计）且 smoke 已断言 ✓。`agent_done_blocked_by_guard`/`test_failed_but_claimed_done` 在 index.tsx done-guard 闭包内不可单测 → 追加进 M1-6e 递延断言列表 | Claude (QA) |
| 2026-07-20 | v1.0.0 | **M0-6 回归不通过，退回「进行中」**（功能正确但不满足"快照测试"验证标准）：① `/metrics` handler 是 index.tsx 闭包，无法测——整改：抽出纯函数 `formatMetricsReport(metrics, filter): string`（过滤+汇总+格式化），handler 只留 3 行 glue，补格式快照单测；② **新发现（较重要）**：`trace_*` 进 applyEvent 后，未做指标隔离的测试套件持续污染真实 `.spawn/metrics/`（当前 12 条全是测试 agent 数据）——整改：测试公共 helper 里 `setHealthMetricsStoreForTests(临时目录)`，或默认 store 检测 NODE_TEST 环境降级为 no-op，否则 M3-4 坏例挖掘的数据源不可信；③ 手工验收（TUI 里跑 `/metrics`）与 M0 出口的"跑一次真实任务"合并执行 | Claude (QA) |
| 2026-07-20 | v1.0.0 | M0-6 整改完成，自动回归通过：抽出 `formatMetricsReport` 并补 3 类格式断言；默认测试 store 在 node:test 下写入系统临时目录，避免污染真实 `.spawn/metrics`；`typecheck` 通过，`npm test` 416/416 通过。剩余：TUI 手工跑 `/metrics` + 真实任务出口验收 | 执行侧 |
| 2026-07-20 | v1.0.0 | **M0-6 回归通过置「完成」**：`formatMetricsReport` 纯函数 + 空/过滤/格式 3 类快照断言齐备；隔离修复实测有效（跑 smoke+pm-hierarchy 后真实 `.spawn/metrics` 零增长），清掉 15 行历史污染 | Claude (QA) |
| 2026-07-20 | v1.0.0 | **M0 里程碑出口回归通过，M0 关闭**：G7 达成。出口脚本 `scripts/m0-exit-check.mts`（真实组件、非 test 进程）驱动一次完整多 agent 任务，7 类关键事件（protocol_repaired/parse_failed/fallback/fact_merged/tool_call_repeated/trace_failed/trace_completed）全部落真实 store 并经 `/metrics` 渲染。回归记录归档 `regression/M0-20260720.md`。递延项（4 个 index.tsx 闭包内埋点断言）转 M1-6e | Claude (QA) |
| 2026-07-20 | v1.0.0 | M1-1 实现完成，状态置为「待回归」：15 个工具接入结构化参数规格，`executeTool` 执行前强校验并返回 `tool_error(invalid_args)`，失败写 `tool_arg_schema_failed` HealthMetric；工具 prompt 参数列由规格生成；主链路 executeTool 调用补 agentId 归因；registry/coding 专项 68/68 绿，`typecheck` 通过，`npm test` 420/420 绿。注意：当前未新增外部 Zod 依赖，用内部 schema 达成同等运行时合同；“超过 2 次后 handup”建议随 M1-6b ToolRuntime 拆分做可测治理 | 执行侧 |
| 2026-07-21 | v1.1.0 | **QA 侧三项交付，置「待回归」由执行侧/用户核收**：① M2-4 parser 评测集（挖掘 tui.log：3500 次 parse 失败 / 3146 次 fallback，主导失败=markdown 全文逐行碎片化；13 用例含 6 条 XFAIL 账本：碎片化/Think 大小写/tool_result 下划线/工具名当事件/尾部垃圾蒸发/截断蒸发）；② M3-2 场景评测种子 EV-001..010（协议遵守/治理/收敛/记忆/审批）+ 3 条 it.todo 挂账 M1-6e 后补；③ M1-7 QA 部分：BC-001 触发条件画像已钉（EV-010），闭包内 nudge 行为规格以 it.todo 显式挂账。公共骨架抽至 `tests/support/orchestrationHarness.ts`，golden 25 用例重构后逐字节不变。全量 448 过 + 3 todo，typecheck 干净 | Claude (QA) |
| 2026-07-21 | v1.1.0 | **M3-8 增补 Claude Code 对标基线**（用户定的产品原则，已存长期记忆）：/usage、/context、/compact、/clear 补齐，命名沿用 Claude Code；现有 24 命令 vs 基线的缺口盘点完成 | Claude (QA) |
| 2026-07-21 | v1.1.0 | **定调变更升版（对齐 PLAN v0.3）：TUI 重构进入 1.0**。M3-7 拆为 M3-7a 设计冻结（进行中，4 个待确认项见 `TUI_REDESIGN.md`）+ M3-7b 单主视图实现（依赖 M1-6e）；M3-8 改为落在新 UI 命令层并收编旧快捷键迁移。结构性消灭竖直分割线错位 bug 类别。旧版归档 `archive/WORKPLAN-v1.0.0.md` | Claude (QA) |
| 2026-07-21 | v1.0.0 | **M1-2 回归通过置「完成」**（QA 复核 424/424 绿）：factSimilarity 改 CJK 1/2/3 字符 n-gram + 虚词剥离 + containment 度量，中文近似对/无关对/英文回归/召回率断言齐备。长期记忆的中文硬伤已修复 | Claude (QA) |
| 2026-07-21 | v1.0.0 | **记忆/resume 缺口登记**：① 新增 M1-8 resume 完整性（PLAN WS5.3 此前未映射到任务——审批队列/未完成 tool.call 进 tombstone、部分缺失检测收编 M0-4 观察项）；② M3-8 增补 /sessions 列表增强（状态/进度/最后活动/过滤） | Claude (QA) |
| 2026-07-21 | v1.0.0 | **用户体验反馈登记为任务**（来源：真实使用反馈）：① "催了才干活" → BC-001 归档 + 新增 M1-7（acted 判定统一 + prompt 强化，`no_progress_nudge` 为验收指标）；② 中文重内容分割线错位 → M3-7 扩充渲染层（CJK 宽度收口 + 对齐快照）；③ 指令僵硬 → 新增 M3-8（命令补齐/容错/相似提示/help 分组） | Claude (QA) |
| 2026-07-20 | v1.0.0 | **M1-1 回归通过置「完成」**（QA 复核 420/420 绿 + typecheck 干净）：校验器为真结构化校验（类型/必填/枚举/min-max/alias 归一/未知字段拒绝），字段级错误 + 期望规格回给模型可自纠，指标带 agentId 归因。**接受偏差**：内部 schema 替代 Zod（合同等价、零新依赖），PLAN G2 措辞同步修正；递延项「≤2 次自纠计数治理」写入 M1-6b 回归验证列。**风险提示**：CI 在远端不可绿——npm test 列表引用大量未落库文件（src/execution、src/inbound、src/runtime 部分、feishu 测试等），执行侧需整体提交一次实现代码 | Claude (QA) |
| 2026-07-21 | v1.0.0 | M1-2 实现完成，状态置为「待回归」：SecretaryProxy fact 去重改为 CJK 友好的 n-gram + containment 相似度；导出 `factSimilarity` / `factTokens` 纯函数；补中文 10 组重复 fact 召回 ≥90%、中文不相似不合并、英文近重复不回归、真实 SecretaryProxy merge 权重/指标断言。专项 `pm-hierarchy` 35/35 绿，`typecheck` 通过，`npm test` 424/424 绿 | 执行侧 |
| 2026-07-21 | v1.1.0 | M3-7a 设计冻结完成，状态置为「待回归」：`TUI_REDESIGN.md` 四个待确认项已收口为冻结方案（审批浮层顶掉 Plan、chat 为选中 agent 收件箱、P/F/C 迁 slash、`[`/`]` 滚动与 Logs live 规则）；补完整 ASCII 设计稿（Agents Home、Agent Chat、Plan 半展/全展、Logs、Approval 浮层）。实现仍按计划等待 M1-6e 后进入 M3-7b | 执行侧 |
| 2026-07-21 | v1.1.0 | **M2-4 回归通过置「完成」**：`parser-eval.test.ts` 已接入 `npm test`，13 个真实坏输出衍生用例全部执行；6 条 XFAIL 以 characterization + ledger 固定当前缺陷，不伪装为已修复能力。复核 `typecheck` 通过，`npm test` 451 tests / 448 pass / 3 todo / 0 fail | Claude (QA) |
| 2026-07-21 | v1.1.0 | **M3-7a 回归通过置「完成」**：`TUI_REDESIGN.md` 已冻结单主视图方案，四个待确认项关闭，ASCII 稿覆盖 Agents Home / Agent Chat / Plan 半展全展 / Logs / Approval 浮层；实现边界明确为 M1-6e 后进入 M3-7b。M3-2 种子评测和 M1-7 BC-001 画像已验收为有效基线，但 M3-2 目标为 ≥30 条，状态继续保持「进行中（种子 10/30）」 | Claude (QA) |
| 2026-07-21 | v1.1.0 | M0-7 实现完成，状态置为「待回归」：TestSuite 在输出报告/终态前幂等恢复 `test-monitor`，`run-full.ts` 退出闸改为 phase 结果 `suite.isSuccessful()`，不再依赖 monitor 存活；新增 `run-full-exit.test.ts` 子进程冒烟，断言 run-full exit 0 且报告 `65 通过 / 0 失败`；已跑 `typecheck`、`npm test`、headless 等价入口、`test:e2e:full` 等价入口、`test:full` 等价入口通过 | 执行侧 |
