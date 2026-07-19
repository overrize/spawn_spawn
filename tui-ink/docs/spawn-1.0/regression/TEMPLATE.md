# 回归记录 — <里程碑或事件名>

> 复制本模板为 `regression/<里程碑>-<YYYYMMDD>.md` 填写。回归记录一经归档不再修改（追记用附注）。

## 基本信息

| 项 | 值 |
|---|---|
| 日期 | YYYY-MM-DD |
| 触发原因 | 里程碑出口 / 1.0 发布 / prompt 变更 / 事故复验 |
| 对应里程碑 | M0 / M1 / M2 / M3 / 发布 |
| WORKPLAN 版本 | v1.x.x |
| PLAN 版本 | Draft v0.x |
| 代码基线 | git commit hash / branch |
| prompt_version | （涉及 prompt 变更时填写） |
| 执行人 | |

## 执行范围与结果

| 检查项 | 命令/方式 | 结果 | 备注 |
|---|---|---|---|
| 类型检查 | `npm run typecheck` | ✅/❌ | |
| 全量测试 | `npm test` | ✅/❌ N passed / M failed | |
| 事件序列快照 | baseline 快照测试 | ✅/❌ | M1-5 之后必填 |
| 里程碑验收项 | 对照 WORKPLAN 该里程碑「回归验证」列逐项核对 | ✅/❌ | 逐项列出 |
| 评测集 | demo 全量 / live 抽样 | 通过率 x/30 | M3-2 之后必填 |

## HealthMetric 摘要

（M0 之后必填：本次回归运行期间关键事件计数）

| event_type | 次数 | 与上次回归对比 | 备注 |
|---|---|---|---|
| protocol_parse_failed | | | |
| fallback_message_emitted | | | |
| tool_arg_schema_failed | | | |
| hard_circuit_fired | | | |
| trace_failed | | | |

## 失败项与处置

| 失败项 | 现象 | 归因 | 处置（修复/回滚/xfail/降级） | 关联 bad case |
|---|---|---|---|---|
| | | | | |

## 结论

- [ ] 通过 — 里程碑可关闭 / 变更可合入
- [ ] 不通过 — 任务退回，处置见上表
- [ ] 回滚 — 已回滚至 <版本/commit>

附注：
