# TUI Review Log

每条记录包含：问题描述、优先级、状态、修复方案、修复 commit/时间。
状态：`open` | `in-progress` | `fixed` | `wontfix`

---

## R-001 斜杠命令提示横向排列，难以阅读
- **优先级**: P2 — 体验
- **状态**: `open`
- **现象**: `/pause — ... │ /resume — ... │ /palette — ...` 全挤在一行
- **预期**: 纵向表格，每条命令一行，对齐描述列
- **修复方向**: `ui.tsx` InputBar 下方的 slashMatches 渲染改为 `flexDirection="column"`，命令名左对齐（固定宽度），描述右侧跟随
- **修复记录**: —

---

## R-002 输入框无命令历史（↑/↓ 不回溯之前输入）
- **优先级**: P2 — 体验
- **状态**: `fixed`
- **现象**: 在输入框按 ↑ 无任何反应（或触发意外行为）
- **预期**: 类 bash history，↑ 回溯上一条已提交输入，↓ 前进
- **修复记录**: index.tsx cmdHistory ref + historyIdx ref + browsingHistory ref；useInput ↑/↓ 分支；onSubmit push history。typecheck 0 errors ✅

---

## R-003 对话区无法滚动
- **优先级**: P1 — 功能缺失
- **状态**: `fixed` ← filtered stdin proxy 方案验证通过（截图确认）
- **现象**: 对话超出屏幕后无法查看历史
- **预期**: 鼠标滚轮上滚查看旧消息，下滚回到新消息；顶/底显示指示文字
- **方案（已定，待重实现）**: store.ts scrollOffset+scrollBy ✅ 保留；ui.tsx ConvPane 切片 ✅ 保留；index.tsx SGR listener 需改为 filtered stdin proxy 方案（见 R-007）
- **修复记录**: 部分完成，listener 部分需重构

---

## R-004 /layout 命令切换后不持久化
- **优先级**: P3 — 轻微
- **状态**: `open`
- **现象**: `/layout v3` 后重启回到 v1
- **预期**: 与 palette 一样写入 `~/.config/multi-agent-tui/config.json`
- **修复方向**: `config.ts` 加 `layout` 字段；`loadConfig` 返回 `{ palette, layout }`；`index.tsx` 用 `setLayout(loadConfig().layout)` 初始化；`/layout` handler 额外调 `saveLayout()`
- **修复记录**: —

---

## R-005 Tab 补全逻辑：多于1个匹配时不补全
- **优先级**: P3 — 轻微
- **状态**: `open`
- **现象**: 输入 `/pa` (matches pause+palette) 按 Tab 无反应；需精确到 `/pau` 才补全
- **预期**: Tab 补全最长公共前缀（bash 风格），或循环候选
- **修复方向**: `index.tsx` useInput Tab 分支：单匹配直接补全（现有逻辑）；多匹配取 LCP（最长公共前缀）填入 input
- **修复记录**: —

---

## R-006 stderr 噪声：非审批内容也 emit agent.error
- **优先级**: P2 — 稳定性
- **状态**: `open`
- **现象**: Claude Code 进度条、普通 log 输出走 stderr，全部变成红色 ⚠ 系统消息
- **预期**: 非审批 stderr 应静默或以 debug 级别记录，不显示为 error
- **修复方向**: `agent.ts` stderr handler：非 isPerm 分支改为 emit `agent.state { sub: t }` 或直接丢弃；或等 log-level 功能（Step 8e）后标记为 debug
- **修复记录**: —

---

## R-008 各栏宽度未完全固定
- **优先级**: P2 — 布局
- **状态**: `partial` — AgentsPane/SessionsPane 已加 flexShrink={0}；TodoPane 遗漏，仍被挤压换行
- **现象**: coder-01 出现后 AGENTS 栏变宽，sub 文字超出列边界
- **根因**: Ink Box 的 `width` 属性是"建议宽度"，不裁剪内容；AgentRow 里 `a.name` 和 `a.sub` 没有截断
- **预期**: 四栏宽度固定，后续再做响应式
- **修复方向**: `ui.tsx` — AgentRow 中 `a.name` 用 `truncate(a.name, 14)` 截断；`a.sub` 用 `truncate(a.sub, 16)`；SessionsPane 的 title 截断也同步收紧至 `width - 4`；所有固定宽度的栏加 `flexShrink={0}` 防止被挤压
- **修复记录**: —

---

## R-009 /palette 命令无可见效果
- **优先级**: P2 — 体验
- **状态**: `fixed`
- **现象**: `/palette green` / `/palette amber` 执行后颜色无变化
- **根因**: palette 系统只覆盖了 AgentRow 状态字形和 TodoRow，ConvPane / StatusBar / InputBar / Bubble 里的颜色全部硬编码（`"cyan"` `"yellow"` `"white"`），与 palette 无关
- **预期**: green/amber palette 切换后整体主色调明显变化
- **修复方向**: `ui.tsx` — 所有 `<Text color="cyan">` 改为从 `usePalette()` 取 `p.accent`；所有 `<Text color="yellow">` 改为 `p.warn`；agent 文字 `"white"` 改为 `p.text`；`dimColor` 的地方保持不动（已经是 dim 效果）
- **修复记录**: —

---

## R-007 鼠标点击 SGR 释放事件漏入 TextInput / 斜杠补全不显示
- **优先级**: P1 — 功能损坏
- **状态**: `open` — 两个子问题均未真正解决
- **子问题 A（鼠标事件）**: 正则 `/\x1b\[<(\d+);\d+;\d+M/g` 只过滤按下（`M`），漏掉释放（`m`）。点击 = 按下+释放，释放事件全部透传进 TextInput。修复：`M` → `[Mm]`
- **子问题 B（斜杠补全不可见）**: `slashMatches` 渲染块位于 InputBar 之后、StatusBar 之前；外层 Box 高度固定，补全出现时 StatusBar 被推出可视区，补全列表本身也在末行边缘被截断。修复：把 slashMatches 块移到 InputBar 之前（压缩内容区，不挤底部）
- **修复记录**: —

---
## R-011 Sessions 列占用空间，用户希望去除保持三列
- **优先级**: P2 — 布局
- **状态**: `open`
- **预期**: 仅保留 AGENTS | CONV | TODO 三列；Sessions 数据继续维护在 store，不渲染
- **修复方向**: `index.tsx` V1 layout 删除 `<SessionsPane width={22} />`；ui.tsx 的 SessionsPane export 保留（代码不删）
- **修复记录**: —

---

## R-010 Tab 补全后光标未跳到末尾 / slashMatches 位置导致光标重置
- **优先级**: P3 — 体验
- **状态**: `open`
- **现象**: Tab 补全 `/pause ` 后，光标停在原位（通常是 0 或中间某处），不在末尾
- **根因**: `ink-text-input` 是受控组件，外部 `setInput(newValue)` 更新 `value` prop，但组件内部 cursor state 不随之移动（已知行为，ink-text-input 不暴露 cursor setter）
- **根因（光标跳 0）**: slashMatches 被移到 InputBar 之前，每次补全出现/消失 InputBar 的 y 坐标变动，Ink 重新定位 TextInput 导致 ink-text-input 内部 cursor state 重置为 0
- **修复方向**: 把 slashMatches 渲染块移回 InputBar 之后（原位置）；StatusBar 在补全展开时临时隐藏为可接受的 trade-off；撤销之前 setInput("") + setInput(completed) 的 cursor-reset hack，直接 setInput(completed) 即可
- **修复记录**: —

---

---

## 步骤进度

| Step | 内容 | 状态 |
|---|---|---|
| 8a | layout 状态 (store.ts) | ✅ |
| 8b | DagView 组件 (ui.tsx) | ✅ |
| 8c | /layout 命令 + V3 布局 (index.tsx) | ✅ |
| 8d | 鼠标滚轮滚动 + 命令历史 (3 文件) | ✅ |
| 8e | Session resume (claude --resume) | ✅ 实现完成，真实测试待 API key |
| **8f** | **Log levels — debug/info/warn/error (4 文件)** | **✅** |
| Step 9 | Smoke tests | ✅ 17 pass, 0 fail |

_最后更新: 2026-05-16_
