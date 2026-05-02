# Fork Agent — OMO Instance Orchestration

> MainAgent 管理多个 OMO 实例，每个 SpawnAgent 是一个独立的 OMO session，ForkAgent 是 OMO 内部的并行 worker，SharedMemory 实现跨 OMO 实时协调。

## 概念映射

```
┌─────────────────────────────────────────────────┐
│              MainAgent (OMO 管理器)               │
│  ┌─────────────────────────────────────────┐    │
│  │ 管理所有 SpawnAgent 的生命周期             │    │
│  │ SkillRegistry (共享给所有 OMO 实例)        │    │
│  │ 级联终止: Main 结束 → 所有实例终止         │    │
│  └─────────────────────────────────────────┘    │
└────────┬───────────────────┬────────────────────┘
         │                   │
    ┌────▼─────┐       ┌─────▼────┐
    │ Spawn A  │       │ Spawn B  │  ← 每个 Spawn = 一个 OMO 实例
    │ ┌──────┐ │       │ ┌──────┐ │
    │ │Memory│ │       │ │Memory│ │  ← 每个 OMO 有独立 SharedMemory
    │ │ ●──○ │ │       │ │      │ │
    │ └──┬───┘ │       │ └──────┘ │
    │    │fork │       │          │
    │ ┌──┴──┐ │       │          │
    ▼  ▼     ▼       │          │
   Fork Fork Fork     │          │  ← Fork = OMO 内并行 worker
   A1    A2   A3      │          │     共享同一个 Spawn 的 Memory
                       │          │     独立生命周期 (pause/resume)
```

## 三层模型

| 层 | 类 | OMO 对应 | 职责 |
|---|---|---|---|
| 管理 | `MainAgent` | OMO 编排器 | 创建/终止 OMO 实例，共享技能，级联管理 |
| 实例 | `SpawnAgent` | OMO session | 独立上下文、共享内存、fork 并行 worker |
| 协作 | `ForkAgent` | OMO worker | 继承 Spawn 上下文，共享内存，独立暂停/恢复 |

## 关键机制

| 机制 | 实现 | 说明 |
|---|---|---|
| **OMO 实例管理** | MainAgent.spawn() / terminateChild() | 创建/销毁 OMO 实例 |
| **跨实例协调** | SharedMemory + EventEmitter | Spawn 间通过共享内存实时通信 |
| **实例内并行** | SpawnAgent.fork() | 一个 OMO 内 fork 多个并行 worker |
| **独立生命周期** | ForkAgent pause/resume/terminate | worker 暂停不阻塞 Spawn 和其他 worker |
| **级联清理** | Main→Spawn→Fork 终止链 | OMO 管理器关闭时所有实例自动清理 |
| **技能共享** | SkillRegistry → ReadonlySkillRegistry | Main 拥有，所有 Spawn 只读 |
| **上下文传播** | AgentContext.derive() | taskId 贯穿整条链 |

## 快速开始

```bash
npm install
npm test                    # 475 tests, 0 failures
```

## 终端 UI

```bash
# OMO 内嵌快照 (ANSI, 零依赖, stdout)
npx tsx tui/snapshot.ts

# 独立全屏面板 (neo-blessed, 键盘交互)
npx tsx tui/dashboard.ts
```

## 与 Oh My OpenAgent 集成

```
omo (Atlas)
  │  load_skills=["fork-agent"]
  ▼
skill/fork-agent.ts          ← skill 注入 subagent prompt
  │
  ▼
omo-bridge/SpawnBridge       ← 桥接层 (spawn/fork/memory API)
  │
  ▼
src/agent/                   ← MainAgent → SpawnAgent → ForkAgent
```

每个 `SpawnAgent` = 一个由 Main 管理的 OMO 实例，`ForkAgent` = 该实例内的并行 worker。

## 模块

| 路径 | 说明 |
|---|---|
| `src/core/` | AgentState, AgentContext, types |
| `src/memory/` | SharedMemory (EventEmitter, 可序列化) |
| `src/skills/` | SkillRegistry (只读视图) |
| `src/agent/` | BaseAgent, MainAgent, SpawnAgent, ForkAgent |
| `omo-bridge/` | SpawnBridge — OMO 桥接层 |
| `skill/` | fork-agent.ts — omo skill 定义 |
| `tui/` | dashboard.ts (全屏) + snapshot.ts (OMO快照) |
| `ui/` | spawn-dashboard.html (Web 面板) |

## 技术栈

TypeScript 5.4 · Node.js · vitest · neo-blessed (TUI) · 零运行时依赖
