# Multi-Agent TUI · 落地说明

> 把 wireframe 变成真能跑的终端工具,并让 Claude Code / OpenCode + DeepSeek
> 这种"已经有自己 UI"的 agent 老老实实在我们的壳里干活。

## 1 · 能跑在 terminal 吗?

能。三个备选,选一个就行:

| 栈 | 语言 | 为啥选 | 坑 |
|---|---|---|---|
| **Ink** | Node + React | wireframe 的 JSX 几乎原样能用;Claude Code 自己就是 Ink 写的 | 性能/启动比 Bubble Tea 慢 |
| **Textual** | Python | CSS-like 语法,自带 mouse + responsive | 字体/字宽问题多一点 |
| **Bubble Tea** | Go | 最快、最稳、生态最好 (lipgloss/bubbles) | 得重写,不能复用 React 组件 |

**推荐 Ink**。`tui-frame / tui-pane / tui-row / Todo / Conversation` 这些组件改 import (`'react'` → `'ink'`,`<div>` → `<Box>`,`<span>` → `<Text>`) 就能直接落地。状态点 `◐ ◯ ✓ ⚠` 全是 Unicode,任何现代终端都渲染正常。

---

## 2 · 关键架构 — TUI 是壳,agent 是子进程

```
┌──────────────────────────────────────────┐
│            TUI host (Ink)                │
│   panes · tabs · DAG · todos · input     │
└──┬─────────┬─────────┬───────────────────┘
   │ JSON    │         │   stdin: user input + tool.result
   │ stdout  │         │   stdout: 协议事件 (JSON Lines)
   ▼         ▼         ▼
 leader   secretary  coder-01
 (Claude) (DeepSeek) (Claude)
```

**核心思想**:agent **不绘制 UI**,只描述状态。TUI 把这些状态事件渲染成
你设计的那些 pane/todo/dag。这就是"强约束"的物理基础 —
agent 没法画 UI,只能描述 → 你完全控制视觉。

---

## 3 · 协议:5 + 2 个事件就够 (JSON Lines)

每个 agent 的 stdout 就是一串 `\n` 分隔的 JSON,每行一个事件:

```jsonl
{"v":1,"type":"todo.set",   "agent":"leader","items":[{"id":"t1","state":"run","text":"生成 wireframe v1","progress":64,"started_at":1731580020}]}
{"v":1,"type":"step",       "agent":"leader","text":"reading docs/login.html"}
{"v":1,"type":"tool.call",  "agent":"coder-01","id":"tc-9","name":"write_file","args":{"path":"src/Login.tsx","content":"..."},"needs_approval":true}
{"v":1,"type":"message",    "agent":"leader","to":"user","text":"v1 已出。要继续 v2 吗?"}
{"v":1,"type":"spawn",      "parent":"leader","child":"coder-01","role":"Worker","goal":"实现 LoginForm","model":"claude-sonnet-4.5"}
{"v":1,"type":"agent.done", "agent":"coder-01","success":true,"reason":"3 files written, tests green"}
{"v":1,"type":"agent.error","agent":"web-scout","code":"rate_limit","retry_in":30}
```

TUI → agent 方向 (写到 agent 的 stdin):

```jsonl
{"type":"user.message","agent":"leader","text":"换成纸色"}
{"type":"tool.result","agent":"coder-01","id":"tc-9","ok":true,"output":"wrote 124 lines"}
{"type":"tool.reject","agent":"coder-01","id":"tc-9","reason":"用户取消"}
{"type":"control","agent":"coder-01","action":"pause"}
```

任何**不是合法 JSON 的输出 → 整段丢弃 + 回一条 `protocol.error` 让 agent 重试**。
这是最硬的约束。

---

## 4 · Prompt 强约束 — 怎么让 agent 守规矩

见 `prompts/` 目录:

- `prompts/_base.md` — 公共前导,5 件事:输出协议、工具白名单、审批门、不越界、错误重试。**所有 agent 都吃这一份。**
- `prompts/leader.md` — 只有 Leader 能 `spawn`、能给用户回 `message`。
- `prompts/secretary.md` — 不能写文件,只能 read / 整理 / 通知。
- `prompts/worker.md` — 只能在 Leader 给的 `goal` 范围里干活,完了就 `agent.done`。

**关键 4 条物理 + 文字双重约束**:

1. **工具白名单是物理的** — 用 `--allowed-tools` 这种 CLI flag 强切。
   prompt 说了也没用,得是运行时 deny。
2. **输出必须是 JSON** — TUI 端有 parser,非 JSON 直接丢。agent 学一次就会了。
3. **每一步先 `todo.set` 再干** — 让用户随时能看见 plan,也方便中断/回放。
4. **任何副作用 (write/push/curl) 都 `needs_approval: true`** — 不批不执行。

---

## 5 · 接 Claude Code

Claude Code 有个少有人用但完美适合做 sub-agent 的模式:`-p` (print mode)
+ stream-json 输出。

```bash
claude \
  -p "$USER_PROMPT" \
  --system-prompt-file ./prompts/leader.md \
  --append-system-prompt "你的 agent id = leader" \
  --allowed-tools "Read,Grep,Glob,Bash(git status:*),Bash(git diff:*)" \
  --disallowed-tools "Bash(rm:*),Bash(git push:*)" \
  --output-format stream-json \
  --max-turns 30 \
  --model claude-sonnet-4-5
```

要点:
- `-p` 不进它自己的 TUI,纯 stdin/stdout。
- `--system-prompt-file` 注入你的强约束。
- `--allowed-tools` 是**物理隔离**,prompt 之外的第二层防线。
- `--output-format stream-json` 给你一行一个事件的 JSON;你写个 adapter 把
  Anthropic 的 message schema → 你的 5 种事件 schema。
- `--max-turns` 防跑飞;Leader 30,Worker 15。
- Session 续:`claude --resume <session-id> -p "$next_turn"`。

适配层 ~30 行 TS:`anthropic_event → tui_event`,主要映射:
- `content_block_start.tool_use` → `tool.call`
- `content_block_delta.text` → 攒到完整再 emit `message`
- `tool_result` 不发 — 你的 TUI 自己注入

---

## 6 · 接 OpenCode + DeepSeek

OpenCode 走 OpenAI 兼容 API,DeepSeek 直接是 OpenAI compatible:

```bash
# ~/.config/opencode/auth.json
{ "deepseek": { "api_key": "sk-..." } }

# ~/.config/opencode/opencode.json
{
  "model": "deepseek/deepseek-chat",
  "agents": {
    "leader":  { "tools": ["read","grep","glob","bash"], "tools_deny": ["edit","write","webfetch"] },
    "worker":  { "tools": ["read","edit","write","bash"], "max_iterations": 15 }
  }
}
```

```bash
opencode run \
  --print \
  --agent worker \
  --model deepseek/deepseek-chat \
  --system "$(cat prompts/worker.md)" \
  "$TASK"
```

DeepSeek-V3 / DeepSeek-Reasoner 都行;Reasoner 适合 Leader (规划),V3 适合
Worker (执行)。

DeepSeek 不像 Claude 那么严格守 system prompt,所以**协议违规率会高一点**。
对策:
- 在 base prompt 里多举 2 个反例 ("❌ 不要这样写: ... ✅ 这样:...")
- TUI 端 parser 容忍多余的 ` ```json ` fence,strip 掉再 parse
- 头 3 轮如果 parse 失败 → 退回 Claude

---

## 7 · 用户输入怎么路由

```
用户在 input 框敲:                    TUI 行为:
─────────────────────────────────    ──────────────────────────────
"画一个 wireframe"                    → 默认发给当前选中的 agent (Leader)
"@coder-01 改这行"                    → @-mention 路由到那个 agent
"/fork coder-01 用 deepseek 重跑"    → 拷贝 session,新进程
"/pause"                              → control.pause 当前 agent
"Esc"                                 → control.interrupt 当前 step
"⌘K spawn tester"                     → leader 收到一条 user.message
                                        "spawn a tester agent for ..."
```

`@-mention` 是给用户的;**agent 之间通讯也走 `message` 事件**,但 `to` 字段
是另一个 agent id。Leader 不能让 Worker 越过 Leader 直接对用户说话 —
Worker 的 `message.to` 只能是 `"leader"`。这是 prompt 约束 + TUI 端校验
双重保证。

---

## 8 · 极简 MVP 顺序

```
Step 1 · 协议 parser            一个 Zod schema + 一个 stdin/stdout pump
Step 2 · Ink 移植 V1 三栏        wireframe 组件改 Box/Text,接 store
Step 3 · 接一个 Claude leader    --output-format stream-json + adapter
Step 4 · 加 spawn → coder-01    Leader 发 spawn 事件 → 启第二个 child
Step 5 · 加 approval gate       needs_approval=true → TUI 弹 inline 卡
Step 6 · 加 DeepSeek worker     OpenCode 跑 worker.md,验证两端混用
Step 7 · 加 DAG view            用 spawn 边构图,V3 视图直接复用
```

每一步都可以截图 commit,不会卡死。
