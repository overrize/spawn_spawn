# multi-agent TUI

终端 multi-agent 协作界面。Leader / Secretary / Worker 三层架构，支持 spawn DAG、审批门、会话恢复。

## 快速开始

```bash
cd tui-ink
npm install

# demo 模式（不需要 API key，模拟事件流）
npm run demo

# 真实模式：先配置 API key，再启动
npm start
```

### 配置 API Key

**推荐方式：复制模板文件**

```bash
# Linux / macOS
mkdir -p ~/.config/multi-agent-tui
cp tui-ink/config.example.json ~/.config/multi-agent-tui/config.json
# 然后编辑 config.json，填入你的 apiKey

# Windows
mkdir %USERPROFILE%\.config\multi-agent-tui
copy tui-ink\config.example.json %USERPROFILE%\.config\multi-agent-tui\config.json
```

配置文件路径：`~/.config/multi-agent-tui/config.json`

支持的 provider：

| preset | baseUrl |
|---|---|
| `anthropic` | https://api.anthropic.com（原生格式） |
| `deepseek` | https://api.deepseek.com |
| `openai` | https://api.openai.com |
| `ollama` | http://localhost:11434（本地，apiKey 填任意值） |

**也可以在 TUI 内用命令配置**（逐角色设置，自动写入文件）：

```
/connect leader deepseek deepseek-chat sk-YOUR_KEY
/connect worker deepseek deepseek-chat sk-YOUR_KEY
/connect secretary deepseek deepseek-chat sk-YOUR_KEY
```

## 目录结构

```
.
├── prompts/                    角色 prompt
│   ├── _base.md                公共前导：协议格式 + 铁律
│   ├── leader.md               Leader：spawn / 路由 / 汇总
│   ├── secretary.md            Secretary：btw 旁路 + memory
│   └── worker.md               Worker：goal 边界 + agent.done
│
└── tui-ink/                    终端 UI（Ink / React）
    └── src/
        ├── protocol.ts         事件协议类型定义
        ├── store.ts            全局状态 + applyEvent
        ├── ui.tsx              三栏 Ink 组件
        ├── index.tsx           入口：快捷键 / 路由 / agent 生命周期
        ├── agent.ts            Claude Code 子进程 adapter
        ├── adapters/
        │   ├── httpAgent.ts    HTTP streaming adapter（DeepSeek / OpenAI）
        │   └── opencode.ts     OpenCode adapter
        ├── pm/
        │   └── ProcessManager.ts  PM：超时 / 告警 / 权限检查
        ├── memory/
        │   └── SecretaryProxy.ts  Secretary 自动 memory
        └── tools/
            └── registry.ts    工具白名单 + 执行器
```

## 布局

```
┌────────────────────────────────────────────┐
│ ● ● ● multi-agent · inbox          [q]uit │  ← TitleBar
├──────────┬─────────────────────┬──────────┤
│ AGENTS   │ ◆ leader            │ TODO     │
│  ◐ lead  │   消息内容…         │ ◯ 分析   │
│  · w-01  │                     │ ◐ 执行   │
│  ✓ w-02  │                     │ ✓ 汇总   │
├──────────┴─────────────────────┴──────────┤
│ > 输入框                                   │  ← InputBar
│ log:info  [ up ] dn  y/n approve  q quit  │  ← StatusBar
└────────────────────────────────────────────┘
```

## 功能

- **三层 agent**：Leader 规划并 spawn Worker，Secretary 处理旁路任务
- **消息协议**：JSON Lines，9 种事件类型（spawn / message / tool.call / agent.done / ...）
- **审批门**：`needs_approval: true` 的 tool.call 暂停等待 y/n
- **PM（ProcessManager）**：并发检查、权限校验、软超时 nudge
- **会话恢复**：`/resume [agentId]` 从 memory snapshot 继续
- **鼠标滚轮**：ConvPane 支持滚轮滚动 + 右侧滚动条指示
- **多配色**：`/palette paper|green|amber`
- **Provider**：`/connect leader anthropic|deepseek|openai|ollama <model> <key>`

## 快捷键

| 键 | 功能 |
|---|---|
| `[` / `]` | 向上 / 向下滚动历史 |
| 鼠标滚轮 | 滚动对话内容 |
| `Tab` | 切换选中 agent |
| `P` | 暂停当前 agent |
| `F` | Fork 当前 agent（新 Worker） |
| `C` | 查看当前 agent 信息 |
| `y` / `n` | 批准 / 拒绝待审批工具调用 |
| `q` | 退出 |

## Agent 协议（摘要）

```jsonc
// Leader spawn Worker
{"v":1,"type":"spawn","parent":"leader","child":"worker-01","role":"Worker",
 "goal":"一句话任务","dispatch":{"background":"...","acceptance_criteria":["..."]}}

// Worker 完成
{"v":1,"type":"agent.done","agent":"worker-01","success":true,
 "reason":"完成描述","evidence":["src/foo.ts:42 改动说明"]}

// Worker 超出边界
{"v":1,"type":"unit.handup","agent":"worker-01","parent":"leader",
 "summary":"已完成 X，无法继续因为 Y",
 "findings":[{"level":"CRITICAL","text":"发现问题"}]}
```

完整协议见 `tui-ink/src/protocol.ts`，角色约束见 `prompts/`。
