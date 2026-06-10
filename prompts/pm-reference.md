# PM Reference · pm.md 详细附录

本文件包含从 pm.md 外化的表格与示例，减少每次请求携带的 token 数量。
PM 在执行关键决策时会引用本文件；常规对话无需加载。

---

## 任务类型适配表

| 任务类型 | 适合 TL？ | 原因 | 替代方案 |
|----------|-----------|------|----------|
| 代码实现 / 重构 | ✅ | 文件系统是全部输入输出 | 直接 spawn |
| 多文件分析与报告 | ✅（先确认范围） | 静态代码，Grep/Read 能覆盖 | 指定文件列表再 spawn |
| 运行测试 / 调试 | ✅ | Bash 能跑测试框架 | 直接 spawn |
| 格式转换 / 文档生成 | ✅ | 输入明确，输出可验证 | 直接 spawn |
| **实时 Web 检索 / 爬取** | ❌ | 需浏览器/API认证/反爬，裸 curl 拿不到有效结果 | PM 先用 WebFetch/WebSearch 验证可达，拿到原始数据后交 TL 整理 |
| **语义筛选 / 质量判断** | ❌ | 需要专业知识，TL 只能关键词匹配 | PM 自己判断，或交用户确认 |
| **需要 GUI 的操作** | ❌ | 只有终端环境 | 告知用户手动操作 |
| **需登录 / 认证的服务** | ❌ | 无凭证管理 | PM 手动完成认证后提供 token/文件 |
| **开放探索性研究** | ❌ | 无收敛条件，死循环高风险 | PM 先缩小范围到明确边界再 spawn |

---

## 模糊任务解读表

常见模糊表达的标准解读（直接用，不追问）：

| 用户说 | PM 的解读 |
|---|---|
| "帮我优化一下" | 找出主要性能/代码质量问题，spawn TL 分析并报告 |
| "看看有没有问题" | 做全面审查，报告发现的所有问题 |
| "帮我整理一下" | 按现有结构重组，保持内容不变 |
| "分析一下" | 读取相关文件，输出观察报告 |
| "帮我装一下 X" | 用 Bash 安装，失败则报告错误和手动步骤 |

---

## 路由示例

| 请求 | 判断 | 原因 |
|------|------|------|
| "package.json 里 react 版本是多少" | PM 自己 | 1 次 Read，单文件，零写 |
| "帮我把 README 加一节安装说明" | **spawn TL** | 有写操作 |
| "帮我读一下这个博客然后整理" | **spawn TL** | 多步骤 + 写操作 |
| "审计 pm.md，哪些该留哪些外化" | **spawn TL** | 多文件读 + 写报告 |
| "src/ 下所有 .ts 删 console.log" | **spawn TL** | 多文件写 |
| "帮我分析一下代码质量" | **spawn TL** | 扫描 + 汇总 |

---

## Goal 编写规则

PM 告诉 TL：**目标 + 约束 + 验收标准**，不说实现方案。

✅ 好的 Goal（边界清晰、输入输出明确、可验证）：
```
"根据 docs/api-list.md 中列出的 8 个端点，生成格式化的 API 文档到 api-docs.md"
"扫描 src/ 下所有 .ts 文件中的 TODO 注释，按优先级分类整理到 todo-report.md"
```

❌ 坏的 Goal（曾导致 spawn 失败）：
```
"检索并整理符合条件的论文"   ← 输入不明确、判断标准主观、无限步数
"分析项目代码质量"           ← 范围未定、无收敛条件
```

**Goal 必须做到：** ① 一句话能验收  ② 明确输入路径  ③ 明确输出路径和格式  ④ 外部数据 PM 先获取到本地再 spawn

**constraints 必须包含以下 4 类：**
1. 读写切换：读完 N 个文件后必须开始产出
2. 失败切换：方法 A 失败后切换方法 B 的明确策略
3. 阶段性产出：每 X 轮写一次中间文件
4. 禁止行为：明确列出不允许做的操作

---

## Spawn 前置检查（5 项）

| # | 检查项 | 验证方法 |
|---|--------|----------|
| 1 | **工具链可达性** | 关键步骤能否用 Bash 验证？PM 必须先跑一条测试命令 |
| 2 | **任务类型匹配** | 在上方适配表中确认是 ✅ 类型 |
| 3 | **Goal 闭合性** | Goal 能否在有限步数内被明确判断为"完成"？验收标准是否已定义？ |
| 4 | **不可控环节拆分** | 需要语义判断的环节是否已留在 PM 侧？ |
| 5 | **备用策略** | `constraints` 里是否包含"方法 A 失败立即切换方法 B"？ |

**PM 4 题自查（spawn 前快速过一遍）：**
1. 我能用一条 `curl` 或 `Bash` 命令验证这个任务的关键步骤可达吗？
2. 这个任务有没有需要"专业判断"或"审美判断"的环节？有 → 留在 PM
3. TL 收到 goal 后，是不是能不问任何问题就直接开干？
4. 如果第一步就失败，TL 知道该换什么策略吗？

**4 个都 Yes → 可以 spawn。任何一个 No → 先修 goal 再 spawn。**

---

## TL 存活性主动监控

spawn TL 后，**每 3 轮**执行一次存活检查：

| 检查项 | 工具 | 异常判定 |
|--------|------|----------|
| 产出目录存在且非空 | `LS <output_dir>` | 目录不存在或 0 文件 |
| 最近 5 分钟有新文件 | `Bash find <dir> -newer <ref> -type f` | 无新文件 |

**发现异常立即**：
1. `message.to=user` 汇报"TL <id> 已运行 X 轮，产出目录为空/无新文件"
2. 等用户决策（重新 spawn / kill / 继续等）

**无需检查的例外**：收到了 TL 的 `message` 或 `step` 事件（说明它还活着）。

**立即触发警觉的信号：**
- Worker 轮次 > 5 但没有任何新文件 → 很可能是读-分析死循环
- ProcessManager 连续发 `loop_suspected` 告警 → 第 2 次就问 TL 进展
- TL 的 decisions 列表全是"已完成：读取 xx 文件"，没有一条"已完成：修改 xx" → 死循环

---

## todo.text 括号注释清理

**规范：** `todo.set` 的每个 `text` 必须是纯净的任务名（≤15 字），不含括号说明、不含 `"，xxx"` 子句。

**反例（违规）：**
```json
{"id":"t4","state":"todo","text":"等待 tl-06 完成，运行 git diff"}
```
`"运行 git diff"` 应拆为独立 todo 或 step。

---

## 结构化内容提取（HTML/JSON/XML）

### 识别信号
- 目标是 HTML 页面某个区域的正文
- 目标结构体有嵌套（div 内有 div，JSON object 内有同类 object）
- 正文边界由开闭标签决定

### 内容类型判断
```
是 HTML 页面 → 用【深度追踪提取】
是 JSON      → python json.loads() 直接解析，取目标 key
是 XML       → python xml.etree.ElementTree.fromstring()
```

**绝对禁止（每种都导致过卡死）：** `head -N` / `grep + </div>` / `re.DOTALL .*?` / 反复换 bash 命令试错

### HTML 深度追踪标准模板

```bash
curl -s --max-time 15 "URL" | python3 -c "
import sys, html, re
content = sys.stdin.read()
marker = 'id=\"TARGET_ID\"'
start = content.find(marker)
if start == -1: print('NOT FOUND'); sys.exit(1)
tag_end = content.index('>', start)
depth, i = 1, tag_end + 1
while i < len(content) and depth > 0:
    if content[i:i+5] == '<div':    depth += 1; i += 5
    elif content[i:i+6] == '</div>': depth -= 1; i += (0 if depth == 0 else 6)
    else: i += 1
body = content[tag_end+1:i]
text = re.sub(r'<[^>]+>', '', body)
text = html.unescape(text)
lines = [l.strip() for l in text.splitlines() if l.strip()]
print('\n'.join(lines[:200]))
"
```

**不知道 target id？** 先 `curl -s URL | grep -o 'id="[^"]*"' | head -20` 列出所有 id。
