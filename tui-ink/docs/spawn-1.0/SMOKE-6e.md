# 冒烟用例 — 6e 模块级抽取（Feishu / COMMANDS / 处理器）

> 6e 各块 App/Feishu 层无 golden 覆盖，靠本表人工冒烟。每条：操作 → 期望。
> 判定通则：行为跟抽取前**看不出差别** = 等价重构 OK。

---

## ① FeishuBridge（connectFeishu + feishu 状态搬出后）

前置：`npm run dev:watch`，飞书已连接（状态栏「飞书:已连接」；或 TUI 里 `/feishu <app_id> <app_secret>` 连）。
下面每条 **粘贴进飞书聊天发给 bot**（按序），全部只碰 `tmp/smoke/` 沙箱，安全。
每条：粘贴内容 → 飞书里期望 → tui.log 期望。

### FP0 · 基础收发 + 卡片渲染（F1）
飞书发：
```
在 tmp/smoke/ 目录下新建 fb.txt，内容写 FEISHU_OK，然后读回来确认内容。做完一句话汇报。
```
- **飞书**：bot 有回复、**卡片正常渲染**（标题/内容/emoji 不乱码、不是一坨纯文本）
- **log**：`[feishu-xxxx] tool.call Write/Read`、`message to=user`；无裸 stderr

### FP1 · 输入合并窗口（F2）
**1.5 秒内连发两条**：
```
第一条：记住数字 42
```
```
第二条：记住数字 99，把 42 和 99 相加告诉我
```
- **飞书**：bot 一次性回「141」（两条被合并进同一轮，不是分别起两轮）
- **log**：合并窗口 flush 相关行；一轮处理两条

### FP2 · spawn TL/worker + 卡片进度（F3）
飞书发：
```
派一个 Tech Lead，让它再派一个 worker，统计 tmp/smoke/ 目录下有几个文件，逐步汇报进度给我。
```
- **飞书**：卡片显示子任务推进（🦞 PM / task_spawned 反应图标随进度变化）
- **log**：`spawn child=tl-…`、`spawn child=worker-…`、`feishuBridge.emit … task_spawned`

### FP3 · 并发 fork（F4）——趁 FP2 还在跑时发
```
另外并行帮我算一下：100 以内所有质数的个数是多少。
```
- **飞书**：走 fork（并发上限 3），base（FP2 统计）和 fork（质数）**各自独立回**，答案不串台
- **log**：`[ConversationRuntime:shadow] … fork_start`、fork PM' 的 spawn；两条链并行

### FP4 · 破坏性命令自动批准（F5，飞书 convMode）
飞书发：
```
用 Bash 删除 tmp/smoke/fb.txt（命令写 del /f /q tmp\smoke\fb.txt）。
```
- **飞书**：**直接执行并汇报**（convMode 下 PM 是权威，自动批准，**不弹审批**给你——与搬移前一致）
- **log**：`auto-approve tool "Bash" (conversationMode)`、`tool.call Bash({"command":"del …`

### FP5 · `/feishu` 状态（F6）——在 **TUI**（不是飞书）里敲
```
/feishu
```
- **TUI**：显示「飞书状态: ✅ 已连接  活跃会话: N 个」（`isFeishuConnected()`/`feishuSessionCount()` 生效）

### FP6 · 日志信道（F7）
TUI 结束后 `npm run log`（或 `Get-Content tui.log -Encoding utf8`）看：
- `[ConversationRuntime:shadow]` / `[FeishuWS]` / `[FeishuFinalGuard]` 等行**格式不变**；终端全程无乱码/无 Static 错位

---

**判定**：FP0-FP6 的飞书行为（收发/卡片/合并/fork/自动批准/状态）**与搬移前看不出差别** → FeishuBridge OK。
**最小集（省时间）**：`FP0 → FP2 →（趁跑）FP3 → FP5`——覆盖收发+卡片、spawn、并发 fork、状态访问器。
**失败**：bot 不回 / 卡片乱码 / fork 串台 / 自动批准变成弹审批 / `/feishu` 崩 → 贴 tui.log 相关行给我。

---

## ② COMMANDS（App 命令表抽出 tui/commands 后）

> ⚠️ **需重启 TUI**（含 `/feishu` 视图落 PM 的修复）。命令是在 **TUI 输入栏**里敲（不是飞书）。
> 每条：输入 → 期望。**重点**：命令执行后输出应落在 **PM 对话框可见**（刚修的 `selectAgent("pm")`）。

### 前置（造点上下文，好验"命令输出落 PM"）
1. `npm run dev:watch`
2. TUI 里发一条：`帮我在 tmp/smoke/ 建 cc.txt 内容写 CC，做完汇报` → PM 起来、可能 spawn TL
3. 有 TL/worker 后，**Tab 切到某个 TL**（故意不选 PM），后面验命令输出会不会自动跳回 PM

### 🔴 高风险优先（我这次抽取最易碰坏的）
| # | 输入 | 期望 |
|---|---|---|
| C1 | `/effort high` | 直接设 high（**箭头包裹的 confirmEffort 生效**，不崩）；再 `/effort` 弹选择器，Esc 关 |
| C10a | `/quit` | 弹退出确认「再按一次 q/Ctrl+C」（**箭头包裹的 requestExit 生效**）；按别的键取消，别真退 |
| C3 | `/sessions` → 记一个 id → `/resume <id>` | 列会话 / 恢复：首轮注入 RESUMED CONTEXT、复述上次 TODO（**注入的 startLeaderAgent/startWorker/pmStarted 都接对**） |
| CV | 上面任一命令执行后（你当前选中的是 TL） | **视图自动跳到 PM、能看到命令输出**（`/feishu` 视图修复；对所有命令生效） |
| C11 | 输 `/` → ↑/↓ 选一个命令 → **回车** | **执行选中命令**（不是把 `/xxx` 当消息发出）；Tab 补全 LCP/选中 |

### 🟡 常规（各敲一次，确认功能不回归 + 输出落 PM）
| # | 输入 | 期望 |
|---|---|---|
| C2 | `/model` | 弹模型选择器；`/model leader <已注册名>` 切换 |
| C4 | `/memory` `/memory pm` | 显示 facts/decisions/child_handles |
| C5 | `/metrics` `/metrics resume_context_missing` | HealthMetric 报表 |
| C6 | `/budget 100k` 然后 `/budget off` | 设/清预算（**搬过去的 fmtKIndex 生效**，显示 100.0k） |
| C7 | `/prune` | 隐藏 done agents |
| C8 | `/palette green` `/layout v3` `/zen` `/status` | 配色/布局/Zen/Status 切换（再敲一次切回） |
| C9 | `/fanout` `/schedule 10s 测试` `/tasks` `/alerts` | 各自功能（**搬过去的 parseScheduleDelay 生效**，/schedule 排上） |
| C12 | `/feishu` | 「飞书状态: … 活跃会话: N」**且视图落在 PM 能看到**（就是你上次反馈的点） |
| C13 | `/log debug` `/rate good ok` `/web show` | 日志级别/评分/web 配置 |

**判定**：每个命令功能与搬移前一致 · `/`面板回车执行选中 · **命令输出都落 PM 可见** → COMMANDS OK。
**最小集**：C1 `/effort high` → C10a `/quit`(取消) → C3 `/sessions`+`/resume` → C11 `/`选中回车 → C12 `/feishu`（选中 TL 时敲，看是否跳 PM）。
**失败**：命令崩 / `/`回车输出斜杠 / 输出看不到（没跳 PM）→ 贴 tui.log + 用例号给我。

---

## ③ 处理器（startLeaderAgent/startWorker 事件 switch + TurnState 抽出后）

前置：这是最险的一步，App 层 + 事件流全靠手测。跑真实任务覆盖各分支。

| # | 操作 | 期望（关键分支） |
|---|---|---|
| H1 | 发消息 → PM spawn TL → TL spawn worker | 三层树正常建立、spawn 校验（深度/并发/Worker 不能 spawn）不回归 |
| H2 | worker 跑工具（Read/Bash）→ 批执行 | tool.call→执行→结果回注正常（runToolBatch）；combined 一次回注 |
| H3 | worker 跑测试再改文件 | coding-guard 收束/熔断文案该出现时出现（TurnState 的 wLastTestFailed 等） |
| H4 | worker 只规划不动手 | nudge 催促（no_progress_nudge），3 次耗尽收敛 gaveUp |
| H5 | worker 破坏性 Bash（TUI 非飞书） | 审批浮层弹父 Leader，y/n 生效 |
| H6 | worker 报 done | 干净收敛、父节点收敛、`.json` 删除（M2-9）、无 dropped 洪水 |
| H7 | ESC 打断运行中 agent | 只打断、载入上条供改；Shift+Tab 返回不打断 |
| H8 | 循环检测 | 连续相同工具调用触发 loop-detect 警告 |
| H9 | 长会话 | history trim、session 滑窗、快照正常；无内存泄漏迹象 |

判定：spawn/工具/审批/nudge/收敛/循环检测/打断**全部与之前一致** → 处理器 OK。
**重点**：H3/H4/H6 是 TurnState 承载的 per-turn 状态，最易被搬坏，务必验。

---

## 通用回归闸（每块搬完我都会先跑，供你对照）
- golden 25 逐字节不变 · 全量 0 fail · test:full exit 0 · typecheck 干净。
- 这些**只覆盖事件序列**，App/Feishu/命令的"能不能用"仍需上面的人工冒烟。
