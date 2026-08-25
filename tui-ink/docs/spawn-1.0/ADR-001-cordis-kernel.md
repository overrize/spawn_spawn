# ADR-001 · 内核换底：引入 cordis 作为 DI / 生命周期 / 事件内核

> 状态：**已决策（Accepted）** · 2026-08-15 · 决策人：用户
> 影响范围：`src/runtime/`、`src/bus/`、`src/tools/`、`src/adapters/`、`src/memory/`、`src/pm/`
> 明确不影响：`src/ui.tsx` + `src/tui/`（TUI 渲染层）、`MemoryStore` 的 session 模型

---

## 1. 决策

采纳**路径 B**：引入 [cordis](https://github.com/cordiverse/cordis) 作为 spawn 的
**依赖注入 + 生命周期 + 类型化事件**内核，**保留 spawn 自己的 agent loop
（`HttpConvAgent`）、PM 层级规则、飞书桥和 TUI**。

不采纳的两个选项（保留论证以备回溯）：

| 路径 | 内容 | 不采纳原因 |
|---|---|---|
| A | 整体迁移到 DeepSeek Harness (DSH) | 等于重写。session 模型、tool pipeline、approval 全换，25 条 golden 基线全部作废；spawn 的差异化（PM 层级 / 飞书 / TUI）会被摊薄成别人插件树上的几个 row |
| C | 不引依赖，自己实现 cordis 的三个想法（~400 行） | 成本最低，但自研 DI/fiber 的长期维护成本被低估；且 B 能顺带吞掉 M2-5 / M2-6（见 §8），实际净成本远小于表面 |

---

## 2. 背景：现状的结构性问题

不是"代码不够漂亮"，是**三类 bug 有共同的结构成因**。

### 2.1 生命周期无收口 → M2-8 / M2-9 / M2-10 同源

一个 agent 的登记散落在**五个互不相关的容器**里，销毁靠人肉记得清哪几个：

```
RuntimeContext {
  agents, secretaries, killedAgents, feishuBusy,
  pmPendingArtifacts, leaderApprovalQueue
}
```

M2-9 的根因就是这个：done 路径调了 `deleteAgentMemory` 却漏了
`destroySecretary`，secretary 的 60s 快照把刚删的 `.json` 又写回来了。
**这不是疏忽，是没有"注册即交出 disposer"的机制时的必然结果。**

### 2.2 事件总线只有 `emit` 一种模式 → 策略只能内联

`SpawnBus` 是 `EventEmitter` 包装，只支持 fire-and-forget 广播。
后果：所有拦截/裁决逻辑只能写成处理器里的 inline `if`。

M1-6 已经把策略外提成了**纯函数**——`checkMessageLegal`、`decideDoneGuard`、
`decideAgentIdleAfterNoTools`、`toolNeedsApproval`、`shouldSuppress`、
`decideFormat`、`sanitize`——但它们仍然是被**硬调用**的，
不是可插拔的。**自主进化（G4/M3-5）要求策略能被替换，而不是被改写。**

### 2.3 手搓 DI 不可逆

`configureAgentHandlers(deps)` / `configureFeishuBridge(deps)` 是模块级
`let _deps: T | null`。单向、无就绪等待、不可卸载。M1-6 拆分期间的
TDZ 与加载序问题都由此而来。

---

## 3. cordis 是什么（五个想法）

| 想法 | 机制 |
|---|---|
| 插件即服务实现 | 带 `inject` / `apply(ctx)` 的函数，或 `Service` 子类 |
| Context 是服务仓库 | 服务占稳定的 `ctx.<key>`；消费方按 key 找，不 import 实现 |
| `inject` 声明依赖 | 依赖未就绪 → 停在 PENDING；**加载序由依赖图推导** |
| 类型化事件 | TS 声明合并注册事件名 + 5 种分发模式 |
| 注册即可逆 effect | `ctx.effect()` / `ctx.on()` 注册的东西，卸载时自动反注册 |

**分发模式**（primer 表列 4 种，tutorial ch4 补了 `bail`）：

| 模式 | await | 顺序 | 返回值 |
|---|---|---|---|
| `emit` | 否 | 注册序 | 无 |
| `waterfall` | 否 | 注册序 | 有（around-middleware） |
| `parallel` | 是 | 并发 | 无 |
| `serial` | 是 | 注册序 | 首个非 null/false 胜出并终止 |
| `bail` | 否 | 同 serial 的同步版 | 有 |

**fiber 状态机**：`PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED`（失败走 `FAILED`）。
依赖服务消失时，所有依赖它的插件被连带卸载，服务回来时重载。

---

## 4. 选包：`@deepseek-ai/cordis@4.0.1`

| | 上游 `cordis` | `@deepseek-ai/cordis` |
|---|---|---|
| 最新版 | **4.0.0-rc.8（RC，未 GA）** | **4.0.1（正式版）** |
| 最近发布 | — | 2026-08-13（2 天前） |
| 模块类型 | ESM | ESM |
| 许可 | MIT | MIT |
| 运行时依赖 | `cosmokit`, `@standard-schema/spec` | `@deepseek-ai/cosmokit`, `@standard-schema/spec` |
| 体积 | — | 239 KB / 32 files |

**结论：选 `@deepseek-ai/cordis@4.0.1`。** 上游仍是 RC，不适合作为内核依赖；
DeepSeek 那份是正式版且在活跃维护，DSH 文档也直接适用。

**不装 loader**：`peerDependencies` 里的 `cordis-plugin-loader` /
`cordis-plugin-include` 只在用 `cordis.yml` 配置驱动组合时需要。
一期用 `ctx.plugin()` 编程式挂载，**这两个 peer 依赖不引**（见 §7）。

### 4.1 Spike 验证（已完成）

在真实工具链（Node 24 + tsx + ESM）下验证了 B 依赖的四项机制，
用 spawn 真实规则 `pm_cannot_spawn_worker` 作为 veto 样例：

```
after mount, before provider: count=no-service   ← consumer 停在 PENDING
consumer: ctx.agents ready? true                 ← provider 挂载后自动激活
consumer: registered, count=1
waterfall veto  (pm→Worker): pm_cannot_spawn_worker   ← 短路生效
waterfall allow (tl→Worker): null                     ← 委托 next() 生效
consumer: DISPOSED, count=0                      ← 一次 dispose 反注册服务登记
after dispose, veto listener gone? true          ← listener 自动移除
```

`npm install` 干净（3 个包，4 秒），无 peer 警告。

---

## 5. 目标架构

### 5.1 服务表（`ctx.<key>`）

| service key | 由谁提供 | 取代现状的什么 |
|---|---|---|
| `ctx.agents` | `AgentsService`（包 `HttpConvAgent`） | `RuntimeContext.agents` + `killedAgents` |
| `ctx.tools` | `ToolsService`（包 `tools/registry.ts`） | 模块级静态 `TOOL_REGISTRY` |
| `ctx.memory` | `MemoryService`（包 `MemoryStore` + `SecretaryProxy`） | `secretaries` Map + 手工 `destroySecretary` |
| `ctx.pm` | `ProcessManager` | `RuntimeContext.pm` |
| `ctx.approval` | `ApprovalService` | `leaderApprovalQueue` Map |
| `ctx.feishu` | `FeishuService` | `configureFeishuBridge(_deps)` |
| `ctx.llm` | `LlmService`（HTTP/SSE 层） | `httpAgent` 内联的传输层 |

### 5.2 事件表（waterfall = 可拦截的策略缝）

| 事件 | 模式 | 由哪个已提取的纯函数迁入 |
|---|---|---|
| `spawn/check` | waterfall | PM 层级规则（`pm_cannot_spawn_worker` / depth≤4 / fanout≤4） |
| `message/route` | waterfall | `checkMessageLegal`（worker→user、worker→worker 拦截） |
| `tools/pre-execute` | waterfall | `toolNeedsApproval` + M1-1 参数校验 |
| `agent/done` | waterfall | `decideDoneGuard` |
| `agent/idle` | waterfall | `decideAgentIdleAfterNoTools` |
| `feishu/outbound` | waterfall | `shouldSuppress` → `decideFormat` → `sanitize`（天然三段链） |
| `agent/state` `tool/result` … | emit | 现有 `TuiEvent`，桥接自 `globalBus` |

> **纪律（DSH 的硬规矩，我们照抄）**：只观察/标注的 waterfall listener
> **必须调 `next()`**；不调 `next()` 是**故意短路**。日志类 listener 忘了调
> `next()` 会静默吞掉所有下游的默认行为。

---

## 6. 分阶段实施（每阶段 golden 25 必须绿）

沿用 `globalBus` 自己 docblock 里那条已验证有效的策略——**加性并存，不是替换**。
cordis Context 与 `globalBus` 并行运行，`store.applyEvent` 和 25 条 golden
直到最后一阶段都不动。

| 阶段 | 内容 | 出口标准 | 估时 |
|---|---|---|---|
| **B0** | 装依赖；建根 `Context`；`globalBus.publish` → `ctx.emit` 单向桥 | **零行为变更**；golden 25 不变；全量 0 fail | 0.5 天 |
| **B1** | `AgentScope`：agent 生命周期全部登记改走 `ctx.effect()`，一次 `fiber.dispose()` 收口 | done/kill 后**五个容器同时干净**（单测）；**M2-8 / M2-10 转为结构性修复** | 3–4 天 |
| **B2** | 七个 service 落地 + `inject`；删除 `configureX(deps)` 与模块级 `let _deps` | `grep "let _deps" src/` = 0；加载序不再手工排 | 3–4 天 |
| **B3** | 六条 waterfall 策略链；已提取的纯函数改挂 listener | 每条链的 veto/delegate 双向单测；golden 25 不变 | 3–4 天 |
| **B4** | per-agent 作用域（`agent.ctx`）：工具、prompt 段按 agent 隔离注册 | 一个 agent 的工具集变更不泄漏到兄弟节点（单测） | 2–3 天 |
| **B5**（可选，延后） | `cordis.yml` 配置驱动组合 + HMR；引入 loader/include peer 依赖 | 换一个策略插件零代码改动（验收演示） | 单列评估 |

**B0–B4 合计约 12–16 个工作日**（比首轮估的 3–4 周收窄，因为 spike 已排除
未知数、且不做 YAML loader）。B5 单独决策。

---

## 7. 明确不做（一期边界）

1. **不换 session 模型**。DSH 是 append-only 事件日志 + `deriveMessages()` 投影，
   "model-visible means logged" 是硬不变量；spawn 是快照 JSON + token-budget 截断。
   引 cordis **不要求**换这个。**这是另一条轴，另开 ADR 决策。**
2. **不动 TUI**。`ui.tsx` + `src/tui/` 约 2100 行与 cordis 正交，
   Zustand store 订阅 bus 已是最优解。
3. **不引 YAML loader**（B5 之前）。编程式 `ctx.plugin()` 足够，
   省掉两个 peer 依赖。
4. **PM 层级规则仍然自己写**。cordis / DSH 的 `ctx.agents` 是扁平注册表，
   depth / fanout / 角色矩阵在任何框架下都是 spawn 自己的插件。
   **框架不帮忙，但 waterfall 让它从 inline `if` 变成可测的独立 listener。**

---

## 8. 对现有 WORKPLAN 任务的影响

这是 B 相对 C 的**真实成本优势**——它吞掉了两个已排期任务：

| 任务 | 原计划 | B 之后 |
|---|---|---|
| **M2-5** ToolRegistry 抽 adapter 层（Local/Mcp/Http 同接口） | 手搓 adapter 层 | **被 `ctx.tools` 作用域注册表取代**，改为"注册到 ctx.tools" |
| **M2-6** MCP 最小接入，验收标准是"零核心代码改动" | 需要先有 M2-5 | **这正是 cordis 的核心价值主张**，B2 完成后近乎白送 |
| **M2-8** child-err 收敛 | 在 done-guard 旁加 err 唤醒 | B1 后是结构性修复而非补丁 |
| **M2-10** worker 报 done 后不干净终止 | 同上 | 同上 |
| **M3-3** prompt 版本机制 | — | 变成 prompt 段的可逆 `ctx.effect()` 注册 |
| **M3-5** 进化触发器 | 难点在"策略如何被替换" | **waterfall listener 就是挂载点**，从"改写"变成"增挂" |

**建议**：M2-8 / M2-10 **不等 B**，按原计划在 M2 内先修（用户可感知的 bug 优先）；
B1 落地后这类 bug 整体消失，届时把补丁收敛进 `AgentScope`。

---

## 9. 风险与回退

| 风险 | 缓解 |
|---|---|
| `@deepseek-ai/cordis` 跟 DSH 版本绑定，可能随其 vendor sync 变动 | 锁定精确版本 `4.0.1`（不用 `^`）；B0 阶段就写一份 cordis 行为契约测试，升版时先跑 |
| 中途叫停，代码停在半迁移态 | **加性并存**策略保证每阶段都是可发布状态；B0–B4 任意阶段停下来都不留断壁 |
| golden 基线迁就实现 | 沿用 M1-6 已验证的纪律：每阶段 golden 25 **逐字节不变**，变了就是回归 |
| 新依赖引入供应链风险 | 3 个包、239 KB、MIT、无传递性重依赖；锁版本 + lockfile 审查 |

**回退成本**：B0/B1 阶段回退 = `git revert` + 卸依赖。
B2 之后回退需要恢复 `configureX(deps)`，成本随阶段递增——
**B2 是"实质承诺点"，之前都便宜。**

---

## 10. 参考

- [Cordis Primer](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md)
- [Cordis tutorial — lifecycle/effects · services · events · into the harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/index.md)
- [DSH Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DSH core subsystem（`ctx.agents` / agent-loop 契约）](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md)
- 上游仓库：<https://github.com/cordiverse/cordis>
