# spawn

多 agent 对话系统。用户通过飞书或终端 TUI 发送任务，系统自动拆分并并行调度多个 LLM agent 完成，结果汇总回用户。

**开发者文档（架构、内存系统、Feishu 接入、测试）→ [tui-ink/README.md](tui-ink/README.md)**

## 快速上手

```bash
cd tui-ink
npm install
cp .env.example .env      # 填入 API key
npm run dev               # 启动 TUI
npm run dev -- --demo     # 无 API key 演示模式
```

`.env` 必填项：

```
OPENAI_API_KEY=...        # 或其他兼容 OpenAI 格式的 provider
OPENAI_BASE_URL=...       # 例如 https://api.deepseek.com
```

飞书接入（可选）：

```
FEISHU_APP_ID=...
FEISHU_APP_SECRET=...
```

### 系统依赖

需要安装 **ripgrep**（Grep / Glob 工具依赖）：

```bash
apt install ripgrep        # Linux
brew install ripgrep       # macOS
scoop install ripgrep      # Windows（需在系统 PATH）
```

**也可以在 TUI 内用命令配置 provider**：

```
/connect leader deepseek deepseek-chat sk-YOUR_KEY
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
| `/rate good\|bad [说明]` | 对刚完成的会话评分（记入 debug.log） |
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
npm start 2>debug.log
tail -f debug.log

# Windows PowerShell
npm start 2>debug.log
Get-Content debug.log -Wait -Tail 50
```

开启完整 LLM 原始响应日志（每轮 raw 输出）：

```bash
LOG_EVENTS=1 npm start 2>debug.log
```

不设置时只输出关键节点：resume 加载、网络重试、历史截断、质量评分等。

---

## 质量评分体系

每次 PM 任务完成后，系统自动在 debug.log 里写入一行结构化评分，同时在状态栏提示用户评分。

### 自动评分（客观信号）

任务结束时自动计算并写入 stderr：

```
[quality] pm session=abc1234 score=82 success=true turns=4 nudges=1 handup=false gaveUp=false rejects=0 tokens_in=4200 tokens_out=890 evidence=2
```

| 字段 | 说明 |
|---|---|
| `score` | 0–100，综合自动评分 |
| `success` | agent.done 是否成功 |
| `turns` | LLM 轮次数 |
| `nudges` | 系统催促次数（越多说明 agent 越被动） |
| `handup` | 是否触发了 unit.handup |
| `gaveUp` | 是否 3 次 nudge 全部失效 |
| `rejects` | 用户拒绝工具调用次数 |
| `tokens_in/out` | 本次会话 token 消耗 |
| `evidence` | agent.done 携带的证据条数 |

评分规则：基础 100 分，每次 nudge -8，gaveUp -25，handup -15，失败 -20，用户拒绝工具 -10；有 evidence +10，零 nudge +10。

### 人工评分（主观反馈）

任务完成后状态栏出现提示：

```
Session done — /rate good [comment] or /rate bad [comment] to rate
```

输入评分命令（comment 为可选文字说明）：

```
/rate good 这次 worker 很流畅，没有卡顿
/rate bad PM 问了三次才开始做事，handup 太频繁
```

写入 debug.log：

```
[rating] pm session=abc1234 human=1 comment="这次 worker 很流畅，没有卡顿"
[rating] pm session=abc1234 human=-1 comment="PM 问了三次才开始做事"
```

`human=1` 为好评，`human=-1` 为差评。发送下一条消息时提示自动消失。

### 如何分析数据

```bash
# 提取全部评分行
grep '\[quality\]\|\[rating\]' debug.log

# 只看差评会话
grep 'human=-1' debug.log

# 查看低分会话（score < 60）
grep '\[quality\]' debug.log | awk -F'score=' '{print $2}' | awk '$1+0 < 60'
```

**反馈数据上传**：把 `debug.log` 上传到 GitHub issue 或直接发给开发者，`[quality]` 和 `[rating]` 行不包含任务内容，只有数字和你填写的 comment，隐私安全。

---

## 目录结构

```
spawn-work/
├── README.md                   本文件
├── tui-ink/                    主程序（Ink / React + TypeScript）
│   ├── README.md               开发者文档 ← 看这里
│   ├── .env.example            环境变量模板
│   ├── prompts/                角色 prompt
│   │   ├── _base.md            公共前导：协议格式 + 行动偏见铁律
│   │   ├── pm.md               PM：Stage 0 并发感知 + 三阶段决策
│   │   ├── leader.md           Tech Lead：spawn 路由 + handup 处理
│   │   ├── worker.md           Worker：goal 边界 + agent.done 格式
│   │   └── worker-coding.md    Worker 编码专用 prompt（工具优先级 + CRLF）
│   └── src/
│       ├── protocol.ts         事件协议类型（TuiEvent / AgentCommand）
│       ├── store.ts            Zustand 全局状态 + applyEvent
│       ├── index.tsx           入口：快捷键 / 路由 / agent 生命周期
│       ├── adapters/
│       │   └── httpAgent.ts    HTTP 流式 LLM adapter
│       ├── bus/
│       │   └── Bus.ts          SpawnBus：全局 PubSub 事件总线
│       ├── inbound/
│       │   └── feishu.ts       飞书消息解析（text/post/at）→ InboundMessage
│       ├── runtime/
│       │   ├── ConversationRuntime.ts  全双工会话状态机（base/fork）
│       │   ├── TurnController.ts       单轮输入缓冲 + 并发保护
│       │   ├── TaskScheduler.ts        异步任务队列调度
│       │   └── FollowupRouter.ts       追问路由（PM fork 接力）
│       ├── feishu/
│       │   ├── websocket.ts    飞书 WS 长连接（protobuf 解析 + 重连）
│       │   ├── outbound/
│       │   │   └── OutboundGateway.ts  统一出口：抑制 → 格式 → 消毒 → 发送
│       │   └── replyAggregator.ts      chunk 聚合 + turn-end flush
│       ├── memory/
│       │   ├── MemoryStore.ts  .spawn/memory/ 原子 I/O
│       │   └── SecretaryProxy.ts  自动维护 AgentMemory + btw 旁路
│       ├── pm/
│       │   └── ProcessManager.ts  spawn 校验 / 超时 / 告警
│       ├── execution/
│       │   └── WorkspaceBoundary.ts  worker 工作目录隔离
│       ├── cache/
│       │   └── CachePrefixManager.ts  prompt cache 前缀复用
│       └── tools/
│           └── registry.ts    工具白名单 + executeTool + 审批判断
```

---

## CI

GitHub Actions（`.github/workflows/ci.yml`）：
- `ubuntu-latest`，Node 22
- 步骤：`apt install ripgrep` → `npm ci` → `typecheck` → `npm test`
- 触发：push / PR 到 main
