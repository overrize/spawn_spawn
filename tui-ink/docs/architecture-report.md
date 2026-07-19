# TUI-Ink Multi-Agent System 架构分析报告

## 1. 整体架构概述

本项目是一个基于 **React + Ink** 构建的**多智能体终端 UI (TUI)** 系统。它使用 LLM API（HTTP 轮询）驱动多个 AI Agent 协同工作，支持飞书（Feishu）桥接、进程管理、工具注册和完整的 E2E 测试体系。

**技术栈：**
- **前端/UI：** React 18 + Ink 5（终端 React 渲染库）
- **语言：** TypeScript（ESM 模块）
- **运行环境：** Node.js（通过 `tsx` 直接运行 TSX）
- **Agent 通信：** HTTP 轮询（`HttpConvAgent`），通过 Anthropic/OpenAI API 调用 LLM
- **网络层：** `ws`（WebSocket）用于飞书实时消息接收
- **测试：** Node.js 内置 test runner + tsx

**入口文件：** `src/index.tsx`（约 2300 行）

**配置：** `config.ts` 负责加载配置，支持 `dotenv` 加载环境变量；可通过 `--model` `--prompts` `--demo` 等 CLI 参数覆盖。

## 2. 主要模块及职责

### 2.1 核心目录结构

```
src/
├── adapters/       # 外部适配器（HttpConvAgent — LLM API 调用封装）
├── cache/          # 缓存管理（CachePrefixManager）
├── config.ts       # 配置文件加载（ProviderConfig, Palette, Layout 等）
├── feishu/         # 飞书桥接（auth, message, websocket, event, types）
├── memory/         # 记忆/状态持久化（SecretaryProxy, MemoryStore）
├── pm/             # 进程管理器（ProcessManager + ProcessMonitor）
├── protocol.ts     # TUI 事件协议定义（TuiEvent, AgentCommand, DispatchSpec 等）
├── store.ts        # 全局状态管理（类似 Redux 的事件驱动 applyEvent/getState）
├── tests/          # 测试套件（smoke, integration, E2E, headless, stability）
├── tools/          # 工具注册与执行系统（registry.ts）
├── ui.tsx          # UI 组件（标题栏、Agent 列表、会话面板、待办、输入栏等）
└── index.tsx       # 入口 & 编排逻辑
```

### 2.2 ProcessManager（`src/pm/`）

**文件：** `ProcessManager.ts`（439 行）+ `ProcessMonitor.ts`

**核心职责：**
- **Spawn 树管控：** 基于深度（max=4）和扇出（max=4）规则，限制 Agent 分层结构
- **同步阻断（preCheckSpawn）：** 在 spawn 前检查：Worker 不能 spawn；PM 不能直接 spawn Worker；depth≥2 不能 spawn Leader；dispatch 必须携带 background/acceptance_criteria/stop_conditions；深度限制 max=4；扇出限制 max=16（默认 4）；重复 goal 检测
- **异步观察（observe）：** 监控每个 Agent 的事件流，检测循环（loop_suspected）、无进展（no_progress）等异常模式
- **定时检查（tick）：** 每 10 秒扫描运行中的 Agent：5 分钟无 step/todo → no_progress；dispatch.timeout_ms 到期 → 软超时纠正；60 分钟硬超时 → 直接 kill；暂停时间不计入
- **Auto-background 支持：** 前台/后台模式切换，30 秒同步等待，2 分钟自动后台切换

### 2.3 Adapters — HttpConvAgent（`src/adapters/httpAgent.ts`）

**文件：** `httpAgent.ts`（687 行）

**核心职责：**
- 封装 LLM API 的 HTTP 通信（支持代理）
- 维护对话历史（messages 数组）
- 解析 LLM 输出为结构化 TuiEvent（`parseAgentOutput` 函数）
- 实现 JSON 修复机制（repairJsonLiterals）：处理转义符、多余括号、行内换行等
- 管理工具队列（toolQueue）、持续计数（continuations）、审批路由
- 支持 model 切换、打断（AbortController）、resume 恢复

### 2.4 Tools 注册系统（`src/tools/registry.ts`）

**文件：** `registry.ts`（313 行）

**核心职责：**
- 定义 `ToolDef` 接口：name, description, argsSchema, needsApproval, roles, execute
- 实现内置工具：Read、Write、Edit、Bash、Grep、Glob、LS、Think
- 角色权限控制：`roles: Set<AgentRole>` 限定可用性
- `executeTool()` 统一执行入口，`toolNeedsApproval()` 审批判断，`buildToolSchemaBlock()` 生成 schema

**工具列表：** Read（false, L/W, 读文件带行号）、Write（false, L/W, 写文件自动建目录）、Edit（false, L/W, 字符串替换）、Bash（true Worker, L/W, Shell 命令路由到 Leader 审批）、Grep（false, L/W, 正则搜索）、Glob（false, L/W, 文件名匹配）、LS（false, L/W, 列目录）、Think（false, L/W, 记录推理步骤）

### 2.5 Store 状态管理 + Protocol 协议

**protocol.ts（131 行）：**
- `TuiEvent` 联合类型：todo.set, step, tool.call, tool.result, message, spawn, agent.done, agent.error, agent.state, unit.handup, memory.snapshot, shutdown.start, pm.alert, proposal.new, tool.approved, agent.kill, token.usage 等 20+ 事件
- `AgentCommand`：user.message, tool.result, tool.reject, control(pause/resume/interrupt)
- `DispatchSpec`：background, constraints, acceptance_criteria, stop_conditions, timeout_ms, fork 等
- `AgentInfo`：id, name, role, state, goal, sub, model, cost, depth 等
- `Message`：agent, to, ts, kind, text, needs_approval 等

**store.ts：**
- 单一状态树（agents Map, messages, sessions, pendingApprovals, layout 等）
- 纯函数式更新：`applyEvent()` → state，`getState()` → 快照
- Action 函数：userMessage, approve, reject, abortAgent, setLayout, scrollBy, scrollAgentBy, setMinLevel, setEffort, resumeAgent, pruneAgents, clearDoneAgents 等
- 支持 React hooks：`useStore()` 供 UI 订阅状态变更

### 2.6 Memory 记忆系统（`src/memory/`）

**文件：** `MemoryStore.ts` + `SecretaryProxy.ts` + `types.ts`

**MemoryStore：** createMemory（创建记忆实例含 agentId/agentType/parentChain/depth/model/dispatch）、loadMemory/loadMemoryByHash（按 ID/哈希加载）、listUnfinishedAgents（列出未完成 Agent 用于恢复）、deleteAgentMemory（删除）。记忆包含：working_set（facts, decisions）、tombstone（last_todo, resume_hint）、dispatch、logs 等。

**SecretaryProxy：** 与每个 Leader 自动绑定，agent.done 时自动写快照，管理权重排序的 facts、decision 日志、resume_hint。

### 2.7 Feishu 飞书桥接（`src/feishu/`）

**文件：** auth.ts（TokenManager 预加载/自动刷新/缓存）、message.ts（sendTextMessage 发消息）、websocket.ts（startFeishuWebSocket 长连接接收消息）、event.ts（事件处理）、types.ts（类型定义）、config.example.ts（配置模板）

**职责：** 飞书 WebSocket 接收消息 → 创建/路由到 PM 会话 → 标准 Agent 响应 → sendTextMessage 回复。支持群聊/私聊，全异步消息队列。

### 2.8 UI 组件（`src/ui.tsx`，1044 行）

**组件：** TitleBar（标题栏）、AgentsPane（Agent 列表）、SessionsPane（会话面板）、ConvPane（对话面板）、TodoPane（待办面板）、StatusBar（状态栏）、InputBar（输入栏）、EffortBar（努力程度选择器）、DagView（spawn 树可视化）、VDivider（分割线）、PaletteContext/PALETTES（调色板主题）

**Layout：** 三栏布局 agents | conv | todo，支持 setLayout 切换。

### 2.9 Config 配置系统（`src/config.ts`）

ProviderConfig（LLM 多提供商预设：openai/anthropic/openrouter/deepseek/grok/fireworks/together）、PaletteName/PALETTES（主题）、Layout（布局）、AgentConfig（温度/模型/参数）、持久化配置 savePalette/saveLayout/saveAgentConfig。

### 2.10 Cache 缓存模块（`src/cache/`）

CachePrefixManager 管理缓存前缀，在 Fork 场景中共享缓存状态，serializeCachePrefix 序列化。

### 2.11 测试体系（`src/tests/`）

smoke、integration、pm-hierarchy、registry、registry-enoent、cache-prefix、E2E（smoke/regression/agent/stability）、headless（store-events/protocol-parsing/pm-rules）、runner（run-full/run-e2e/TestSuite/E2ESuite）。运行：npm test / npm run test:e2e / npm run test:full。

## 3. 模块间通信关系

### 3.1 通信拓扑

```
User(键盘/终端) → TUI(index.tsx+ui.tsx 渲染&输入) → Store(store.ts 全局状态树) → ProcessManager(pm/ spawn树/超时) → HttpConvAgent(adapters/ LLM API) → LLM(AI Agent)
```

### 3.2 Agent 层级

PM(depth=0,role=Leader) → Tech Lead(depth=1,role=Leader) → Worker(depth=2)。每 Leader 绑定一个 Secretary。Feishu 会话独立 PM 实例。

### 3.3 通信矩阵

| 发送者→接收者 | user | PM/Leader | Worker | Secretary |
|---|---|---|---|---|
| user | — | ✓ | ✓(经TUI) | ✗ |
| PM/Leader | ✓ | ✓ | ✓ | ✓ |
| Worker | ✗拦截 | ✓(经审批) | ✗拦截 | ✗ |
| Secretary | ✗ | ✓(绑定Leader) | ✓(配对Worker) | ✗ |

Worker 的 destructive Bash 路由到 Leader 审批队列。违规被 PM 拦截并产生告警。

## 4. 关键数据流

### 4.1 用户输入→Agent响应
User键盘→TUI InputBar→userMessage(agentId,text)→markPendingInput()→HttpConvAgent.sendCommand()→LLM API→parseAgentOutput()→事件流→Store更新→UI渲染

### 4.2 Spawn新Agent
Agent输出spawn→PM.preCheckSpawn()验证(depth/fanout/dispatch/role)→startLeaderAgent()→创建HttpConvAgent+SecretaryProxy+Memory→emit agent.state

### 4.3 工具调用
Agent输出tool.call→检查needsApproval→(如需)用户y/n→executeTool()→返回tool.result→注入对话历史

### 4.4 Worker Bash审批流
Worker输出Bash→index.tsx拦截→leaderApprovalQueue→TUI显示pending→Leader审批(tool.approved/rejected)→执行或拒绝→继续对话

### 4.5 飞书消息流
飞书WebSocket→onMessage→创建/路由PM会话→userMessage()→标准流程→sendTextMessage()回复

### 4.6 中断恢复流
用户选择恢复→loadMemory(agentId)→注入RESUMED CONTEXT(last_todo,facts,decisions,resume_hint)→新HttpConvAgent→todo.set继续

### 4.7 记忆快照流
SecretaryProxy监听agent.done→自动写memory.snapshot→working_set(tombstone)→持久化磁盘→供恢复

## 5. 关键设计决策

1. **纯JSON协议**：紧凑单行JSON，内置畸形修复(escape/括号/截断)
2. **PM无LLM**：纯TS规则引擎，核心规则100%确定
3. **最大行动偏见**：默认行动不追问，仅不可逆损害时问一次
4. **内存优先**：SecretaryProxy自动持久化，支持中断恢复含budget控制
5. **审批路由**：Worker危险命令→Leader审批而非直接问用户
6. **工具失败≠任务失败**：强制≥2种替代方案后才handup
7. **通信矩阵强制检查**：index.tsx+PM双层验证消息合法性
8. **单例全局管理**：agents Map/secretaries Map/pm均为全局单例，EventEmitter解耦

## 6. 配置与启动

CLI参数：--demo(无API测试)、--model/<id>(模型)、--prompts/<dir>(prompt目录)
环境变量：dotenv加载.env(FEISHU_APP_ID等)
loadConfig()加载配置，saveConfig()持久化
飞书连接：connectFeishu(appId,appSecret)自动或/feishu命令运行

## 7. 总结

TUI-Ink特色：1)协议驱动的Agent通信；2)分层进程管理(4层spawn树)；3)事件驱动状态管理(Redux式)；4)自动记忆持久化(中断恢复)；5)内置工具系统(8工具+权限控制)；6)飞书集成(WebSocket实时桥接)；7)完善测试体系(全量覆盖)；8)弹性容错(JSON修复/替代重试/软超时/记忆恢复)
