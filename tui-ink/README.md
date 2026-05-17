# multi-agent TUI · Ink 雏形

V1 三栏 inbox 的可运行原型。把 `wireframes` 里的 React 组件移植到 Ink,
后端接 `claude -p --output-format stream-json` 作为 leader agent。

## 跑起来

```bash
cd tui
npm install
npm run dev -- --demo    # 不调 claude,假发事件,看 UI 是否正常
```

回车任何文字 → 触发 demo event 序列 → 你能看到 todo / step / spawn /
tool.call / approval card 都正常渲染。

接真 claude (需要 `claude` 在 PATH 里,且已登录):

```bash
npm run dev
# 回车输入第一句话 → spawn `claude -p ...` 子进程
# 后续输入 → 写到子进程 stdin (--input-format stream-json)
```

## 键位

| 键 | 作用 |
|---|---|
| `Enter` | 发送当前输入 |
| `Tab` | 在 agent 之间循环 |
| `y` / `n` | 审批/拒绝当前 tool call (有 pending 时) |
| `q` | 退出 (输入框为空时) |
| `Ctrl+C` | 强退 |
| `@agent_id <msg>` | 路由消息给指定 agent |
| `/pause` / `/quit` | 暂停/退出 |

## 文件结构

```
src/
  protocol.ts    协议类型 (5+ 个事件 + 命令)
  agent.ts       Claude Code 子进程包装 + stream-json adapter
  store.ts       单一可变状态 + useSyncExternalStore 订阅
  ui.tsx         V1 三栏组件 (AgentsPane / ConvPane / TodoPane / ...)
  index.tsx      路由 + 启动 + 全局快捷键
```

## 强约束 4 层

1. **CLI flag** — `--allowed-tools` / `--disallowed-tools` 物理白名单
   (`agent.ts` 启动参数里)
2. **TUI parser** — `agent.ts.handleLine` 非 JSON 行静默丢弃
3. **base prompt** — `../prompts/_base.md` 反复声明 "只能输出 JSON"
4. **role prompt** — `../prompts/leader.md` 等限制角色行为

## 已知简化 (相对完整规范)

- 没有 sessions pane (V1 wireframe 的中间一栏);conversation 直接展示
  当前选中 agent 的所有消息
- 没有 DAG view (V3);你切到 worker 看 worker
- DeepSeek / OpenCode 没接,只接了 Claude Code;adapter 需要另写一个
- session resume 没实现 (用 `claude --resume <id>`)
- 审批后没真把结果回灌给子进程 (`tool.result` 是 Claude Code 自己注入的;
  我们的 approve/reject 目前只更新 UI,不阻塞子进程)
- conversation 渲染长度上限 12 条,长会话会丢历史

## 接下来 (按优先级)

1. 审批真阻塞子进程 — 需要换成 `--permission-mode plan` 或自实现 MCP
   server 拦截工具调用
2. 接 OpenCode + DeepSeek (`opencode run --print`),新增 worker 角色
3. DAG mini-map view (V3 的拓扑)
4. 可滚动的 conversation (Ink 没原生 scroll,需要自己实现)
