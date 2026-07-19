# docs/spawn-1.0 — Spawn 1.0 专项文档

Spawn 1.0（结构优化 + 自主进化埋点）的全部过程文档集中在本目录。

## 目录结构

| 路径 | 内容 | 维护规则 |
|---|---|---|
| [PLAN.md](PLAN.md) | 1.0 方案（定位、目标 G1-G7、HealthMetric 契约、WS1-6、M0-M3） | 定调文档。版本号在文件头（Draft v0.x），每次升版前把旧版快照复制到 `archive/PLAN-v0.x.md` |
| [WORKPLAN.md](WORKPLAN.md) | 工作计划（里程碑 → 任务 ID → 交付物 → 回归验证 → 状态） | 执行文档。任务状态原地更新 + 文末变更记录；PLAN 定调变更时升 minor 并归档旧版 |
| `regression/` | 回归记录（每个里程碑出口、发布、prompt 变更各一份） | 用 [regression/TEMPLATE.md](regression/TEMPLATE.md)，命名 `<里程碑>-<YYYYMMDD>.md`，归档后不改 |
| `archive/` | 被替代的 PLAN / WORKPLAN 历史版本快照 | 只进不出，文件名带版本号 |

## 工作流

1. 定调变化 → 改 PLAN.md（升版 + 归档旧版）→ 同步 WORKPLAN.md（升 minor + 归档旧版）。
2. 日常执行 → 只动 WORKPLAN.md 任务状态；任务关闭依据是其「回归验证」列。
3. 里程碑出口 → 全量回归 + 按模板写回归记录归档，**没有回归记录的里程碑不得关闭**。
4. 回归失败 → 任务退回进行中；连续两次失败升级到 PLAN 层面重新评估。

## 相关文档（docs/ 根目录）

- [ARCHITECTURE_BASELINE.md](../ARCHITECTURE_BASELINE.md) — 重构前行为基线（WS5 拆分的参照）
- [architecture-report.md](../architecture-report.md) — 全系统架构分析报告
- [CODE_HEALTH.md](../CODE_HEALTH.md) — 代码健康检查报告
- [prompt-improvement-plan.md](../prompt-improvement-plan.md) — prompt 改进计划（M3-3 prompt 版本化的输入）

## 版本历史

| 日期 | 事项 |
|---|---|
| 2026-07-20 | 目录建立；PLAN v0.2（双主线定调 + HealthMetric 契约 + M0 阶段）；WORKPLAN v1.0.0 初版 |
