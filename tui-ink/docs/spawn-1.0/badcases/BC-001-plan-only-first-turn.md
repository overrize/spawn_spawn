# BC-001 · 首轮只规划不执行，靠 nudge 补救（用户感知：要反复提醒才干活）

> 状态：已归因，修复任务 M1-7 · 登记日期 2026-07-20 · 来源：用户反馈（真实使用）

## 现象（用户视角）

给 spawn 一条指令后 agent"不干活"，要等下一层（系统 nudge 或用户再催）才真正执行。
长期使用感受为"笨、要反复提醒"，多一轮往返 = 多一轮延迟 + 多一轮 token。

## 归因（代码视角）

1. agent 首轮经常只输出 `todo.set` + `step`（规划），不带 `tool.call`/`spawn`/`message`，
   然后停流转 idle。文本协议无法强制"规划必须伴随行动"。
2. harness 检测到空转后补一条 nudge（`index.tsx` idle 分支），第二轮才执行——
   这是**补救机制在正常工作**，但补救本身就是体验损失。
3. **层级判定不对称**：Leader 路径 `todo.set` 计入 `actedThisTurn`（宽），Worker 路径不计入（严）。
   同一坏行为两套口径。
4. 触发频率与模型相关：越弱/越不同源的模型越不遵守 prompt 里"第一步必须带 tool.call"的规则。

## 可量化指标

`no_progress_nudge` HealthMetric（M0 已埋）。修复验收 = 示例任务集上该指标显著下降。

## 修复路径

- **短期（M1-7，执行侧）**：统一 leader/worker 的 acted 判定（纯 `todo.set` 一律不算 acted）；
  prompt 强化首轮"规划必须伴随第一个执行动作"；QA 先交 characterization 测试钉住现状。
- **结构性（M2 WS1）**：native function calling 轨道下 tool_use 是一等输出，
  "规划了但忘了行动"这一失败模式大幅收敛。M2 出口用 `no_progress_nudge` 对比验证。

## 关联

[[WORKPLAN M1-7]] · [[M0 no_progress_nudge 埋点]] · [[PLAN WS1 协议双轨]]
