import { EventEmitter } from "events";
import { BaseAgent, AgentHooks } from "./BaseAgent";
import { AgentContext } from "../core/AgentContext";
import {
  AgentStatus,
  AgentType,
  AgentId,
  ForkConfig,
  JsonValue,
} from "../core/types";
import { ReadonlySkillRegistry } from "../skills/SkillRegistry";
import { SharedMemory } from "../memory/SharedMemory";
import { ForkAgent } from "./ForkAgent";

/**
 * SpawnAgent — intermediate agent created by MainAgent.
 *
 * Capabilities:
 *   - Shares skills with MainAgent (read-only)
 *   - Owns a SharedMemory instance
 *   - Can spawn ForkAgents (which inherit context + share memory)
 *   - Cascading termination: terminating Spawn terminates all Forks
 */
export class SpawnAgent extends BaseAgent {
  /** Read-only skills shared from MainAgent */
  readonly skills: ReadonlySkillRegistry;

  /** Shared memory — ForkAgents reference the same instance */
  readonly sharedMemory: SharedMemory;

  /** Parent MainAgent ID */
  readonly parentId: AgentId;

  /** All fork children */
  private _forks: Map<AgentId, ForkAgent>;

  /** Event emitter for fork creation/termination */
  readonly events: EventEmitter;

  constructor(
    context: AgentContext,
    skills: ReadonlySkillRegistry,
    parentId: AgentId,
    hooks?: AgentHooks
  ) {
    super(context, hooks);
    this.skills = skills;
    this.parentId = parentId;
    this.sharedMemory = new SharedMemory(this.id);
    this._forks = new Map();
    this.events = new EventEmitter();
    this.events.setMaxListeners(30);
  }

  // ─── Memory Operations ──────────────────────────────────────────

  /** Write to shared memory (visible to all ForkAgents) */
  memorySet(key: string, value: JsonValue): void {
    this.sharedMemory.set(key, value, this.id);
  }

  /** Read from shared memory */
  memoryGet(key: string): JsonValue | undefined {
    return this.sharedMemory.get(key);
  }

  /** Delete from shared memory */
  memoryDelete(key: string): boolean {
    return this.sharedMemory.delete(key, this.id);
  }

  /** Clear all shared memory */
  memoryClear(): void {
    this.sharedMemory.clear(this.id);
  }

  /** Subscribe to all memory changes */
  onMemoryChange(callback: (payload: import("../core/types").MemoryEventPayload) => void): () => void {
    return this.sharedMemory.onChange(callback);
  }

  /** Subscribe to a specific key's changes */
  onMemoryKeyChange(key: string, callback: (payload: import("../core/types").MemoryEventPayload) => void): () => void {
    return this.sharedMemory.onKeyChange(key, callback);
  }

  /** Serialize memory for persistence */
  serializeMemory(): import("../core/types").MemorySnapshot {
    return this.sharedMemory.serialize(this.id);
  }

  /** Restore memory from snapshot */
  deserializeMemory(snapshot: import("../core/types").MemorySnapshot): void {
    this.sharedMemory.deserialize(snapshot, this.id);
  }

  // ─── Forking ────────────────────────────────────────────────────

  /**
   * Fork a new ForkAgent from this Spawn.
   * ForkAgent inherits Spawn's context and references Spawn's SharedMemory.
   */
  fork(config: ForkConfig) {
    if (this.status !== AgentStatus.RUNNING && this.status !== AgentStatus.IDLE) {
      throw new Error(
        `Cannot fork: SpawnAgent "${this.id}" is in state "${this.status}"`
      );
    }

    const forkContext = this.context.derive(
      AgentType.FORK,
      config.taskDescription,
      config.constraints,
      config.metadata
    );

    const forkAgent = new ForkAgent(forkContext, this, this.id);
    this._forks.set(forkAgent.id, forkAgent);

    this.events.emit("fork:created", {
      spawnId: this.id,
      forkId: forkAgent.id,
      timestamp: Date.now(),
    });

    return forkAgent;
  }

  // ─── Fork Management ────────────────────────────────────────────

  /** Get a ForkAgent by ID */
  getFork(id: AgentId): ForkAgent | undefined {
    return this._forks.get(id);
  }

  /** List all ForkAgent IDs */
  get forkIds(): AgentId[] {
    return Array.from(this._forks.keys());
  }

  /** Number of ForkAgents */
  get forkCount(): number {
    return this._forks.size;
  }

  /** Terminate a specific ForkAgent */
  async terminateFork(id: AgentId): Promise<void> {
    const fork = this._forks.get(id);
    if (!fork) throw new Error(`ForkAgent "${id}" not found`);
    await fork.terminate();
    this._forks.delete(id);
    this.events.emit("fork:terminated", { forkId: id, timestamp: Date.now() });
  }

  /** Terminate all ForkAgents */
  async terminateAllForks(): Promise<void> {
    const ids = Array.from(this._forks.keys());
    await Promise.all(ids.map((id) => this.terminateFork(id)));
  }

  // ─── Override terminate for cascading cleanup ────────────────────

  async terminate(): Promise<void> {
    // Cascading: terminate all fork agents first
    await this.terminateAllForks();
    // Remove all memory event listeners to prevent leaks
    this.sharedMemory.removeAllListeners();
    await super.terminate();
  }

  // ─── Execution ──────────────────────────────────────────────────

  /** Execute the SpawnAgent's primary task */
  async execute(): Promise<void> {
    if (this.status !== AgentStatus.RUNNING) {
      throw new Error(`SpawnAgent "${this.id}" is not RUNNING (current: ${this.status})`);
    }
    // Default: no-op. Subclasses override for specific behavior.
  }
}
