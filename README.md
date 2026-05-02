# Fork Agent — Hierarchical Agent Orchestration

三层代理编排系统：MainAgent → SpawnAgent → ForkAgent，支持上下文传播、共享内存、独立生命周期管理。

## Architecture

```
MainAgent (root)
  ├─ owns SkillRegistry
  ├─ owns TaskContext
  │
  ├── SpawnAgent A
  │     ├─ shared Memory (EventEmitter)
  │     ├─ readonly Skills
  │     ├── ForkAgent A1 (independent, refs memory)
  │     └── ForkAgent A2 (independent, refs memory)
  │
  └── SpawnAgent B
        └── ForkAgent B1
```

## Quick Start

```bash
npm install
npm test        # 475 tests, 0 failures
```

## Modules

| Module | Path | Description |
|--------|------|-------------|
| AgentState | `src/core/AgentState.ts` | Lifecycle state machine (8 states, 13 valid transitions) |
| AgentContext | `src/core/AgentContext.ts` | Task context with propagation (Main→Spawn→Fork) |
| SharedMemory | `src/memory/SharedMemory.ts` | Serializable, event-driven shared memory |
| SkillRegistry | `src/skills/SkillRegistry.ts` | Skill management with read-only views |
| BaseAgent | `src/agent/BaseAgent.ts` | Abstract agent with lifecycle hooks |
| MainAgent | `src/agent/MainAgent.ts` | Root orchestrator, spawn/fork management |
| SpawnAgent | `src/agent/SpawnAgent.ts` | Intermediate agent, memory owner |
| ForkAgent | `src/agent/ForkAgent.ts` | Leaf agent, independent lifecycle |

## Architecture Diagram

Open `architecture.html` in a browser for interactive Mermaid diagrams.

## Tech

TypeScript 5.4 · Node.js · vitest 1.7 · 0 external runtime dependencies
