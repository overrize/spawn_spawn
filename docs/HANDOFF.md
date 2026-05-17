# HANDOFF · 给 Claude Code 的实施指令

> **启动话术 (复制贴到对话框)**:
>
> 读 `docs/HANDOFF.md`,严格按它来。先 Step 0 自检环境,再从 Step 1
> 开始,每个 step 跑完 acceptance 测试我看截图确认,再做下一个。不要跳步,
> 不要扩大范围。

---

## §0 · 你的角色与硬约束 (7 条铁律)

你的任务:在 `tui-ink/` 里补完接口,让 multi-agent TUI 产线可用。
设计稿在 `index.html`,协议在 `tui-ink/src/protocol.ts`,提示词在 `prompts/`。

**铁律 (违反 = 直接退回返工)**:

1. **不发明新事件类型**。协议就 `protocol.ts` 里那 9 个。缺什么先问用户。
2. **不偏离视觉**。颜色、字形、布局比例已在 `wireframes/` 定死。
   状态点必须是 `◐ ◯ ✓ ⚠ ✗`,禁止换 emoji 或加 badge。
3. **不引入新依赖**。`tui-ink/package.json` 里有什么用什么。需新依赖 → 先停下问。
4. **不绕过审批**。`needs_approval: true` 的工具调用,UI 必须阻塞卡片,
   用户按 `y/n` 之前禁止执行。
5. **不让 agent 直接渲染**。agent 输出 = JSON 事件。ANSI 色、markdown fence、
   散文 → parser 必须丢弃。
6. **一次一文件**。改完一个文件就 `npm run typecheck` + `--demo` 跑一遍截图。
   绝不一口气改多个文件。
7. **不写测试**,除非该 step 明确要求。

---

## §1 · 必读 (按顺序)

```
docs/AGENTS.md                   协议架构 + Claude Code / OpenCode 接法
prompts/_base.md                 强约束 prompt — 9 个事件 + 5 条铁律
prompts/leader.md                Leader 权限边界 + spawn 规则
prompts/worker.md                Worker 边界 + 节奏
tui-ink/README.md                雏形跑法 + 已知简化清单
tui-ink/src/protocol.ts          全部类型定义 (这是合约,不能改)
tui-ink/src/store.ts             事件 → 状态映射 (applyEvent)
tui-ink/src/agent.ts             Claude Code 子进程 + adapter 骨架
tui-ink/src/ui.tsx               V1 三栏组件
tui-ink/src/index.tsx            路由 + 启动 + 全局快捷键
index.html (用浏览器开)          三张线框 V1/V2/V3 + spec 卡
```

读完后你应该能回答:
- `assistant.text` 里的协议 JSON 为什么会被丢弃?怎么修?
- `approve(toolId)` 目前只做了什么?缺什么?
- `spawn` 事件触发后,子进程在哪里被启动?现在是 stub?
- `_base.md` 的 5 条行为铁律是哪 5 条?
- V1 / V3 两种布局差别在哪里?

**答不上来 → 回去再读。**

---

## §2 · Step 0 · 环境自检

```bash
cd tui-ink
node --version          # ≥ 20
npm install
npm run typecheck       # 期望:0 错误
npm run dev -- --demo   # 期望:UI 在终端里跑起来
```

期望看到 (--demo 后回车任意文字):
- 左栏:AGENTS 1 + leader idle 行
- 中栏:todo 出现、spawn coder-01、approval 卡片弹出
- 右栏:TODO 列表 + 进度条
- 底部:status bar

**Acceptance**:布局和 `index.html` V1 一致 — 左窄 / 中宽 / 右窄。截图确认。
不通过 → 禁止往下走。

---

## §3 · Step 1 · 修 agent 协议解析 (最关键接口缺口)

**目标**:`agent.ts.handleLine` 正确解析 agent 在 `assistant.text` 里输出的协议 JSON。

**背景**:当前代码收到 `assistant.text` 就直接 emit `TuiEvent.message`。
但 agent 遵循 `_base.md`,所有输出都是 JSON Lines (todo.set/step/message/spawn…)。
现在所有协议事件都被吞掉,只剩裸文本气泡。这是最关键缺口。

**只改一个文件**:`tui-ink/src/agent.ts`

在 `handleLine` 的 `assistant.text` 分支里:

```typescript
// 旧代码 (丢失协议):
if (c.type === "text" && c.text?.trim()) {
  this.emit("event", { v: 1, type: "message", agent: id, to: "user", text: c.text });
}

// 新代码:逐行解析协议 JSON
if (c.type === "text" && c.text?.trim()) {
  for (const line of c.text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.v === 1 && parsed?.type) {
        // 合法协议事件 — 直接转发,补上 agent 字段
        this.emit("event", { ...parsed, agent: parsed.agent ?? id } as TuiEvent);
        continue;
      }
    } catch { /* 非 JSON,走 fallback */ }
    // fallback:散文 → message 气泡 (正常不应出现)
    this.emit("event", { v: 1, type: "message", agent: id, to: "user", text: trimmed } as TuiEvent);
  }
}
```

**Acceptance**:
- `npm run typecheck` 0 错误
- `npm run dev -- --demo` 仍然正常 (demo 绕过这段逻辑)
- live 模式:往 leader 发话,todo 条目从 agent JSON 正确渲染而非裸文字

**禁止**:
- ❌ 修改 `protocol.ts`
- ❌ 在 `agent.ts` 里 `console.log` (污染 stdout)

---

## §4 · Step 2 · AgentCommand 完整发送

**目标**:`agent.ts` 能发送所有 `AgentCommand` 类型;加 `--permission-mode plan`。

**只改一个文件**:`tui-ink/src/agent.ts`

1. 把 `send(text)` 重命名为 `sendCommand(cmd: AgentCommand)` 并完整实现:

```typescript
sendCommand(cmd: AgentCommand): void {
  if (!this.proc?.stdin || this.proc.killed) return;
  let payload: unknown;
  switch (cmd.type) {
    case "user.message":
      payload = { type: "user", message: { role: "user",
        content: [{ type: "text", text: cmd.text }] } };
      break;
    case "control":
      if (cmd.action === "interrupt") { this.proc.kill("SIGINT"); return; }
      if (cmd.action === "pause")     { this.proc.kill("SIGSTOP"); return; }
      if (cmd.action === "resume")    { this.proc.kill("SIGCONT"); return; }
      return;
    default:
      return; // tool.result / tool.reject 由 permission-mode 处理
  }
  if (payload) this.proc.stdin.write(JSON.stringify(payload) + "\n");
}
```

2. 在 `start()` 的 `args` 里加:

```typescript
"--permission-mode", "plan",
```

3. 更新 `index.tsx` 里所有 `a.send(body)` → `a.sendCommand({ type: "user.message", text: body })`

**改动顺序**:agent.ts → typecheck → index.tsx → typecheck → demo。

**Acceptance**:`/pause` 命令实际 SIGSTOP 子进程,`/resume` 恢复。

---

## §5 · Step 3 · 审批真阻塞

**目标**:用户按 `n` 时 Claude Code 真的不执行工具;按 `y` 才执行。

**机制**:`--permission-mode plan` 让 Claude Code 在工具调用前打出 permission
prompt 等待 y/n。TUI 从 stderr 捕获这条 prompt。

**改两个文件,依次**:

**文件 1** `tui-ink/src/agent.ts`:
- 在 `proc.stderr.on("data")` 里:先查 `which claude && claude --help` 确认
  permission prompt 的准确字符串格式
- 捕获到 → 解析工具名 + 参数 → emit `tool.call` 事件 + `needs_approval: true`
- 记录 `this.pendingPermId`

**文件 2** `tui-ink/src/index.tsx`:
- `approve(toolId)`:找到对应 Agent → `proc.stdin.write("y\n")`
- `reject(toolId)`:写 `"n\n"`
- 把上面两函数传给 store 的 approve/reject hook

**!! 注意**:如果 `claude --help` 没有 `--permission-mode` flag → 停下问用户,不要猜。

**Acceptance**:
```bash
npm run dev
# 输入:"在当前目录建一个空文件 hello.txt"
# 弹出 approval 卡片 → 按 n → hello.txt 不存在
# 重试 → 按 y → hello.txt 被创建
```

**禁止**:
- ❌ 默认通过 (y/n 必须等待)
- ❌ stderr handler 里 `console.error`

---

## §6 · Step 4 · Worker 子进程真 spawn

**目标**:`spawn` 事件 → 真启动子进程。

**只改一个文件**:`tui-ink/src/index.tsx`

在 `applyEvent` 调用链之后,订阅 store 变化检测新 agent:

```typescript
let knownAgents = new Set<string>();

subscribe(() => {
  const st = getState();
  for (const [id, info] of st.agents) {
    if (knownAgents.has(id) || agents.has(id)) continue;
    knownAgents.add(id);
    if (info.role !== "Leader") startWorker(info);
  }
});

function startWorker(info: AgentInfo): void {
  const sysPath = writeTmpPrompt(info.role, info.id, info.sub ?? "");
  const a = new Agent({
    id: info.id, role: info.role as any,
    systemPromptFile: sysPath,
    initialPrompt: info.sub ?? "complete the goal",
    model: info.model ?? "claude-sonnet-4-5",
    allowedTools: ["Read", "Grep", "Glob", "Write", "Edit"],
    maxTurns: 15,
  });
  agents.set(info.id, a);
  a.on("event", (e: TuiEvent) => applyEvent(e));
  a.start();
}
```

**Acceptance**:
- demo 模式:spawn coder-01 后左栏出现 coder-01 行
- live 模式:用户说 "spawn a worker",左栏出现 ◐ worker 行

**禁止**:
- ❌ spawn 时不带 `--max-turns`
- ❌ 临时 prompt 文件写到项目目录 (用 `os.tmpdir()`)

---

## §7 · Step 5 · OpenCode + DeepSeek adapter

**目标**:model 是 `deepseek-*` 时用 OpenCode 子进程。

**新建一个文件**:`tui-ink/src/adapters/opencode.ts`

实现 `class OpenCodeAgent extends EventEmitter` 与 `Agent` 相同接口:
- `start()`:拉起 `opencode run --print --model deepseek/deepseek-chat "$GOAL"`
- 每行 stdout:先去掉 ` ```json ` fence → 解析 JSON → emit TuiEvent
- 连续 3 行 parse 失败 → emit `agent.error { code: "parse_failure" }` → 停止

**改 `index.tsx`**:
```typescript
const a = info.model?.startsWith("deepseek")
  ? new OpenCodeAgent({ id: info.id, goal: info.sub ?? "", model: info.model })
  : new Agent({ ... });
```

**Acceptance**:
- spawn deepseek worker → 左栏出现,中栏至少有 1 条 todo + 1 条 message
- 不带 API key 时 → `agent.error` 出现,不 crash

**禁止**:
- ❌ API key 硬编码 (从 `DEEPSEEK_API_KEY` env 读)
- ❌ 复制 agent.ts 大段代码 (提取公共 base)

---

## §8 · Step 6 · Sessions pane

**目标**:V1 布局加 sessions 中间栏 (width=22),每 agent 可有多 session。

**按顺序改三个文件**:

**1. `tui-ink/src/protocol.ts`** — 加 Session 类型 (唯一允许改 protocol.ts 的 step):
```typescript
export interface Session {
  id: string;
  agentId: string;
  title: string;
  createdAt: number;
  messageCount: number;
}
```

**2. `tui-ink/src/store.ts`** — 加 sessions 状态:
- `sessionsByAgent: Map<string, Session[]>`
- `currentSessionByAgent: Map<string, string>`
- `newSession(agentId)` / `switchSession(agentId, sessionId)` 动作
- `system.init` → 把 `sessionId` 存入 store 并关联 agent

**3. `tui-ink/src/ui.tsx`** — 加 `SessionsPane` 组件:
- 列出当前 agent 的 sessions,选中高亮
- 布局变为:`<AgentsPane 22/>` + `<SessionsPane 22/>` + `<ConvPane flex/>` + `<TodoPane 32/>`

**Acceptance**:布局字符宽度精确:22 + 22 + flex + 32。截图量一下。

**禁止**:
- ❌ 改 V1 已实现布局比例
- ❌ ui.tsx 里 import child_process

---

## §9 · Step 7 · Palette 切换

**目标**:`/palette paper|green|amber` 切配色,持久化到 `~/.config/multi-agent-tui/config.json`。

**改两个文件**:`tui-ink/src/ui.tsx` + 新建 `tui-ink/src/config.ts`:

```typescript
// ui.tsx
export const PALETTES = {
  paper: { text:"#1a1a1a", dim:"#888888", accent:"#0074d9", success:"#2ecc40", warn:"#ff851b", error:"#ff4136" },
  green: { text:"#00ff41", dim:"#007700", accent:"#00ff41", success:"#00ff41", warn:"#ffff00", error:"#ff0000" },
  amber: { text:"#ffb000", dim:"#885500", accent:"#ffb000", success:"#ffb000", warn:"#ff8800", error:"#ff0000" },
} as const;
```

用 React Context 把 palette 传给所有子组件。`/palette <name>` 命令写入配置文件。

**Acceptance**:`/palette green` 所有文字变绿色系。`/palette paper` 切回。

**禁止**:
- ❌ 用 16 进制以外的 Ink 颜色名
- ❌ palette 散落子组件

---

## §10 · Step 8-9 · DAG + 滚动 + resume + 烟测

**Step 8a — V3 DAG 视图** (`ui.tsx` 新增 `DagView`):
- `/layout v3` 切到 DAG mini-map + tabs
- 用 box-drawing 字符画层次图,BFS 算层
- 高度严格 ≤ 12 行

**Step 8b — 可滚动会话**:
- store 加 `scrollOffset`,方向键控制
- ConvPane 用 `messages.slice(offset, offset + visibleRows)`

**Step 8c — session resume**:
- store 存 sessionId (来自 system.init)
- `/resume <id>` → Agent 加 `--resume <id>` flag

**Step 9 — 烟测** (`tui-ink/tests/smoke.test.ts`):
- 跑 demo 模式
- 断言:todo 出现 / spawn coder-01 出现 / approval 卡弹出

---

## §11 · 反模式

```
❌ "thinking..." 动画占满中栏
❌ todo list 改成卡片 (设计是 ◐ ◯ ✓ 一行一条)
❌ status bar 加 emoji
❌ spawn 不带 --max-turns (烧钱)
❌ stderr 直接 console.error (污染 Ink 渲染)
❌ React class component (全 hooks)
❌ process.exit() 退出 (用 useApp().exit())
❌ ui.tsx 里 import child_process
❌ 给 agent 暴露 fs 模块 (走工具白名单)
❌ 自己写 markdown renderer (message 直接 plain text)
```

---

## §12 · Commit message 格式

```
feat(tui): step N · <title>

- 具体做了什么 (行为,不是文件名)
- acceptance 结果
- screenshot: docs/screenshots/step-N.png

Refs: docs/HANDOFF.md §N
```

每个 step 包含一张截图放 `docs/screenshots/step-N.png`。

---

## §13 · 完成定义 checklist

- [ ] `npm run typecheck` 0 错误
- [ ] `npm run dev -- --demo` 一键跑起来
- [ ] `npm run dev` 接真 Claude,leader 收发消息正常
- [ ] assistant.text 协议 JSON 正确路由 (todo.set/step/spawn 渲染)
- [ ] approval 真阻塞:按 n → 工具不执行
- [ ] spawn 事件真启动子进程
- [ ] DeepSeek worker 至少跑通一次
- [ ] sessions pane 正确显示
- [ ] 3 套 palette 都能切
- [ ] V1 / V3 两种 layout 都能切,DAG ≤ 12 行
- [ ] 会话滚动正常
- [ ] session resume 用 `--resume` 恢复
- [ ] 所有截图进 `docs/screenshots/`
- [ ] `tui-ink/README.md` 更新完成状态

完成后发 PR:
`feat(tui-ink): complete V1+V3 with leader/worker, claude+deepseek, real approval`

— 完 —
