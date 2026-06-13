# CLAUDE.md — multi-agent TUI (tui-ink)

Claude Code 的项目说明文件。每次开新会话时自动加载。

---

## 项目概览

多 Agent TUI，使用 Ink/React + TypeScript。架构：PM (depth=0) → Tech Lead (depth=1) → Worker (depth=2)。
每个 Agent 是一次 LLM HTTP 对话，由 SecretaryProxy 负责记录 memory，ProcessManager 负责生命周期监控。

**入口**：`src/index.tsx`  
**运行**：`npm run dev`（支持 `--demo` 无 API key 演示，`--model=<id>` 覆盖模型）

---

## 常用命令

```bash
npm run dev          # 启动 TUI（live 模式）
npm run dev -- --demo  # 演示模式，不需要 API key
npm run typecheck    # tsc --noEmit
npm test             # 跑全部测试 (114 个用例)
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

破坏性 Bash（rm/git commit/npm install 等）→ 路由到父 Leader 审批，不直接问用户。

---

## 关键文件

| 文件 | 职责 |
|---|---|
| `src/index.tsx` | 入口，`startLeaderAgent` / `startWorker`，TUI React 组件，命令处理 |
| `src/adapters/httpAgent.ts` | LLM HTTP 对话，SSE 流解析，history trimming，resume 加载 |
| `src/memory/MemoryStore.ts` | `.spawn/memory/` 唯一 I/O 层，原子写，session 管理 |
| `src/memory/SecretaryProxy.ts` | 订阅 TuiEvent，自动维护 AgentMemory，btw 处理，60s 快照 |
| `src/pm/ProcessManager.ts` | spawn 前置校验，60min 硬超时，软超时 nudge，告警 |
| `src/tools/registry.ts` | 工具注册表，executeTool，toolNeedsApproval，buildToolSchemaBlock |
| `src/store.ts` | Zustand store，applyEvent，UI 状态 |
| `src/ui.tsx` | Ink 组件：TitleBar / AgentsPane / ConvPane / TodoPane / StatusBar |
| `prompts/pm.md` | PM 系统 prompt，Stage 0 决策表，硬约束（不能主动 kill 运行中的 TL） |
| `prompts/leader.md` | Tech Lead 系统 prompt |
| `prompts/worker.md` | Worker 系统 prompt |

---

## TUI 快捷键

| 键 | 动作 |
|---|---|
| Tab | 切换选中 Agent |
| `[` / `]` | 滚动对话（旧/新） |
| `P` | Pause 当前 Agent |
| `F` | Fork 新 Leader/Worker（从当前 Agent） |
| `C` | 查看当前 Agent 信息 |
| `y` / `n` | 审批待批工具 |
| Ctrl+C / `q` | 退出 |

**斜杠命令**：`/sessions` `/resume <id|hash>` `/fanout <N>` `/connect <role> <preset> <model> <key>` `/palette` `/layout` `/log` `/alerts` `/quit`

---

## 测试

```
src/tests/
├── smoke.test.ts           # store 基础行为（applyEvent / scroll / approve）
├── integration.test.ts     # SecretaryProxy / ProcessManager / HttpConvAgent / resume
├── pm-hierarchy.test.ts    # PM 层级规则 / memory 持久化
├── registry.test.ts        # 工具注册表 + Grep/Glob（有 rg 才跑）
└── registry-enoent.test.ts # rgNotFoundResult 纯函数
```

Grep/Glob 测试用 `hasRg` 守卫：rg 不在 PATH 时自动 skip，CI 安装 rg 后会真正运行。

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

---

## 近期重要变更（供上下文参考）

- **session-level 消息历史**：从 5-message 滑动窗口改为 5-session 滑动窗口，每 session 内消息完整保留
- **resume token-budget**：60K chars 上限，最新→最旧截断，最后 4 条强制保留
- **Worker seed facts**：spawn 时注入父 TL 的 `working_set.facts[-5:]`
- **PM Stage 0 硬约束**：有运行中 TL 时，PM 只能 fork 新 TL 或自己处理，不能打断旧 TL
- **rg 启动探测**：boot 时 `spawnSync` 检测 rg，缺失时打印安装提示
