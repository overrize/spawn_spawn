# TUI 重构设计规格（单主视图）

> 状态：v1 冻结待回归（2026-07-21，用户提案 + QA 评审）· 实现排期：M1-6e 之后（M3-7）
> 核心原则（定死）：**主视图永远只有一个；Plan 是输入栏上方的可展开层；状态栏永远可见。**

## 为什么重构而不是修

现三栏并排布局（Agents | Conv | Todo）依赖竖直分割线，要求每列每行宽度精确对齐——
中文（双宽字符）一溢出换行就顶歪整条线（BC 级渲染 bug 的结构性根源）。
单主视图 + 水平分段后：竖直分割线消失，长行只向下推，**该 bug 类别整体不存在**。
CJK 宽度计算仍需收口（行内截断），但影响面从"全屏对齐"缩到"单行截断"。

## 视图状态机

```
AgentsHome ──Enter(选中agent)──► AgentChat ──Ctrl+L──► Logs
    ▲                               │  ▲                 │
    └────────────Esc────────────────┘  └───────Ctrl+L────┘
（Plan 层：任意主视图下 Ctrl+T 循环 收起 → 半展 → 全展 → 收起；Esc 先收 Plan 再回 home）
```

### 1. Agents Home（默认态）

树形 agent 列表（层级缩进 + 状态点 ●○ + 运行时长 + 当前动作），Goal 常驻顶栏，
右上显示 model + web 状态。↑/↓ 选择，Enter 进入该 agent 的 Chat。

### 2. Agent Chat

选中 agent 的**收件箱视图**：只显示该 agent 收/发的消息（发件人名做行首标签）。
系统消息（nudge/审批结果/handup）用 dim 样式区分。

### 3. Plan 层（Ctrl+T 三态）

- 收起：Progress 单行 `[2/5] current: <当前项>`
- 半展（默认推荐）：`[2/5] → 当前项` + `next: 后两项`
- 全展：进度条 + 完整 todo 列表（✓/→/·），↑/↓ 选择、Enter 看详情，覆盖主视图底部

### 4. Logs（Ctrl+L 与 Chat 互切）

全宽事件流：`时间 agent 事件 摘要`，含 tool.call/spawn/done/metric。live 追尾。

## 键位表

| 键 | 动作 |
|---|---|
| ↑/↓ | agents 树或 plan 内选择 |
| Enter | home→进入 agent chat；plan→item 详情 |
| Esc | 收起 plan（若展开）→ 否则回 agents home |
| Tab / Shift+Tab | 下一个 / 上一个 running agent |
| Ctrl+T | plan 收起/半展/全展循环 |
| Ctrl+L | chat / logs 切换 |
| `[` `]` | 主视图滚动；Logs 新输入自动断开追尾，`]` 到底恢复 live |
| / | slash command |
| y / n | **仅审批浮层内生效** |
| Ctrl+C | 退出 |

## 设计缺口的冻结方案

1. **审批浮层**：pending approval 出现时，在 Input 上方插入高优先级浮层（顶掉 Plan 层），
   显示 agent/命令/理由，y/n 只在浮层内响应；浮层存在时状态栏显示 `⚠ 1 pending approval`。
   多条排队逐条处理。**审批不得只进 Logs**——安全交互必须打断可见。
2. **Chat 归属规则**：chat = 选中 agent 的收件箱（含它发出的）。跨 agent 消息在双方
   chat 各显示一条（沿用现 store 镜像行为）。
3. **旧功能键迁移**：P/F/C 取消，迁 slash：`/pause` `/fork` `/info`（并入 M3-8 命令扩充）；
   y/n 全局响应取消（只在浮层）。
4. **滚动**：沿用 `[` `]`；Logs 视图新输入自动断开追尾，`]` 到底部恢复 live。

## ASCII 设计稿

### Agents Home（默认态）

```text
┌─ Spawn ───────────────────────────────────────────────────────────────────────────────┐
│ Goal  refactor model/provider config                            kimi-k2 · web: on    │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ Agents                                                                                │
│                                                                                       │
│  ● PM                         running   02:14   planning config split                 │
│  ├─ ● TL-1                    running   01:32   provider/runtime design               │
│  │  ├─ ○ W-1                  done      00:48   inspect config.ts                     │
│  │  └─ ● W-2                  running   00:59   update tests                          │
│  └─ ○ QA                      idle      --:--   waiting for regression                │
│                                                                                       │
│                                                                                       │
│                                                                                       │
├─ Progress ────────────────────────────────────────────────────────────────────────────┤
│ [2/5] current: implement provider catalog resolver                  Ctrl+T plan       │
├─ Input ───────────────────────────────────────────────────────────────────────────────┤
│ >                                                                                     │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ Running PM · TL-1 · W-2      Focus Agents      Tab next active      Esc home          │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### Agent Chat

```text
┌─ Spawn / TL-1 ────────────────────────────────────────────────────────────────────────┐
│ Goal  refactor model/provider config                            TL-1 · running       │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ PM                                                                                    │
│ Split model catalog from role assignment config. Roles should reference model keys.   │
│                                                                                       │
│ TL-1                                                                                  │
│ I found config.ts still couples model id and baseUrl inside role config.              │
│ I am adding a provider catalog resolver and keeping role config model-ref only.        │
│                                                                                       │
│ W-2                                                                                   │
│ Adding tests for missing modelRef and provider lookup fallback.                       │
│                                                                                       │
├─ Progress ────────────────────────────────────────────────────────────────────────────┤
│ [2/5] current: implement provider catalog resolver                  Ctrl+T plan       │
├─ Input ───────────────────────────────────────────────────────────────────────────────┤
│ > ask TL-1 to check web search config too                                             │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ Running PM · TL-1 · W-2      Focus TL-1      Tab next active      Esc agents          │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### Plan 半展（Ctrl+T 一次）

```text
┌─ Spawn / TL-1 ────────────────────────────────────────────────────────────────────────┐
│ ...                                                                                   │
│ TL-1                                                                                  │
│ I am adding a provider catalog resolver now.                                          │
│                                                                                       │
├─ Plan ────────────────────────────────────────────────────────────────────────────────┤
│ [2/5] → implement provider catalog resolver                                           │
│ next: update config.example.json · run typecheck and tests                            │
├─ Input ───────────────────────────────────────────────────────────────────────────────┤
│ >                                                                                     │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ Running PM · TL-1 · W-2      Ctrl+T expand plan      Esc agents                       │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### Plan 全展（Ctrl+T 两次，向上覆盖主视图底部）

```text
┌─ Spawn / TL-1 ────────────────────────────────────────────────────────────────────────┐
│ Goal  refactor model/provider config                            TL-1 · running       │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ PM                                                                                    │
│ Split model catalog from role assignment config. Roles should reference model keys.   │
│                                                                                       │
│ TL-1                                                                                  │
│ I found config.ts still couples model id and baseUrl inside role config.              │
│                                                                                       │
├─ Plan ────────────────────────────────────────────────────────────────────────────────┤
│ [2/5] ■■■■■■■■□□□□                                                                    │
│                                                                                       │
│  ✓ inspect current config                                                             │
│  ✓ identify model/baseUrl coupling                                                    │
│  → implement provider catalog resolver                                                │
│  · update config.example.json                                                         │
│  · run typecheck and tests                                                            │
│                                                                                       │
│ ↑/↓ select   Enter details   Ctrl+T collapse                                          │
├─ Input ───────────────────────────────────────────────────────────────────────────────┤
│ > ask TL-1 to check web search config too                                             │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ Running PM · TL-1 · W-2      Focus Plan      Tab next active      Esc agents          │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### Logs

```text
┌─ Spawn / Logs ────────────────────────────────────────────────────────────────────────┐
│ Goal  refactor model/provider config                              events · live      │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ 12:01:08  PM      spawn TL-1        provider/runtime design                           │
│ 12:01:11  TL-1    spawn W-1         inspect config.ts                                 │
│ 12:01:12  TL-1    spawn W-2         update tests                                      │
│ 12:01:19  W-1     done              found role config coupling                        │
│ 12:01:33  W-2     tool.call         Read src/config.ts                                │
│ 12:01:41  W-2     metric            token.usage prompt=12.1k completion=880           │
│                                                                                       │
├─ Progress ────────────────────────────────────────────────────────────────────────────┤
│ [2/5] current: implement provider catalog resolver                  Ctrl+T plan       │
├─ Input ───────────────────────────────────────────────────────────────────────────────┤
│ >                                                                                     │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ Running PM · TL-1 · W-2      Ctrl+L chat/logs      Esc agents                         │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### Approval 浮层（顶掉 Plan）

```text
┌─ Spawn / TL-1 ────────────────────────────────────────────────────────────────────────┐
│ ...                                                                                   │
├─ Approval ────────────────────────────────────────────────────────────────────────────┤
│ W-2 requests: Edit src/config.ts                                                      │
│ reason: update provider catalog resolver                                              │
│ y approve   n deny                                                                    │
├─ Input ───────────────────────────────────────────────────────────────────────────────┤
│ >                                                                                     │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ ⚠ 1 pending approval      Running PM · TL-1 · W-2      y/n approval only              │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

## 并行接缝：视图层可独立于 M1-6 先建（为"尽早拿到新 TUI"）

新 TUI = **视图层**（读 store → 渲染 → 键位），与 M1-6 拆的**编排逻辑**（startLeaderAgent/Worker）只在 App() 输入接线处相遇。故 M3-7b 拆两半并行：

- **M3-7b-view（可立即并行，不依赖 M1-6）**：视图状态机 + 渲染 `f(state)→lines` + 快照测试，建在 `src/tui/` 新模块，对着现有 `store` 契约：
  - **读**：`useStore(sel)` / `getState()` → agents / messagesByAgent / todosByAgent / pendingApprovals / selectedAgent / tokens / feishuConnection
  - **命令**：现有 store 函数（`selectAgent` / `approve` / `reject` / `scrollBy` / `pruneAgents` …）
  - **唯一注入**：斜杠命令分派用 prop `onCommand(input: string): void`（当前在 App() 的 CmdDef，视图层不直接依赖）
- **M3-7b-wire（等 M1-6e）**：用视图层替换 App() 的渲染+输入，接上 `onCommand`。仅此步与拆分相遇。

**真并行前提**：两条轨都不改对方文件——view 只加 `src/tui/`；M1-6 只动 `src/runtime/` + index.tsx 内部。冲突面仅 App()，且延到 wire 步。可由不同人/会话同时推。

## 实现约束

- **依赖 M1-6e**：拆分完成、TUI 只剩渲染/输入/slash glue 后开工，避免与 runtime 拆分互相改同一处。
- 所有行内截断必须走统一 displayWidth（CJK 双宽），禁止裸 `.length`。
- 渲染纯函数化：每个视图状态 = f(store state) → lines，便于快照测试。

## QA 验收（M3-7 回归验证列的展开）

- 渲染快照矩阵：5 个视图状态 × {英文内容, 中文重内容, 混合超长行} —— 分割线/边框零错位。
- 键位状态机单测：全部转移（home/chat/logs/plan 三态/审批浮层）穷举。
- 审批浮层用例：出现即打断、y/n 只在浮层生效、队列逐条。
- 旧 M3-7 输入 bug 清单（Tab 卡住/cursor 消失/审批锁输入）逐条验证在新 UI 下不复现。

---

## 最终锁定模型（2026-07-22，用户逐条明确）——Claude Code Static 滚动 transcript

**放弃固定视口整屏刷新，改为 Ink `<Static>` 滚动流。** 这是最终形态：

```
<Box flexDirection="column">          // 无固定 height，让 Static 滚进终端历史
  <Static items={header + messages}>  // ← 上方：滚动 transcript
    {item => <Text>{item.lines}</Text>}
  </Static>
  ── 以下是 live 区，永远锚定底部 ──
  {planDrawer if Ctrl+T}              // task/plan 抽屉，绑在输入栏上方
  {slashPalette}                       // 斜杠命令面板（保留）
  <InputBar/>                          // 富输入（光标/IME/@switch，保留）
  <StatusBar/>                         // 运行状态行（保留，图里那条）
</Box>
```

**逐条要求（用户原话）：**
1. **保留下方**：输入栏 + 状态行（现在这个富输入层，已恢复可用）不动。
2. **上方用新 TUI 模式、对齐 Claude Code**：内容用 `<Static>` 往上滚进历史，可回翻。
3. **HEADER 去掉锚定**：header 只作为 Static 的**第一个 item**，启动时出现，对话一多就自然被顶上去滚走（像 Claude Code），不再常驻顶部。
4. **去掉三列**：不再左右分栏（AgentsPane|ConvPane|TodoPane）。
5. **agents 与对话不同界面**：对话界面 = Static transcript（选中 agent 的消息流）；agents 树 = 另一个界面（切换键进入），不与对话同屏。
6. **task/plan 绑输入栏、Ctrl+T 开关**：plan 是输入栏正上方的抽屉，Ctrl+T 开合（Claude Code 的 todo 位置）。
7. **旧 TUI 的病根**：固定三列 + 无法滚动 + 顶部锚定 header —— 全部去掉。

**实现顺序（下次专注会话，需交互验证 dev:watch）：**
- (1) `src/tui/Transcript.tsx`：`<Static>` 渲染 header(首项) + 选中 agent 消息；每条消息 = 发送者标签 + 换行正文（复用 width wrap）。
- (2) App return 改造：去 `<TitleBar/>`、去外层 `height`、body 换 `<Transcript/>`；保留 palette + InputBar + StatusBar + 加 Ctrl+T plan 抽屉。
- (3) agents 界面：一个 mode 键切到全宽 agent 树（复用 AgentsPane expanded），Esc 回对话。
- (4) 切 agent 时 Static 重置的处理（key 重挂 or 清历史重铺）——这是 Static 模型唯一的坑，需专门处理。
- 验收：dev:watch 看 header 滚走、transcript 可滚、输入栏 5 项功能不回归、Ctrl+T plan、agents 切换。
