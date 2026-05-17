# multi-agent TUI

一个 multi-agent 工具的终端 UI · 像 Claude Code 但同时管多个 agent
(Leader / Secretary / Worker, 支持 spawn + DAG)。

## 文件地图

```
.
├── index.html                  ← 在浏览器里看三张线框 (V1/V2/V3) + spec
├── README.md                   你现在读的这个
│
├── wireframes/                 设计稿 (HTML/React)
│   ├── styles.css              paper/green/amber 三套调色 + 终端字形
│   ├── components.jsx          共享 TUI 原子 (Window/Pane/Row/Todo/...)
│   ├── variants.jsx            V1 三栏 / V2 dock / V3 DAG 三个变体
│   ├── app.jsx                 design canvas + tweaks panel 装配
│   └── design-canvas.jsx       starter 组件
│   └── tweaks-panel.jsx        starter 组件
│
├── docs/
│   ├── AGENTS.md               协议、架构、Claude Code/OpenCode 接法
│   └── HANDOFF.md              ← 给 Claude Code 的实施指令
│
├── prompts/                    强约束 prompt
│   ├── _base.md                公共前导 (5 + 2 个事件 + 5 条铁律)
│   ├── leader.md               能 spawn / message user
│   ├── secretary.md            只读 / 汇报
│   └── worker.md               goal 边界 / agent.done 退出
│
└── tui/                        Ink 雏形 (V1 三栏已实现 + demo 模式)
    ├── README.md
    ├── package.json
    └── src/
        ├── protocol.ts         9 个事件类型
        ├── agent.ts            Claude Code 子进程 + stream-json adapter
        ├── store.ts            useSyncExternalStore + applyEvent
        ├── ui.tsx              V1 三栏 Ink 组件
        └── index.tsx           路由 + 全局快捷键
```

## 三个入口

| 想做什么 | 看哪个 |
|---|---|
| 看设计 (浏览器) | `index.html` |
| 跑雏形 (终端) | `cd tui && npm i && npm run dev -- --demo` |
| 让 Claude Code 接着做 | `docs/HANDOFF.md` |

## 设计原则 (摘要,详见 wireframes 里的 spec 卡)

1. **agent 不画 UI**,只描述状态 — 协议 9 个事件,JSON Lines
2. **颜色只在 running / warn / err 三处出现**,其余中性
3. **状态字形** `◐ ◯ ✓ ⚠ ✗`,不用 emoji
4. **mono 字体**,数字 tabular-nums
5. **审批门**:写文件 / git push / curl 等副作用必须 `needs_approval: true`
6. **三层物理约束**:CLI `--allowed-tools` / parser 丢非 JSON / role prompt

## 状态

- ✅ 三张 wireframe + spec 卡 (浏览器看)
- ✅ 协议 9 个事件 + 三个角色 prompt
- ✅ V1 三栏 Ink 雏形 (--demo 跑得起来)
- ✅ Claude Code stream-json adapter (Step 1 验证)
- ⬜ 真审批阻塞 (HANDOFF Step 2)
- ⬜ OpenCode + DeepSeek adapter (Step 3)
- ⬜ Sessions pane / palette 切换 / V3 DAG view (Step 4-6)

跟进:`docs/HANDOFF.md`。
