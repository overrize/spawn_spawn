# Spawn 1.0 方案（草案）

> 状态：Draft v0.2 · 起草日期 2026-07-20 · 更新日期 2026-07-20
> 定位口径：Spawn 是自研 Agent Harness——多 Agent 执行操作系统的内核雏形。
> 1.0 的目标不是"再加几个 Agent"，而是两条主线：
> **结构优化** + **自主进化埋点长期存在**。
> 结构上把执行内核从 god file 拆成可维护 runtime；数据上把坏例、trace、评估、回滚埋成长期契约。

---

## 1. 背景与定位

### 1.1 Spawn 是什么（现状基线）

已具备的"执行内核"能力：

| 能力 | 实现 | 位置 |
|---|---|---|
| 多 Agent 调度 | PM → TL → Worker 层级，Orchestrator + 规则 Supervisor | `src/index.tsx`, `src/pm/ProcessManager.ts` |
| 生命周期守卫 | preCheckSpawn（depth/fanout/角色/重复 goal）、软硬超时、loop 检测、worker hard-circuit | `ProcessManager.ts` |
| 工具执行 | 集中注册表，Read/Write/Edit/Bash/Grep/Glob/WebFetch/WebSearch/RunTests/TypeCheck/Browser 等 | `src/tools/registry.ts` |
| 记忆与 resume | facts/decisions/todo/tombstone/session 滑动窗口 + resume 注入 | `src/memory/` |
| 容错 | 重试 + 指数退避 + jitter、多级超时、_busy 防卡死、审批路由 | `src/adapters/httpAgent.ts` |
| 事件与观测 | TuiEvent 统一事件流、token.usage、pm.alert、AgentOSJournal、进程内 bus（offset/epoch/log_cursor 重放） | `src/bus/`, `src/runtime/AgentOSJournal.ts` |
| 输入层路由 | FollowupRouter / ConversationRuntime fork 模型 / slash command / Feishu 输入合并 | `src/runtime/`, `src/inbound/` |
| 安全边界 | WorkspaceBoundary、Bash banned list、destructive 操作走父 Leader 审批 | `src/execution/`, `registry.ts` |
| 多供应商配置 | models + agents + web.providers 统一 config，/model 切换 baseUrl/model/apiKey | `src/config.ts` |

### 1.2 Spawn 不是什么（1.0 仍不承诺）

- 不是完整 Agent 平台：无 RAG pipeline（chunk/embedding/rerank/ACL）、无多租户权限。
- 不是分布式系统：bus 是进程内 ring log（单机 Kafka **语义雏形**，epoch 换代位点作废，跨重启不可重放）。
- resume 是**部分恢复**：能恢复 memory/history/todo/facts/decisions，不能恢复活跃任务树、未完成工具调用、审批队列、进行中的 streaming 请求。1.0 只承诺把这个边界补齐一部分并**如实声明**。

### 1.3 已确认的核心问题（1.0 要解的）

1. **文本 JSON 协议是最大架构赌注**：normalizer 的修复管线（转义修复/补括号/裸文本 agent.done 合成/fallback 降级）本身就是协议债的证据；`_fallbackWarnCount` 是唯一健康度指标且不触发任何动作。
2. **工具参数无强校验**：`argsSchema` 只是注入 prompt 的描述字符串（`registry.ts:27`），JSON 解析成功 ≠ 参数合法。
3. **记忆质量硬伤**：fact 去重用空白符分词的 Jaccard，**对中文失效**；decision 提取靠关键词正则；所有上下文预算按字符数而非 token 数（中文实际预算减半）。
4. **无评估闭环**：有日志/事件/错误素材，无评测集、无归因、无 prompt 版本管理、无回归门禁、无回滚。
5. **运行时逻辑堆积在 `index.tsx`**（≈3900 行）：PM runtime、tool loop、resume loop 未拆分，是复杂度与拓展瓶颈。

---

## 2. 1.0 目标与总验收标准

**一句话目标**：从"能自主执行"升级为"结构可维护、行为可评估、改完知道有没有变好"。

1.0 的主线优先级：

1. **Runtime 结构优化**：把 `index.tsx` 中的 PM/TL/Worker 编排、tool loop、resume、trace、输入层 glue 分离，形成可测试的 Harness 内核。
2. **自主进化埋点常驻**：先不追求自动改自己，而是让每一次 parser 失败、工具失败、循环、卡死、resume 缺失、测试误判都被结构化记录，成为后续评估和修复的材料。
3. **Fitness function 先行**：所有 prompt/code/config 改动都必须能被评测集验证，不做没有回归门禁的"自我进化"。

总验收标准（1.0 发布门槛）：

- [ ] G1 协议双轨上线：支持 native FC/structured output 的 provider 走 native，其余 fallback 文本协议，两轨统一收敛为 TuiEvent；`_fallbackWarnCount` 在 native 轨道上为 0。
- [ ] G2 所有工具参数经 Zod schema 校验，校验失败返回结构化错误给模型（可自纠），不再靠工具执行时炸。
- [ ] G3 记忆去重对中文有效（评测集验证），上下文预算以 token 计。
- [ ] G4 评估闭环最小可用：≥30 条回归评测用例，prompt 变更必须过门禁才合入，失败可一键回滚。
- [ ] G5 `index.tsx` 拆出独立 runtime 模块，主文件 < 1500 行，行为由现有 114+ 测试保障不回归。
- [ ] G6 每个任务链路有 trace_id 贯穿 PM→TL→Worker→tool，单条日志可还原完整调用树。
- [ ] G7 自主进化埋点成为稳定契约：所有核心失败/降级/恢复事件写入结构化 HealthMetric，不再只落 stderr。

### 2.1 自主进化埋点契约

1.0 必须把"系统怎么坏的"变成长期可查询数据。最小事件集：

| event_type | 触发场景 | 用途 |
|---|---|---|
| `protocol_parse_failed` | normalizer JSON 解析失败 | 发现文本协议/provider 输出脆弱点 |
| `protocol_repaired` | 转义修复、补括号、裸文本 agent.done 合成 | 衡量协议债，不只统计最终 fallback |
| `fallback_message_emitted` | 裸文本被降级成 message | prompt 健康度与工具调用准确率代理指标 |
| `tool_arg_schema_failed` | 工具参数 schema 校验失败 | 训练/修正工具调用格式 |
| `tool_call_repeated` | 同工具同参数重复调用 | loop 检测与策略改进 |
| `no_progress_nudge` | agent 规划后无行动或空转 | 找出 planner/runtime 卡点 |
| `hard_circuit_fired` | worker hard-circuit / wall-clock 熔断 | 形成生产坏例 |
| `resume_context_missing` | resume 时缺 history/todo/facts/child state | 改进 checkpoint 边界 |
| `memory_fact_merged` | fact 去重合并 | 评估记忆召回/去重质量 |
| `memory_fact_dropped` | GC 或预算裁剪丢弃 fact | 评估长期记忆损失 |
| `agent_done_blocked_by_guard` | 测试失败/无有效测试时拦截 done | 产物可信度指标 |
| `test_failed_but_claimed_done` | worker 声称完成但测试红 | 训练完成判定 |
| `trace_completed` | 一条任务 trace 正常收敛 | 成功样本 |
| `trace_failed` | 一条任务 trace 失败/中断/放弃 | 失败样本 |

每条 HealthMetric 至少包含：

```ts
type HealthMetric = {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  task_id?: string;
  agent_id: string;
  role: "PM" | "Leader" | "Worker" | "Secretary" | "System";
  event_type: string;
  severity: "info" | "warn" | "error" | "critical";
  reason: string;
  model?: string;
  provider?: string;
  prompt_version?: string;
  config_version?: string;
  tool_name?: string;
  latency_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  refs?: string[];
  ts: number;
};
```

原则：stderr 可以继续存在，但 stderr 不是数据契约；自主进化只消费 HealthMetric / TraceEvent / EvalResult。

---

## 3. 工作流分解（Workstreams）

### WS1 · 协议双轨（P0）

**原则：不废文本协议，做双轨收敛。** Spawn 需兼容 Kimi/DeepSeek/OpenAI-compatible/自定义 baseUrl，原生 tool calling 一致性未必可靠，文本协议是必要的 fallback。

- 1.1 provider 能力探测：config 中为每个 provider 声明 `capabilities: { nativeFC, structuredOutput }`，运行时按能力选轨。
- 1.2 native 轨：Anthropic tool_use / OpenAI tool_calls → 适配层转 TuiEvent；多动作输出（一轮既 message 又 spawn）用单一 `emit_events` 工具承载事件数组。
- 1.3 文本轨保留现有 normalizer，但把修复管线的每次触发计入指标（不只 fallback，含补括号/转义修复），作为 provider 协议健康度评分。
- 1.4 parser 评测集：把历史 shadow.log / stderr 中真实的坏输出沉淀为 normalizer 回归用例。
- **验收**：G1；两轨在同一任务集上产出等价 TuiEvent 序列（差异仅时序）。

### WS2 · 工具层 adapter 化 + 强 schema（P0）

- 2.1 `argsSchema` 字符串 → Zod schema，双用途：注入 prompt 的描述由 schema 生成；执行前强校验，失败返回结构化 `tool_error(invalid_args, 字段级原因)` 供模型自纠（最多 2 次，超限 handup）。
- 2.2 ToolRegistry 后抽 adapter 层：`LocalToolAdapter` / `McpAdapter` / `HttpToolAdapter` 实现同一接口，**权限（needs_approval/审批路由）与观测（tool span）在 adapter 之上统一收口**，新工具不再改核心代码。
- 2.3 MCP 最小接入：支持 stdio MCP server 挂载为工具组，作为 adapter 层的验证用例。
- **验收**：G2；新增一个 MCP 工具全程零核心代码改动。

### WS3 · 记忆升级（P0）

分两步走，先修硬伤再上向量：

- 3.1（短期，随 1.0 早期合入）：
  - fact 去重改字符级 n-gram Jaccard（CJK 有效），保留权重合并逻辑；
  - 所有预算（resume 60K / trim 80K）改为 tokenizer 估算的 token 预算；
  - decision 提取从关键词正则改为：native 轨直接让模型显式 emit `decision.record` 事件（协议已有此命令，AgentOSJournal 中已定义），文本轨保留正则作 fallback。
- 3.2（中期，1.0 内完成）向量化长期记忆：
  - facts/decisions/tombstone summary 写入时同步 embedding，存本地向量索引（sqlite-vec 或纯文件 HNSW，不引重依赖）；
  - 检索注入：agent 每轮开始前，按当前任务 goal 检索 top-k 相关历史 facts 注入（替代现在"最近 5 条"的时间序注入）；
  - 50 条 GC 上限改为"working_set 保留 50 条热数据 + 全量向量化归档"，超限不再永久遗忘。
- **验收**：G3；构造中文重复 fact 用例集，去重召回 ≥ 90%；跨 session 相关性注入命中率有基线数字。

### WS4 · 评估与回滚闭环（P0，自主进化的第一块拼图）

**原则：fitness function 先于自我修改。** 没有评估的自我修改是随机漫步。

- 4.1 评测集：≥30 条端到端用例（任务描述 + 验收断言），覆盖：任务拆分正确性、工具调用准确率、协议遵守率、handup/done 收敛、记忆写入质量。评测执行复用 spawn 自身架构——PM dispatch 一个 QA-TL 跑评测（demo/live 双模式）。
- 4.2 prompt 即数据：`prompts/*.md` 加版本号 frontmatter，运行时记录每轮使用的 prompt version；变更走"评测门禁通过才生效"，保留上一版本可一键回滚。
- 4.3 指标接线：`_fallbackWarnCount`、`loop_suspected`、`no_progress`、`dispatch_timeout` 从"stderr 一行字"升级为结构化 HealthMetric，聚合进 journal，作为坏例挖掘输入。
- 4.4 坏例归档：评测失败与线上告警自动归档为带上下文的 bad case（事件切片 + session 片段），人工标注后回流评测集。
- 4.5 进化触发器只做"建议"，不做自动合入：当 `protocol_repaired`、`tool_arg_schema_failed`、`hard_circuit_fired` 等指标超过阈值时，生成 bad-case report，并可 dispatch QA-TL 分析，但 patch 仍需评测与审批。
- **1.0 明确不做**：自动改 prompt（那是 1.x 的事）。1.0 只交付"人改 → 机器验证 → 门禁 → 回滚"的半自动闭环。
- **验收**：G4、G7；演示一次完整流程：线上 bad case → HealthMetric 归档 → QA-TL 分析 → 改 prompt → 评测门禁拦截劣化 → 回滚。

### WS5 · 运行时拆分 + trace（P1）

- 5.1 从 `index.tsx` 拆出：
  - `AgentRuntime`：agent send、事件处理、terminal guard；
  - `OrchestratorRuntime`：PM/TL/Worker spawn、parent-child、kill、resume；
  - `ToolRuntime`：tool.call→执行→tool.result 回注、审批、schema 校验；
  - `MemoryRuntime`：SecretaryProxy、session、resume context、fact/decision 提取；
  - `ObservabilityRuntime`：TraceEvent、HealthMetric、bad case capture；
  - TUI 只剩渲染、输入、slash command glue。
- 5.2 trace_id 传播：spawn 事件携带 trace_id/parent_span，所有 TuiEvent 与 journal 条目带上；提供 `/trace <id>` 在 TUI 内还原调用树。
- 5.3 resume 完整性提升（量力而为，如实声明边界）：审批队列与未完成 tool.call 进 tombstone，resume 时重建为待办提示注入（不承诺恢复 streaming 请求与活跃子进程）。
- **验收**：G5、G6。

### WS6 · 安全与输入层可靠性（P1）

- 6.1 安全模型成文：WorkspaceBoundary 覆盖所有写路径工具（Write/Edit/Bash cwd 逃逸检查）、Bash banned list、审批矩阵（谁批谁、什么必须批）写成 `SECURITY_MODEL.md` 并配测试。
- 6.2 TUI 输入层修复：Tab 卡住、cursor 消失、pending approval 锁全局输入——输入焦点是运行时的一部分，纳入回归测试（ink-testing-library）。
- **验收**：安全矩阵有测试覆盖；已知输入层 bug 清零并有回归用例。

---

## 4. 阶段计划

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| M0 埋点契约 | 定义 HealthMetric/TraceEvent/EvalResult，接入 normalizer/tool loop/hard-circuit 的最小指标 | G7，坏例不再只落 stderr |
| M1 内核加固 | WS2.1 强 schema、WS3.1 记忆硬伤修复、WS5.1 拆 index.tsx | G2、G5，测试全绿 |
| M2 双轨与工具 | WS1 协议双轨、WS2.2/2.3 adapter + MCP 最小接入、WS5.2 trace | G1、G6 |
| M3 进化地基 | WS3.2 向量记忆、WS4 评估闭环、WS6 安全成文 | G3、G4，1.0 发布 |

依赖关系：M0 必须先行，因为后续所有进化能力都依赖稳定指标；M1 是 M2/M3 的前置（拆分后才好插 adapter 与 trace）；WS4 评测集可从 M1 就开始积累用例，不必等 M3。

## 5. 非目标（1.0 不做）

- 完整 RAG 平台（chunk/rerank/知识库 ACL）——WebSearch/WebFetch 是搜索工具接入，不冒充 RAG。
- 分布式/多进程 bus——保留单机 ring log，但 adapter 接口按可替换（Kafka/Redis Stream）设计。
- 自动 prompt 演化 / A/B 自动路由——1.0 只建半自动闭环。
- 生产级部署形态（容器/限流/熔断网关）——httpServer + Feishu 入口维持现状。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| native FC 在国产/兼容端点行为不一致 | 能力探测 + 逐 provider 灰度开启，文本轨永远可回退 |
| 拆 index.tsx 引入行为回归 | 先补齐事件序列快照测试再动刀；分 PR 小步拆 |
| 向量依赖引入部署负担 | 优先 sqlite-vec/纯文件索引，embedding 调用失败降级为 n-gram |
| 评测集在 live 模式成本高 | demo 模式跑结构断言为主，live 抽样跑；token 成本进指标 |

## 7. 1.0 之后的方向（预告，非承诺）

评估闭环稳定后，1.x 逐步引入：坏例自动分类 → prompt patch 提议（agent 起草、人审批合入，复用现有审批路由作安全闸）→ 金丝雀对比运行。届时 Spawn 才从"自主进化系统的执行内核"走向"自主进化系统本身"。

---

## 版本记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-07-20 | v0.1 | 初稿：三大优先（协议双轨 / 向量记忆 / 评估回滚闭环），G1-G6，M1-M3 |
| 2026-07-20 | v0.2 | 定调改为双主线（结构优化 + 自主进化埋点长期存在）；新增 G7 与 HealthMetric 埋点契约（§2.1）；WS5 细化为 5-runtime 拆分；WS4 增进化触发器（建议模式）；新增 M0 埋点契约阶段 |
| 2026-07-20 | — | 文档迁移至 `docs/spawn-1.0/PLAN.md`，配套 WORKPLAN 与回归记录体系建立 |
