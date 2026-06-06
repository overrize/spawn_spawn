# multi-agent TUI

终端多 Agent 协作界面。PM → Tech Lead → Worker 三层架构，HTTP 流式 LLM，支持 spawn DAG、工具审批、会话恢复。

## 快速开始

```bash
cd tui-ink
npm install

# demo 模式（不需要 API key，模拟事件流）
npm run demo

# 真实模式：先配置 API key，再启动
npm start
```

### 系统依赖

需要安装 **ripgrep**（Grep / Glob 工具依赖）：

```bash
apt install ripgrep        # Linux
brew install ripgrep       # macOS
scoop install ripgrep      # Windows（需在系统 PATH）
```

### 配置 API Key

```bash
# Linux / macOS
mkdir -p ~/.config/multi-agent-tui
cp tui-ink/config.example.json ~/.config/multi-agent-tui/config.json
# 编辑 config.json，填入 apiKey

# Windows
mkdir %USERPROFILE%\.config\multi-agent-tui
copy tui-ink\config.example.json %USERPROFILE%\.config\multi-agent-tui\config.json
```

**也可以在 TUI 内用命令配置**（自动写入文件）：

```
/connect leader anthropic claude-sonnet-4-5 sk-ant-YOUR_KEY
/connect worker deepseek deepseek-chat sk-YOUR_KEY
```

支持的 provider：

| preset | 说明 |
|---|---|
| `anthropic` | https://api.anthropic.com（原生格式） |
| `deepseek` | https://api.deepseek.com |
| `openai` | https://api.openai.com |
| `ollama` | http://localhost:11434（本地，apiKey 填任意值） |

---

## 架构

```
PM (depth=0, role=Leader)
└── Tech Lead (depth=1, role=Leader)   ← PM spawn 的
    └── Worker (depth=2, role=Worker)  ← TL spawn 的
```

- PM 不能直接 spawn Worker（`pm_cannot_spawn_worker` 错误）
- Worker 不能 spawn 任何人（`worker_cannot_spawn` 错误）
- 最大并发子节点 4（`/fanout N` 调整）
- Worker → user 消息非法，自动转发至 parent 并纠正

每个 Agent 是一次 HTTP 流式 LLM 对话，由 SecretaryProxy 负责记录 memory，ProcessManager 负责生命周期监控。

---

## 布局

```
┌────────────────────────────────────────────┐
│ ● ● ● multi-agent · inbox          [q]uit │  ← TitleBar
├──────────┬─────────────────────┬──────────┤
│ AGENTS   │ ◆ pm                │ TODO     │
│  ◐ pm    │   消息内容…         │ ◯ 分析   │
│  · tl-01 │                     │ ◐ 执行   │
│  ✓ w-01  │                     │ ✓ 汇总   │
├──────────┴─────────────────────┴──────────┤
│ > 输入框                                   │  ← InputBar
│ log:info  [ up ] dn  y/n approve  q quit  │  ← StatusBar
└────────────────────────────────────────────┘
```

---

## 可用工具

Agent 可调用的工具（共 8 个）：

| 工具 | 说明 | 需要审批 |
|---|---|---|
| `Read` | 读取文件内容（支持 offset/limit） | 否 |
| `Write` | 写入文件（创建或覆盖） | 否 |
| `Edit` | 精确字符串替换（old→new） | 否 |
| `Bash` | 执行 shell 命令 | 按命令判断 |
| `Grep` | 基于 ripgrep 的正则搜索 | 否 |
| `Glob` | 文件路径匹配 | 否 |
| `LS` | 目录列表 | 否 |
| `Think` | 内部推理记录（不输出给用户） | 否 |

破坏性 Bash（`rm` / `git commit` / `npm install` 等）路由至父 Leader 审批，不直接问用户。  
网络类命令（`curl` / `wget` / `ssh` 等）被 banned list 拦截。

---

## 快捷键

| 键 | 功能 |
|---|---|
| `Tab` | 切换选中 agent |
| `[` / `]` | 向上 / 向下滚动对话 |
| 鼠标滚轮 | 滚动对话内容 |
| `P` | 暂停当前 agent |
| `F` | Fork 当前 agent（新 Leader/Worker） |
| `C` | 查看当前 agent 详情 |
| `y` / `n` | 批准 / 拒绝待审批工具调用 |
| `q` / Ctrl+C | 退出 |

---

## 斜杠命令

| 命令 | 说明 |
|---|---|
| `/sessions` | 列出所有历史会话 |
| `/resume [agentId\|hash]` | 从 memory snapshot 恢复会话 |
| `/fanout <N>` | 设置最大并发子节点数（默认 4） |
| `/connect <role> <preset> <model> <key>` | 配置 LLM provider |
| `/palette paper\|green\|amber` | 切换配色方案 |
| `/layout` | 切换布局模式 |
| `/log` | 查看系统日志 |
| `/alerts` | 查看 PM 告警 |
| `/quit` | 退出 |

---

## Agent 协议（摘要）

```jsonc
// Leader spawn Worker（必须包含 dispatch 字段）
{"v":1,"type":"spawn","parent":"pm","child":"tl-01","role":"Leader",
 "goal":"一句话任务","dispatch":{"background":"...","constraints":[],
 "acceptance_criteria":["验收标准"],"stop_conditions":["agent.done"],"timeout_ms":600000}}

// Worker 完成
{"v":1,"type":"agent.done","agent":"worker-01","success":true,
 "reason":"完成描述","evidence":["src/foo.ts:42 改动说明"]}

// Worker 超出边界（handup）
{"v":1,"type":"unit.handup","agent":"worker-01","parent":"tl-01",
 "summary":"已完成 X，无法继续因为 Y",
 "findings":[{"level":"CRITICAL","text":"发现问题"}]}
```

完整协议见 `tui-ink/src/protocol.ts`，角色约束见 `prompts/`。

---

## 测试

```bash
cd tui-ink
npm test           # 全部测试（含 headless store / 协议解析 / 集成测试）
npm run typecheck  # TypeScript 类型检查
```

测试目录：

```
src/tests/
├── e2e/headless/
│   ├── store-events.test.ts      store applyEvent / pendingInputAgents / token supervision
│   └── protocol-parsing.test.ts  parseAgentOutput（infinite-loop / raw-JSON-leak 回归）
├── smoke.test.ts                 store 基础行为
├── integration.test.ts           SecretaryProxy / ProcessManager / HttpConvAgent / resume
├── pm-hierarchy.test.ts          PM 层级规则 / memory 持久化
└── registry.test.ts              工具注册表 + Grep/Glob
```

---

## 调试

所有日志写到 stderr，启动时重定向：

```bash
# Linux / macOS
LOG_EVENTS=1 npm start 2>debug.log
tail -f debug.log

# Windows PowerShell
$env:LOG_EVENTS=1; npm start 2>debug.log
Get-Content debug.log -Wait -Tail 50
```

`LOG_EVENTS=1` 开启完整 LLM 原始响应日志。不设置时只输出关键节点（resume 加载、网络重试、历史截断等）。

---

## 目录结构

```
.
├── prompts/                    角色 prompt
│   ├── _base.md                公共前导：协议格式 + 行动偏见铁律
│   ├── pm.md                   PM：Stage 0 并发感知 + 三阶段决策
│   ├── leader.md               Tech Lead：spawn 路由 + handup 处理
│   └── worker.md               Worker：goal 边界 + agent.done 格式
│
└── tui-ink/                    终端 UI（Ink / React + TypeScript）
    └── src/
        ├── protocol.ts         事件协议类型定义（TuiEvent / AgentCommand）
        ├── store.ts            Zustand 全局状态 + applyEvent
        ├── ui.tsx              三栏 Ink 组件
        ├── index.tsx           入口：快捷键 / 路由 / agent 生命周期
        ├── adapters/
        │   └── httpAgent.ts    HTTP 流式 adapter（Anthropic / DeepSeek / OpenAI）
        ├── pm/
        │   └── ProcessManager.ts  spawn 校验 / 超时 / 告警
        ├── memory/
        │   ├── MemoryStore.ts  .spawn/memory/ 原子 I/O
        │   └── SecretaryProxy.ts  自动维护 AgentMemory + btw 旁路
        ├── cache/
        │   └── CachePrefixManager.ts  prompt cache 前缀复用
        └── tools/
            └── registry.ts    工具白名单 + executeTool + 审批判断
```

---

## CI

GitHub Actions（`.github/workflows/ci.yml`）：
- `ubuntu-latest`，Node 22
- 步骤：`apt install ripgrep` → `npm ci` → `typecheck` → `npm test`
- 触发：push / PR 到 main
