# Prompt 改进方案 — 最终版

**状态**: ✅ 已完成（2025-06-04 实施）

---

## 执行摘要

- **实施日期**: 2025-06-04
- **原始文件**: prompts/_base.md (176行 8.4KB), prompts/pm.md (263行 12.4KB)
- **新文件**: prompts/leader.md (149行), prompts/worker.md (71行)
- **精简后**: prompts/_base.md (127行 3.3KB, -28%), prompts/pm.md (102行 2.5KB, -61%)
- **备份**: backups/2025-06-04/
- **协议兼容**: ✅ 所有硬约束保留（输出 JSON、事件类型、needs_approval、Spawn 树、PM 强制规则）

---

## 修改清单

### 1. 新建 prompts/leader.md（Leader 专用规则）

从原 pm.md 中提取 Leader 独有内容：
- 权力/限制表
- 三阶段决策（Stage 0 并发感知 + Stage 1 消息分类 + Stage 2 Fork 判断）
- **Fork 三条件**：低耦合(A) + 上下文独立(B) + 资源门槛(C)
- **effort 分级表**：low/mid/high/max（含判定标准、文件数、轮数、timeout_ms、max_turns）
- spawn 格式（含 effort 字段示例）
- Todo 状态更新规则
- Worker 完成/失败/Handup 处理
- Bash 审批协议

### 2. 新建 prompts/worker.md（Worker 专用约束）

- 能做/不能做边界表
- 工作流程（立即行动、不空想）
- unit.handup 格式和规则
- agent.done 规则
- 通信规则（只能 message.to=leader）
- 超时与约束

### 3. 精简 prompts/_base.md（176 行 → 127 行）

- ✅ 保留所有协议硬约束：输出 JSON 格式、事件类型完整列表、工具使用规则、5 行为铁律
- ✅ 保留 {{ALLOWED_TOOLS}} 模板变量（工具签名自动注入）
- ✅ 保留 Spawn 树/通信矩阵/超时/Memory 运行时约束
- ❌ 删除硬编码的完整工具签名表（由 {{ALLOWED_TOOLS}} 自动注入）
- ❌ 删除冗余反例块（从 5 个小块压缩为单代码块）
- ❌ 删除 S5 系统通知过滤规则独立块 → 合并到行为铁律第 6 条

### 4. 精简 prompts/pm.md（263 行 → 102 行）

- ✅ 保留 PM 三条核心规则
- ❌ 删除 Stage 0-2 完整复杂度评分表 → 替换为 Fork 三条件 + effort 路由表
- ❌ 删除详细 spawn 格式说明 → 压缩为格式模板
- ❌ 删除 todo 括号注释完整小节 → 合并到输出规则一行
- ❌ 删除 Worker 完成后/失败/Handup 冗长说明 → 压缩为各 3 行
- ❌ 删除完整输出示例 → 保留格式模板

---

## 1. Fork 判断规则（已实施）

### 三条件
- **A. 低耦合**：子任务不与父流程高频双向依赖
- **B. 上下文独立**：Worker 不需要父 agent 的完整推理过程
- **C. 资源门槛合算**：tool.call ≥ 5 or ≥4 文件 or >15 轮

路由：全部 Yes → spawn | 1-2 个 Yes → PM 自己做 | 全部 No → 追问

### 强制 spawn 触发器
- 消息含"实现/重构/修改/重写/添加功能"
- 消息含"分析/审计/评审"
- ≥3 独立子目标
- 文件 > 300 行

---

## 2. Effort 分级表（已实施）

| effort | 判定 | 文件数 | 轮数 | timeout_ms | max_turns |
|---|---|---|---|---|---|
| low | 单文件只读 | 1 | 3-8 | 120000 | 8 |
| mid | 多文件只读/单文件写 | 2-4 | 6-15 | 300000 | 15 |
| high | 多文件读写+Bash | 4-8 | 13-30 | 600000 | 30 |
| max | 大规模重构 | ≥8 | ≥25 | 1200000 | 50 |

嵌入位置：leader.md Stage 2 Fork 判断 + pm.md Stage 2。作为 dispatch 额外字段携带，不影响 preCheckSpawn 兼容性。

---

## 3. Prompt 精简结果

| 文件 | 原始 | 精简后 | 减少 |
|---|---|---|---|
| _base.md | 176 行 | 127 行 | -28% |
| pm.md | 263 行 | 102 行 | -61% |
| leader.md | 不存在 | 149 行 | 新建 |
| worker.md | 不存在 | 71 行 | 新建 |

### 协议完整性验证

| 硬约束 | _base.md | leader.md | worker.md | pm.md |
|---|---|---|---|---|
| JSON 单行输出格式 | ✅ | - | - | - |
| 事件类型完整列表 | ✅ | - | - | - |
| needs_approval 规则 | ✅ | - | - | - |
| {{ALLOWED_TOOLS}} 自动注入 | ✅ | - | - | - |
| Spawn 树/通信矩阵/超时 | ✅ | - | - | - |
| 5 条行为铁律 | ✅ | - | - | - |
| agent.done/todo.set/tool.call | ✅ | ✅ | ✅ | ✅ |

---

## 4. Claude Code 文章可借鉴点

### 已落地
- **动态任务分解** → Fork 三条件 + unit.handup 上报
- **并行 vs 串行** → Stage 0 并发感知 + 强制 spawn 触发器
- **Effort-Based Routing** → effort 分级表（low/mid/high/max）
- **Agent 回收** → "完成即退" 铁律
- **任务门控** → needs_approval 机制

---

## 5. 架构发现

- 原 leader.md 和 worker.md 不存在 → Leader/Worker 的 system prompt 退化为 "(missing: xxx.md)"，几乎无角色专用约束
- buildSystemPrompt 通过 promptFile ?? role.toLowerCase() 加载角色 prompt
- 现在 4 个文件完整：_base.md（通用）+ pm.md（PM root）+ leader.md（Leader 专用）+ worker.md（Worker 专用）
- effort 字段不破坏 DispatchSpec 兼容性（TypeScript interface 允许额外字段）

---

## 6. 文件清单

```
prompts/_base.md         127行 精简版（保留所有协议硬约束）
prompts/pm.md            102行 精简版（PM root 专用）
prompts/leader.md        149行 新建（Fork 三条件 + effort + spawn）
prompts/worker.md         71行 新建（Worker 边界约束）
backups/2025-06-04/      原始文件备份
docs/prompt-improvement-plan.md  本方案文档
```
