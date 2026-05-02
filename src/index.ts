/**
 * Fork Agent System — public API barrel export.
 *
 * Usage:
 *   import { MainAgent, AgentContext, ... } from "fork-agent";
 */

// ─── Core ─────────────────────────────────────────────────────────
export { AgentContext } from "./core/AgentContext";
export { AgentState, InvalidTransitionError } from "./core/AgentState";
export { v4 as uuid } from "./core/uuid";
// Enum exports (values + types)
export { AgentStatus, AgentType, MemoryEventType, VALID_TRANSITIONS } from "./core/types";
// Type-only exports
export type {
  AgentId,
  TaskId,
  JsonValue,
  MemoryEntry,
  MemorySnapshot,
  TaskContext,
  SpawnConfig,
  ForkConfig,
  MemoryEventPayload,
} from "./core/types";

// ─── Memory ───────────────────────────────────────────────────────
export { SharedMemory } from "./memory/SharedMemory";

// ─── Skills ───────────────────────────────────────────────────────
export { SkillRegistry, ReadonlySkillRegistry } from "./skills/SkillRegistry";
export type { Skill } from "./skills/SkillRegistry";

// ─── Agents ───────────────────────────────────────────────────────
export { BaseAgent } from "./agent/BaseAgent";
export type { AgentHooks } from "./agent/BaseAgent";
export { MainAgent } from "./agent/MainAgent";
export { SpawnAgent } from "./agent/SpawnAgent";
export { ForkAgent } from "./agent/ForkAgent";
