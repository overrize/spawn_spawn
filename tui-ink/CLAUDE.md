# CLAUDE.md — multi-agent TUI (tui-ink)

Claude Code 的项目说明文件。每次开新会话时自动加载。

---

## 项目概览

多 Agent TUI，使用 Ink/React + TypeScript。架构：PM (depth=0) → Tech Lead (depth=1) → Worker (depth=2)。
每个 Agent 是一次 LLM HTTP 对话，由 SecretaryProxy 负责记录 memory，ProcessManager 负责生命周期监控。
另有飞书（Feishu）WebSocket 通道作为第二种驱动方式（见 `src/feishu/`、`src/inbound/`）。

**入口**：`src/index.tsx`（一行）→ 导入 `src/runtime/AgentRuntime.tsx`（M1-6 god-file 拆分后的主运行时）  
**运行**：`npm run dev`（支持 `--demo` 无 API key 演示，`--model=<id>` 覆盖模型）

---

## 常用命令

```bash
npm run dev          # 启动 TUI（live 模式）
npm run dev -- --demo  # 演示模式，不需要 API key
npm run typecheck    # tsc --noEmit
npm test             # 跑全部单测（当前 574 用例 / 143 suite，0 fail）
npm run test:e2e     # e2e（smoke / regression / agent / stability 分组）
npm run test:full    # e2e 全流程 runner（run-full.ts）
```

**系统依赖**：需要安装 `ripgrep`（Grep/Glob 工具依赖）
```bash
apt install ripgrep   # Linux
brew install ripgrep  # macOS
scoop install ripgrep # Windows（需在系统 PATH，不只是 PS PATH）
```

---

## 架构要点

### Agent 层级
```
PM (depth=0, role=Leader)
└── Tech Lead (depth=1, role=Leader)  — PM spawn 的
    └── Worker (depth=2, role=Worker) — TL spawn 的
```
- PM 不能直接 spawn Worker（`pm_cannot_spawn_worker` 错误）
- Worker 不能 spawn 任何人（`worker_cannot_spawn` 错误）
- 最大深度 4，最大并发子节点 4（可 `/fanout N` 调整）

### 通信矩阵
- Worker → user：非法，自动转发至 parent 并纠正
- Worker → Worker：非法，拦截
- Leader → Leader：合法（如 TL message→PM）
- Leader → user：合法

### Memory 系统（`.spawn/memory/`）
- 每个 Agent 一个 `<id>.json`（working_set）+ `<id>.sessions.json`（历史）
- `agent.done` 时删除 `.json`，保留 `.sessions.json` 供 resume
- Session 滑动窗口：最多保留 5 个 session，每个 session 内消息无限制
- Resume 时 token-budget 截断：总字符 > 60K 时从最旧开始丢，始终保留最后 4 条
- Worker spawn 时注入父 TL 的最近 5 条 facts（Codex fork-spawn 模式）

### 工具 (`src/tools/registry.ts`)
| 工具 | 说明 | needs_approval |
|---|---|---|
| Read / Write / Edit | 文件操作 | false |
| Bash | Shell 命令，有 banned list（curl/wget/ssh 等） | 按命令判断 |
| Grep / Glob | 基于 rg，需要 ripgrep 已安装 | false |
| LS / Think | 目录列表 / 推理记录 | false |
| WebFetch | 获取 URL 纯文本，自动去 HTML，跟随跳转 | false |
| WebSearch | 互联网搜索（需 BRAVE_SEARCH_API_KEY 或 SERPER_API_KEY） | false |
| RunTests / TypeCheck | 在 agent 工作区跑测试 / tsc（coding 工具组） | false |
| CodeMap / FindReferences | 代码结构概览 / 引用查找 | false |
| BrowserControl | 浏览器控制（Playwright） | 按操作判断 |

破坏性 Bash（rm/git commit/npm install 等）→ 路由到父 Leader 审批，不直接问用户。

---

## 关键文件

| 文件 | 职责 |
|---|---|
| `src/index.tsx` | 入口（一行），导入 `src/runtime/AgentRuntime.tsx` |
| `src/runtime/AgentRuntime.tsx` | 主运行时：App 组件、Ink 渲染、事件接线、审批、退出路径 |
| `src/runtime/`（其余） | M1-6 拆分出的编排模块：LeaderHandler / WorkerHandler / OrchestratorRuntime / TaskScheduler / TurnController / ConversationRuntime / FollowupRouter / MemoryRuntime / ToolRuntime / ObservabilityRuntime / HealthMetrics / protocolHealth / AgentIdlePolicy / AgentOSJournal(+Bridge) / FeishuBridge / TerminalRestore |
| `src/tui/` | 单主视图渲染管线（M3-7）：snapshot（store→读模型）→ render → Transcript；斜杠命令定义 `commands.ts` |
| `src/ui.tsx` | 三栏 chrome 组件：TitleBar / AgentsPane / ConvPane / TodoPane / StatusBar / InputBar + 调色板 |
| `src/adapters/httpAgent.ts` | LLM HTTP 对话，SSE 流解析，history trimming，resume 加载 |
| `src/memory/MemoryStore.ts` | `.spawn/memory/` 唯一 I/O 层，原子写，session 管理 |
| `src/memory/SecretaryProxy.ts` | 订阅 TuiEvent，自动维护 AgentMemory，btw 处理，60s 快照 |
| `src/memory/retrieval.ts` | M3-1：goal 相关度检索（retrieveByGoal）+ 冷归档 |
| `src/pm/ProcessManager.ts` | spawn 前置校验，60min 硬超时，软超时 nudge，告警 |
| `src/tools/registry.ts` | 工具注册表，executeTool，toolNeedsApproval，buildToolSchemaBlock |
| `src/feishu/` | 飞书通道：websocket 接入 / dedupe / input-window / replyAggregator / outbound（卡片渲染、话题回复） |
| `src/store.ts` | Zustand store，applyEvent，UI 状态 |
| 仓库根 `prompts/`（`--prompts=<dir>` 可覆盖） | **活的**系统 prompt：`_base.md`（通用）+ `pm.md`（PM：Stage 0 决策表、硬约束）+ `leader.md` + `worker.md` + `pm-reference.md`；有结构守护测试（`pm-slim-guard`、`stage0-prompt-guard` 等） |
| `tui-ink/prompts/`（本目录） | ⚠️ **旧副本，默认不加载**——改 prompt 请改仓库根 `prompts/`，这里改了不生效 |
| `PM.md`（本目录） | PM spawn 决策规则与教训（知识库，持续更新；**勿整体覆盖**） |

---

## TUI 快捷键

| 键 | 动作 |
|---|---|
| Tab | 切换选中 Agent |
| `[` / `]` | 滚动对话（旧/新） |
| `P` | Pause 当前 Agent |
| `F` | Fork 新 Leader/Worker（从当前 Agent） |
| `y` / `n` | 审批待批工具 |
| Ctrl+T | 切换 plan 视图（0→1→2 循环） |
| Ctrl+L | 切换 chat / logs 视图 |
| Ctrl+C / `q` | 退出 |

**斜杠命令**（定义在 `src/tui/commands.ts`）：
`/resume` `/sessions` `/memory` `/fanout` `/pause` `/effort` `/prune` `/rate` `/schedule` `/tasks` `/metrics` `/budget` `/model` `/connect` `/web` `/feishu` `/alerts` `/status` `/log` `/palette` `/zen` `/test [headless|unit|full|e2e]` `/quit`

---

## 测试

当前 **574 用例 / 143 suite**（`npm test`，0 fail）。按域分布：

```
src/tests/
├── smoke / integration / pm-hierarchy / registry*   # store、SecretaryProxy、层级、工具注册表
├── baseline/                                         # 事件序列快照（full-duplex / orchestration golden）
├── runtime/                                          # 拆分后各模块单测（turn/scheduler/idle/journal/terminal-restore…）
├── feishu/ + inbound/ + feishu-stream                # 飞书通道（dedupe/input-window/aggregator/outbound）
├── eval/                                             # parser 评测集、token budget、决策提取、双轨等价
├── tui/                                              # 渲染管线（render / snapshot，CJK 宽度精确断言）
├── e2e/                                              # MockLLM 驱动的端到端（smoke/regression/agent/stability）
└── e2e/headless/                                     # 协议解析、PM 规则、prompt 结构守护
```

- Grep/Glob 测试用 `hasRg` 守卫：rg 不在 PATH 时自动 skip，CI 安装 rg 后真正运行
- ⚠️ 新增测试文件若"消失"：先查 `.gitignore`——曾有 `tests/` 未锚定规则把 `src/tests/` 新文件静默忽略（2026-08 已修，规则须以 `/` 锚定）

---

## CI (`.github/workflows/ci.yml`)

- `ubuntu-latest`，Node 22
- 步骤：`apt install ripgrep` → `npm ci` → `typecheck` → `npm test`
- 触发：push/PR 到 main

---

## 平台注意事项

- **Windows**：原子 rename 是 best-effort；EPERM（AV 扫描器持文件锁）已全部 try/catch
- **Linux/Mac**：rename 真正原子；rg 需要手动安装
- `chcp 65001` 仅在 `process.platform === "win32"` 时注入（中文 Windows GBK 编码修复）
- `spawnSync` 检测 rg 时用字符串命令而非 args 数组，避免 shell `$0` 位置参数陷阱
- **Windows 终端恢复**：Node 的 stdout 对 Windows TTY 是**异步写**，`exit` 处理器里的 `process.stdout.write` 会在进程终止前被丢弃（Linux/macOS 同步，故不暴露）。所有退出路径（exit / SIGINT / SIGTERM / requestExit）的终端恢复序列必须走 `src/runtime/TerminalRestore.ts` 的 `writeTermSync`（`fs.writeSync(1, …)`）。新增退出路径时沿用，勿直接用 stdout

---

## Spawn 1.0 专项文档

1.0 版本（结构优化 + 自主进化埋点）的方案、工作计划、回归记录统一放在 `docs/spawn-1.0/`：
- `PLAN.md` — 定调方案（G1-G8、HealthMetric 契约、WS1-6、M0-M4）
- `WORKPLAN.md` — 任务级工作计划（状态在此更新，任务关闭以「回归验证」列为准）
- `ADR-001-cordis-kernel.md` — M4 内核换底（cordis）决策：加性并存，B0–B4 分阶段，每阶段 golden 逐字节不变
- `regression/` — 里程碑出口/发布的回归记录（没有回归记录的里程碑不得关闭）
- `archive/` — 历史版本快照

---

## 近期重要变更（供上下文参考）

- **M1-6 god-file 拆分完成**：`index.tsx` 收敛为一行入口，编排逻辑拆入 `src/runtime/*`（LeaderHandler / WorkerHandler / OrchestratorRuntime / TaskScheduler / TurnController / ConversationRuntime / FollowupRouter / 各 Runtime）
- **M3-7 新渲染管线**：`src/tui/` snapshot→render→Transcript 单主视图，CJK 宽度逐行精确断言（Ctrl+T plan 视图、Ctrl+L chat/logs）
- **M3-1 记忆升级**：goal 相关度检索（`retrieveByGoal`，CJK 语义）+ 冷归档；M3-6 安全模型 + 矩阵测试
- **飞书通道**：WebSocket 接入 + 去重/input-window/回复聚合 + 图片/文件发送 + 话题（thread）回复
- **M2 双轨与观测**：provider capabilities（M2-1）、双轨等价判定框架（M2-2）、协议健康度评分（M2-3）、parser 评测集（M2-4，源自 3500 次真实 parse 失败挖掘）
- **Windows 退出终端恢复**：`TerminalRestore.ts` 同步写修复鼠标上报/粘贴模式泄漏（详见平台注意事项）
- **M4 内核换底（cordis）**：方案已定（ADR-001，`@deepseek-ai/cordis@4.0.1`，spike 已验证四项行为契约），B0–B4 未开始
- **稳定约定**：5-session 滑动窗口、resume 60K token-budget、Worker seed facts（父 TL 最近 5 条 facts）、PM Stage 0 硬约束（有运行中 TL 时不得打断）
