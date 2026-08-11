# 冒烟 Prompt 脚本 — M1-6a/6b/6c 等价重构验证

> 把下面每条 **粘贴进 TUI 输入栏**（按序执行）。全部只在 `tmp/smoke/` 沙箱内操作，安全。
> 每条标注：**触发路径** / **屏幕期望** / **tui.log 期望** / **判定**。
> 目标：让 6a(日志)/6b(工具批执行·审批·approver 查找)/6c(记忆·resume·清理) 的每条改动都被真实走到。
> 判定通则：屏幕行为 + 日志格式跟改动前**看不出差别** = 等价重构 OK。

---

## P0 · 建沙箱（6b Write + 6c 记忆 + 6a 日志）

```
在 tmp/smoke/ 目录下创建三个文件：a.txt 内容写 "AAA"，b.txt 内容写 "BBB"，c.txt 内容写 "CCC"。只用工具完成，做完一句话汇报。
```
- **触发**：Write ×3、PM 记忆初始化
- **屏幕**：PM 正常执行并汇报；终端干净无裸 stderr
- **log**：`[pm] tool.call Write(...)` ×3；`.spawn/memory/pm.json` 生成
- **判定**：三文件建成 + PM 有记忆文件 → 6a/6c 基础 OK

---

## P1 · 一轮多工具批执行（6b runToolBatch + formatToolResults）

```
在同一轮里一次性读取 tmp/smoke/a.txt、b.txt、c.txt 三个文件，把三个内容按 a,b,c 顺序拼成一行告诉我。
```
- **触发**：一轮 3 个 `tool.call` → `runToolBatch` 扇出 → `formatToolResults` 合并回注
- **屏幕**：一次性返回三文件内容、顺序正确
- **log**：三条 `tool.call Read`；回注是一个 `user.message`，内含 3 个 `[tool_result id="..." ok="true"]` 头，顺序 a→b→c
- **判定**：批量结果**一次性、按序**回注 → `runToolBatch`/`formatToolResults` 等价 OK

---

## P2 · Worker 破坏性命令 → 审批路由父 Leader（6b findApproverLeader + leaderApprovalQueue）

```
派一个 Tech Lead，让这个 TL 再派一个 worker。worker 的任务：用 Bash 删除 tmp/smoke/a.txt（Windows 用 del，命令里明确写 del /f /q tmp\smoke\a.txt）。worker 执行这个破坏性命令时必须走审批。
```
- **触发**：PM→TL→worker；worker 的 `del`（破坏性 Bash）→ `findApproverLeader(worker)` 找到父 TL → `leaderApprovalQueue`
- **屏幕**：审批请求出现在**父 TL**（不是直接问你）；TL 侧对话里出现 `[系统-Bash审批 id=...]`
- **log**：`[pm] spawn child=tl-...`；`[tl-...] spawn child=worker-...`；`[worker-...] tool.call Bash({"command":"del ...`；审批路由行
- **判定**：破坏性命令**没被直接执行**，而是路由到父 TL 待批 → 6b 审批链等价 OK
  （TL 是否自动批取决于其模式；关键是**路由到了父 Leader**这一步发生）

---

## P3 · 根 PM 破坏性命令 → 无父可批（6b 审批兜底分支）

```
你（PM）自己直接用 Bash 执行 del /f /q tmp\smoke\b.txt。
```
- **触发**：根 PM 破坏性 Bash，normal 模式无父可批
- **屏幕**：PM 收到"需要审批但根 Leader 无父可批"类错误，改用别的方式或说明
- **log**：`tool.call Bash` + 返回 `requires approval. Root leader has no parent...` 类 `tool.result ok=false`
- **判定**：根 PM 破坏性命令被**兜底拦截**而非静默执行 → 分支等价 OK

---

## P4 · 记忆文件与 worker 种子事实（6c initSecretary）

粘贴后**在另一个 PowerShell** 里查（不占 TUI）：
```powershell
Get-ChildItem .spawn\memory\ | Select-Object Name
```
- **期望**：有 `pm.json`、`tl-*.json`、`worker-*.json`（+ 对应 `*.sessions.json`）
- **触发**：leader/worker 的 `initSecretary` 各自建 memory
- **判定**：每个 agent 一个 `<id>.json` → 6c 创建路径 OK。（种子事实：worker.json 的 `working_set.facts` 应含父 TL 近期 facts）

---

## P5 · 中断清理（6c destroySecretary + killAgent）

先给一个会跑一会儿的任务：
```
派一个 worker 在 tmp/smoke/ 下逐个统计 a/b/c 三个文件的字符数，每统计一个就等我确认，别一次做完。
```
worker 跑起来后，**Tab 切到该 worker → 进对话 → 按 ESC 打断它**。然后另一个 PowerShell 查：
```powershell
Get-ChildItem .spawn\memory\ | Where-Object Name -like "worker-*"
```
- **期望**：被中断 worker 的 `worker-xx.json` **已删除**，`worker-xx.sessions.json` **保留**
- **触发**：ESC→`killAgent`→`destroySecretary`
- **判定**：working_set json 删、历史 sessions 留、无报错 → 6c 清理等价 OK

---

## P6 · Resume 上下文注入（6c buildResumeContext）

用 P5 留下的 sessions 恢复：
```
/sessions
```
看列表拿到那个 worker（或任一有 sessions 的 agent）的 id / hash，然后：
```
/resume <上一步的 id 或 hash>
```
- **触发**：resume → `buildSystemPrompt` → `buildResumeContext` 注入
- **屏幕**：恢复的 agent 首轮**复述上次 TODO/计划**（因为注入了 RESUMED CONTEXT，prompt 要求首句 `todo.set`）
- **log**：`[resume] context injected: facts=N, decisions=M, hint="..."`
- **判定**：出现 `context injected` 行且首轮带上次现场 → `buildResumeContext` 等价 OK

---

## P7 · Resume 缺失兜底（6c resume_context_missing）

```
/resume no-such-agent-xyz
```
- **触发**：`loadMemory` 返回 null → `buildResumeContext` 返回 "" + 记 metric
- **屏幕**：不崩，提示无此 session / 无上下文注入
- **log**：`[resume] WARN: loadMemory("no-such-agent-xyz") returned null` + 一条 `resume_context_missing` metric（`.spawn/metrics/health-metrics.jsonl`）
- **判定**：缺失场景不崩且埋点产出 → 兜底分支 OK

---

## P8 · 日志信道整体（6a installDiagnosticSink + logDiag）

全程结束后：
```powershell
Get-Content tui.log -TotalCount 5
Get-Content tui.log -Tail 20
```
- **期望**：`--- session ... ---` 头 + 全程 `[id] ...` 结构化行；**终端里从没出现过裸 stderr / 乱码 / Static 错位**
- **判定**：日志全落 tui.log、终端干净、行格式没变 → 6a 信道 + logDiag seam OK

---

## 最小集（省 token，5 条覆盖核心）

`P0 → P1 → P2 → P6 → P8`：建沙箱 → 批执行 → 审批路由 → resume 注入 → 日志信道。
这五条走到了 6b(批+审批)、6c(记忆+resume)、6a(日志) 的所有**改动函数**。

---

## 附:TUI 键位（非 prompt，键盘操作，配合上面一起验）

| 键 | 期望 |
|---|---|
| 启动看吉祥物 | 帽檐 ` ▟███▙ `、无胡子、4 行 |
| `[` 滚动看滚动条 | 轨道暗粗 `█` / 位置亮细 `│`（反过来了） |
| 拖窄终端 <96 列 | 右下角提示缩略、不换行、不粘连 |
| 对话页 Shift+Tab | 返回 agents、不打断、输入栏空 |
| 对话页 ESC（运行中） | 只打断、载入上条供改后重发 |
