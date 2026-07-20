# TUI 重构设计规格（单主视图）

> 状态：v1 已采纳（2026-07-21，用户提案 + QA 评审）· 实现排期：M1-6e 之后（M3-7）
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
| `[` `]` | 主视图滚动（旧/新）【默认方案，待确认】 |
| / | slash command |
| y / n | **仅审批浮层内生效** |
| Ctrl+C | 退出 |

## 设计缺口的默认方案（QA 评审补充，待用户确认，不阻塞开工）

1. **审批浮层**：pending approval 出现时，在 Input 上方插入高优先级浮层（顶掉 Plan 层），
   显示 agent/命令/理由，y/n 只在浮层内响应；浮层存在时状态栏显示 `⚠ 1 pending approval`。
   多条排队逐条处理。**审批不得只进 Logs**——安全交互必须打断可见。
2. **Chat 归属规则**：chat = 选中 agent 的收件箱（含它发出的）。跨 agent 消息在双方
   chat 各显示一条（沿用现 store 镜像行为）。
3. **旧功能键迁移**：P/F/C 取消，迁 slash：`/pause` `/fork` `/info`（并入 M3-8 命令扩充）；
   y/n 全局响应取消（只在浮层）。
4. **滚动**：沿用 `[` `]`；Logs 视图新输入自动断开追尾，`]` 到底部恢复 live。

## 实现约束

- **依赖 M1-6e**：拆分完成、TUI 只剩渲染/输入/slash glue 后开工，避免与 runtime 拆分互相改同一处。
- 所有行内截断必须走统一 displayWidth（CJK 双宽），禁止裸 `.length`。
- 渲染纯函数化：每个视图状态 = f(store state) → lines，便于快照测试。

## QA 验收（M3-7 回归验证列的展开）

- 渲染快照矩阵：5 个视图状态 × {英文内容, 中文重内容, 混合超长行} —— 分割线/边框零错位。
- 键位状态机单测：全部转移（home/chat/logs/plan 三态/审批浮层）穷举。
- 审批浮层用例：出现即打断、y/n 只在浮层生效、队列逐条。
- 旧 M3-7 输入 bug 清单（Tab 卡住/cursor 消失/审批锁输入）逐条验证在新 UI 下不复现。
