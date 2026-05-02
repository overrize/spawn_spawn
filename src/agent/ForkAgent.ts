import { BaseAgent, AgentHooks } from "./BaseAgent";
import { AgentContext } from "../core/AgentContext";
import {
  AgentStatus,
  AgentType,
  AgentId,
  JsonValue,
  MemorySnapshot,
  MemoryEventPayload,
} from "../core/types";
import type { SpawnAgent } from "./SpawnAgent";
import type { SharedMemory } from "../memory/SharedMemory";

/**
 * ForkAgent — leaf agent forked from a SpawnAgent.
 *
 * Capabilities:
 *   - Inherits SpawnAgent's context (via AgentContext derivation)
 *   - Shares SpawnAgent's SharedMemory (reference, not copy)
 *   - Independently manageable (own lifecycle: init, pause, resume, terminate)
 *   - Does NOT block the Spawn parent
 *
 * Constraints:
 *   - ForkAgents CANNOT fork further (leaf nodes only)
 *   - ForkAgents cannot access SkillRegistry directly (use Spawn's)
 */
export class ForkAgent extends BaseAgent {
  /** Reference to the Spawn parent */
  readonly spawnParent: SpawnAgent;

  /** Reference to the Spawn parent's SharedMemory (shared, not copied) */
  private _sharedMemory: SharedMemory;

  /** Spawn parent ID (for quick access) */
  readonly spawnParentId: AgentId;

  constructor(
    context: AgentContext,
    spawnParent: SpawnAgent,
    spawnParentId: AgentId,
    hooks?: AgentHooks
  ) {
    super(context, hooks);
    this.spawnParent = spawnParent;
    this.spawnParentId = spawnParentId;
    this._sharedMemory = spawnParent.sharedMemory;
  }

  // ─── Memory Access (delegated to Spawn's SharedMemory) ──────────

  /** Write to shared memory (visible to Spawn and sibling Forks) */
  memorySet(key: string, value: JsonValue): void {
    this._sharedMemory.set(key, value, this.id);
  }

  /** Read from shared memory */
  memoryGet(key: string): JsonValue | undefined {
    return this._sharedMemory.get(key);
  }

  /** Delete from shared memory */
  memoryDelete(key: string): boolean {
    return this._sharedMemory.delete(key, this.id);
  }

  /** Clear all shared memory (⚠ destructive) */
  memoryClear(): void {
    this._sharedMemory.clear(this.id);
  }

  /** Subscribe to all memory changes */
  onMemoryChange(callback: (payload: MemoryEventPayload) => void): () => void {
    return this._sharedMemory.onChange(callback);
  }

  /** Subscribe to a specific key's changes */
  onMemoryKeyChange(key: string, callback: (payload: MemoryEventPayload) => void): () => void {
    return this._sharedMemory.onKeyChange(key, callback);
  }

  /** Serialize the shared memory to a snapshot */
  serializeMemory(): MemorySnapshot {
    return this._sharedMemory.serialize(this.id);
  }

  /** Deserialize a snapshot back into shared memory */
  deserializeMemory(snapshot: MemorySnapshot): void {
    this._sharedMemory.deserialize(snapshot, this.id);
  }

  // ─── Skill Access (delegated to Spawn parent) ───────────────────

  /** Check if a skill is available via Spawn parent */
  hasSkill(name: string): boolean {
    return this.spawnParent.skills.has(name);
  }

  /** Prefix the agent type string for identification */
  override get type(): AgentType {
    return AgentType.FORK;
  }

  // ─── Execution ──────────────────────────────────────────────────

  /** Execute the ForkAgent's primary task */
  async execute(): Promise<void> {
    if (this.status !== AgentStatus.RUNNING) {
      throw new Error(`ForkAgent "${this.id}" is not RUNNING (current: ${this.status})`);
    }
    // Default: no-op. Subclasses override for specific behavior.
  }
}
