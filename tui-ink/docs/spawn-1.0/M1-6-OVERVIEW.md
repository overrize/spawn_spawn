# M1-6 God-file 拆分 — 总览 + 流程图（本轮更新的权威索引）

> 一页看懂：god-file（`src/runtime/AgentRuntime.tsx`，~4000 行）正在被拆成
> **RuntimeContext（共享状态）+ 4 个 façade 运行时模块 + 保留的事件处理器/App 层**。
> 铁律：每步**只搬位置、行为逐字节不变**，`orchestration-golden`（25 用例）全程护栏。
> 详细逐步规格见各 `M1-6x-SPEC.md`；任务状态以 [WORKPLAN](WORKPLAN.md) 为准。

---

## 1. 目标 & 原则

- **为什么拆**：god-file 里 nudge/idle/工具/记忆/编排逻辑全是闭包，测不到→假信心；M2（双轨/MCP）依赖被拆出的模块；124 处引用共享 `agents` Map，改一处牵全身。
- **怎么拆**：先把共享可变状态收进 `RuntimeContext`（依赖注入的地基），再把**依赖干净、可独立测**的函数逐个搬进 façade 模块，**深耦合闭包的 glue 留到最后一步 6e**。
- **护栏**：golden 25（事件序列逐字节）+ 每模块自己的契约测试 + typecheck + test:full。

---

## 2. 模块流程图（拆分后的运行时结构）

```
                          ┌─────────────────────────────────────────────┐
                          │  RuntimeContext  (src/runtime/RuntimeContext) │
                          │  agents · secretaries · pm · scheduledTasks   │
                          │  killedAgents · feishuBusy · pmPendingArtifacts│
                          │  leaderApprovalQueue   —— 单例工厂，注入各处     │
                          └───────────────────────┬─────────────────────┘
                                                  │ 注入 { ... }
        ┌──────────────┬───────────────┬──────────┴───────┬──────────────────┐
        ▼              ▼               ▼                  ▼                  ▼
┌───────────────┐┌──────────────┐┌───────────────┐┌────────────────────┐┌────────────────┐
│Observability  ││ ToolRuntime  ││ MemoryRuntime ││ OrchestratorRuntime││  AgentRuntime  │
│  (6a) ✅       ││   (6b) ✅     ││   (6c) ✅      ││     (6d) ✅         ││ (6e) ⬜ 未开始  │
├───────────────┤├──────────────┤├───────────────┤├────────────────────┤├────────────────┤
│logDiag        ││runToolBatch  ││initSecretary  ││checkMessageLegal   ││startLeaderAgent│
│getDiagSink    ││formatTool-   ││destroySecretary│(通信矩阵)          ││startWorker     │
│setDiagSink4Test│ Results      ││buildResume-   ││replaceAgentFor-    ││ (事件 switch)   │
│installDiag-   ││findApprover- ││ Context       ││ Resume             ││App() 渲染/输入 │
│ nosticSink    ││ Leader       ││+ 记忆 barrel  ││+ 编排 barrel        ││/slash glue     │
│+ 指标门面      ││+ registry    ││               ││                    ││                │
│(HealthMetric) ││ barrel       ││               ││                    ││「god-file 余量」│
└───────────────┘└──────────────┘└───────────────┘└────────────────────┘└────────────────┘
   副信道·零风险   工具执行·纯函数   secretary/resume   通信规则·resume换手   最难·需人工冒烟

  留 6e 的债务（深耦合闭包，随处理器一起搬）：
   · 6b：工具批 reinject 编排 + 审批分发 + toolQueue 生命周期
   · 6c：secretary.observe/on/observeMessage/ingestChildMemory 逐事件转发
   · 6d：killAgent（feishuForks/abortAgent 横切）+ spawn-dispatch 守卫 + parent-child 收敛
```

### 事件流（一次 spawn→工具→done 的模块经过）

```
用户输入 ─▶ App(AgentRuntime) ─▶ dispatchUser
                                   │
   LLM SSE 事件 ─▶ startLeaderAgent/startWorker 的 switch（仍在 god-file，待 6e）
     ├─ message   ─▶ OrchestratorRuntime.checkMessageLegal(通信矩阵拦截)
     ├─ spawn     ─▶ pm.preCheckSpawn(已在 ProcessManager) ─▶ startWorker
     ├─ tool.call ─▶ 入 toolQueue ─(idle)─▶ ToolRuntime.runToolBatch ─▶ formatToolResults ─▶ 回注
     │              破坏性 Bash ─▶ ToolRuntime.findApproverLeader ─▶ 父 Leader 审批
     ├─ 记忆       ─▶ MemoryRuntime.initSecretary(spawn 时) / buildResumeContext(resume 时)
     └─ agent.done─▶ destroySecretary + deleteAgentMemory(M2-9 修复) ─▶ 父收敛
   全程日志 ─▶ ObservabilityRuntime.logDiag ─▶ (TTY)tui.log；关键失败 ─▶ recordHealthMetric
```

---

## 3. 本轮改动状态一览

### M1-6 拆分（5 步，4/5 完成）
| 步 | 模块 | 抽出 | 测试 | 状态 |
|---|---|---|---|---|
| 6a | ObservabilityRuntime | logDiag/sink/installDiagnosticSink + 指标门面 | +5 | ✅ 待冒烟 |
| 6b | ToolRuntime | runToolBatch/formatToolResults/findApproverLeader | +4 | ✅ 待冒烟 |
| 6c | MemoryRuntime | initSecretary/destroySecretary/buildResumeContext | +6 | ✅ 待冒烟 |
| 6d | OrchestratorRuntime | checkMessageLegal/replaceAgentForResume | +3 | ✅ 待冒烟 |
| 6e-3 | LeaderHandler/WorkerHandler/HandlerContext + DevHarness/FeishuBridge/commands | 两处理器 + demo/飞书/命令搬出 | golden 25+pm-hier 60 | ✅ **god-file 3965→1279，全部文件 <1500 达标**；F/C 冒烟过；剩 6e-4 补断言 + H 段冒烟 |

**Step-0** RuntimeContext：✅ 已完成（`createRuntimeContext()`，AgentRuntime L180-181）。

### TUI 修复（本轮）
帽檐加宽·去胡子 · 滚动条底锚(修抖动)+粗细互换 · **状态栏右侧键位串删除**(改输入栏情境提示) · Shift+Tab 返回(不打断) · ESC 只打断 · 返回清空输入(不重问)。

### 收敛类 bug（诊断/修复，归 M2）
| 编号 | 问题 | 状态 |
|---|---|---|
| M2-8 | child-err 卡死父节点吞消息（tl-06 429→err，PM 永等） | 未开始 |
| M2-9 | agent.done 后 `.json` 被快照写回残留 | ✅ 已修（done 路径补 destroySecretary） |
| M2-10 | worker 报 done 后不干净终止（散文 parse-fail 洪水） | 未开始 |

### 调研产出（下午，供 M3 参考）
28 篇论文调研 + gap 分析 + 可复制性分档 → **Top-1 = Reflexion，已挂 M3-5 进化触发器**；
OpenClaw 蒸馏 = 疑似幻觉，已加存疑横幅 + 挂 M3-4 首条坏例。

### 验证基线
全量 **562/555 pass / 0 fail / 7 todo** · golden 25 + pm-hierarchy 60/60 · test:full exit 0 · typecheck 干净。

---

## 4. 相关文档索引
- 逐步规格：[M1-6a](M1-6a-SPEC.md) · [M1-6b](M1-6b-SPEC.md) · [M1-6c](M1-6c-SPEC.md) · [M1-6d](M1-6d-SPEC.md) ·（6e 待写）
- 原始结构地图：[M1-6-SPLIT-SPEC.md](M1-6-SPLIT-SPEC.md)
- 冒烟脚本：[SMOKE-6abc-PROMPTS.md](SMOKE-6abc-PROMPTS.md)
- 任务追踪：[WORKPLAN.md](WORKPLAN.md)
- 调研：[../papers/](../papers/) · [../design/openclaw-distillation.md](../design/openclaw-distillation.md)（存疑）
