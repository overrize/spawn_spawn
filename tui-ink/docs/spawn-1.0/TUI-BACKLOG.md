# TUI 待办（用户冒烟发现，先记后修）

> 用户明确「先把事情做完再修」——本表收集冒烟中发现的 TUI 问题，等 M1-6/6e 主线告一段落再统一修。
> 每条含：现象 / 根因 / 修法 / 涉及文件。

---

## TB-1 · AGENTS tree 不是真树（active/done 分段 + resume 挂错父）
**优先级：高**（用户 2026-07-24 明确反馈，影响可读性）

- **现象**：
  1. resume 恢复的 agent（如 worker-http-test）视觉上挂在 PM 下面，不在其真实父节点下。
  2. `── done ──` 把 agents 硬切成 active / done 两段 → 父 done 在下段、子还活着在上段时，**父子被拆到两个 section，树断了**。
  3. 整体"排布分隔"，不像一棵完整的 PM→TL→Worker 树。
- **根因**：`src/ui.tsx` `AgentsPane`（L148-199）是**扁平列表 + 按 state 切两段 + 靠 `depth` 缩进模拟层级**：
  - `allAgents` = store 插入顺序的扁平数组（非树）。
  - `activeAgents` / `doneAgents` 按 `state` 切开，中间插 `"divider"`（L156-163）。
  - `AgentRow` 只用 `a.depth` 做缩进（L203-205），不反映真实 `parent` 归属。
- **修法**：把 AgentsPane 改成**按 `parent` 递归建单棵树**：
  - 用 `childrenOf: Map<parentId, AgentInfo[]>` 建树，从 root（无 parent）DFS 展开成有序行，每行带真实 `depth`。
  - **取消 active/done 分段**；done/err 只在该节点行内用暗色 `✓`/`✗` 标记（`dimmed`）。
  - resume 的节点因为按 `parent` 归位，自然回到真实父节点下。
  - 滚动/虚拟行数逻辑复用现有 `allRows` 切片，只是 `allRows` 来源换成 DFS 序。
  - 保留 `参考 DagView`（ui.tsx L1077 已有拓扑 mini-map 建树逻辑 `childrenOf`）可直接借。
- **涉及**：`src/ui.tsx` `AgentsPane` + `AgentRow`；快照测试 `src/tests/tui/` 需同步更新。

---

## TB-2 · 右侧对话滚动条仍有问题
**优先级：中**（用户 2026-07-24：「还是不少问题；先把事情做完再修」）

- **现象**：底锚修复后仍不理想（具体形态待用户补充截图/描述）。
- **已做**：`ScrollBar`（ui.tsx L444-）改为底锚（最新→滑块钉底部平滑变短）+ 轨道粗暗 `█`/滑块细亮 `│`。
- **待查**：可能仍有 (a) 流式时 `total`/`availRows` 每帧变导致滑块尺寸跳动；(b) `availRows`（measureElement）测量抖动；(c) 是否该在 off===0（贴底看直播）时**隐藏**滑块以消噪。
- **涉及**：`src/ui.tsx` `ScrollBar` + `ConvPane` 的 total/availRows 计算。

---

## 已修（本轮，供对照，勿重复）
- 状态栏右侧键位串删除（只留 `log:级别`，键位改输入栏情境提示）—— 用户截图若仍显示旧串，是**未重启 TUI 跑旧代码**。
- 帽檐加宽 + 去胡子；Shift+Tab 返回不打断 + 清空输入；ESC 只打断；滚动条底锚（TB-2 待续）。

---

## 相关观察（非 TUI，已在别处登记）
- 冒烟日志见 worker-http-test 反复 Read 后吐非 JSON 散文导致 parse FAILED —— 即 **M2-10**（worker 报 done 后不干净终止）同款，已在 WORKPLAN 登记。
- `Get-Content tui.log` 出现 `state鈫抜dle` 类乱码 = PowerShell 按 GBK 读 UTF-8 日志的**显示**问题（文件本身 UTF-8）；用 `Get-Content tui.log -Encoding utf8` 或 `npm run log` 可正常显示。
