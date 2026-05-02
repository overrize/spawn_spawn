import { MainAgent } from "../src/agent/MainAgent";
import { SpawnAgent } from "../src/agent/SpawnAgent";
import { ForkAgent } from "../src/agent/ForkAgent";
import { BaseAgent } from "../src/agent/BaseAgent";
import { AgentContext } from "../src/core/AgentContext";
import {
  AgentId,
  AgentStatus,
  AgentType,
  JsonValue,
  MemorySnapshot,
  MemoryEventPayload,
} from "../src/core/types";

/** Flat descriptor for any agent in the hierarchy */
export interface AgentInfo {
  id: AgentId;
  type: AgentType;
  status: AgentStatus;
  parentId?: AgentId;
  forkCount?: number;
  depth?: number;
}

/**
 * SpawnBridge — integration layer that wraps the fork-agent core
 * (MainAgent / SpawnAgent / ForkAgent) for use in omo's task() system.
 *
 * Maintains a singleton MainAgent internally. All spawn / fork / memory
 * operations are delegated through it.
 */
export class SpawnBridge {
  private _main: MainAgent | null = null;
  private _initialized = false;

  /** Lazily obtain or create the singleton MainAgent */
  private get main(): MainAgent {
    if (!this._main) {
      const context = AgentContext.createRoot("omo-bridge-root-task");
      this._main = new MainAgent(context);
    }
    return this._main;
  }

  /** Ensure the MainAgent is in RUNNING state before yielding children */
  private async ensureInit(): Promise<void> {
    if (!this._initialized) {
      await this.main.init();
      this._initialized = true;
    }
  }

  // ─── Spawning / Forking ──────────────────────────────────────────

  /**
   * Spawn a new SpawnAgent under the MainAgent.
   * Returns the spawn ID and the agent instance (already initialized).
   */
  async spawnAgent(
    description: string,
    constraints?: string[]
  ): Promise<{ spawnId: AgentId; spawn: SpawnAgent }> {
    await this.ensureInit();
    const spawn = this.main.spawn({
      taskDescription: description,
      constraints,
    });
    await spawn.init();
    return { spawnId: spawn.id, spawn };
  }

  /**
   * Fork a new ForkAgent from an existing SpawnAgent.
   * Returns the fork ID and the agent instance (already initialized).
   */
  async forkAgent(
    spawnId: AgentId,
    description: string
  ): Promise<{ forkId: AgentId; fork: ForkAgent }> {
    await this.ensureInit();
    const forkAgent = this.main.fork(spawnId, {
      taskDescription: description,
    });
    await forkAgent.init();
    return { forkId: forkAgent.id, fork: forkAgent };
  }

  // ─── Agent Lookup ────────────────────────────────────────────────

  /**
   * Find any agent (spawn or fork) by ID.
   * Searches spawn children then recursively through fork children.
   */
  getAgent(agentId: AgentId): BaseAgent | undefined {
    if (!this._main) return undefined;

    const spawn = this.main.getChild(agentId);
    if (spawn) return spawn;

    for (const sid of this.main.childIds) {
      const s = this.main.getChild(sid);
      if (s) {
        const fork = s.getFork(agentId);
        if (fork) return fork;
      }
    }

    return undefined;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  /**
   * Terminate an agent. Detects whether it is a SpawnAgent or ForkAgent
   * and follows the correct termination path (cascading for spawns).
   */
  async terminateAgent(agentId: AgentId): Promise<void> {
    if (!this._main) return;

    const spawn = this.main.getChild(agentId);
    if (spawn) {
      await this.main.terminateChild(agentId);
      return;
    }

    for (const sid of this.main.childIds) {
      const s = this.main.getChild(sid);
      if (s) {
        const fork = s.getFork(agentId);
        if (fork) {
          await s.terminateFork(agentId);
          return;
        }
      }
    }

    throw new Error(`Agent "${agentId}" not found`);
  }

  /** Pause an agent by ID */
  async pauseAgent(agentId: AgentId): Promise<void> {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" not found`);
    await agent.pause();
  }

  /** Resume a paused agent by ID */
  async resumeAgent(agentId: AgentId): Promise<void> {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" not found`);
    await agent.resume();
  }

  /** Get the current AgentStatus for any agent */
  getAgentStatus(agentId: AgentId): AgentStatus {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" not found`);
    return agent.status;
  }

  /**
   * Enumerate all agents (spawns + forks) with flat metadata.
   */
  getAllAgents(): AgentInfo[] {
    if (!this._main) return [];

    const result: AgentInfo[] = [];

    for (const sid of this.main.childIds) {
      const spawn = this.main.getChild(sid);
      if (!spawn) continue;

      result.push({
        id: spawn.id,
        type: AgentType.SPAWN,
        status: spawn.status,
        parentId: this._main.id,
        forkCount: spawn.forkCount,
        depth: spawn.context.depth,
      });

      for (const fid of spawn.forkIds) {
        const fork = spawn.getFork(fid);
        if (!fork) continue;

        result.push({
          id: fork.id,
          type: AgentType.FORK,
          status: fork.status,
          parentId: spawn.id,
          depth: fork.context.depth,
        });
      }
    }

    return result;
  }

  // ─── Memory Operations (scoped to a SpawnAgent) ─────────────────

  /** Read a value from a spawn's shared memory */
  memoryGet(spawnId: AgentId, key: string): JsonValue | undefined {
    return this.requireSpawn(spawnId).memoryGet(key);
  }

  /** Write a value to a spawn's shared memory */
  memorySet(spawnId: AgentId, key: string, value: JsonValue): void {
    this.requireSpawn(spawnId).memorySet(key, value);
  }

  /** Delete a key from a spawn's shared memory */
  memoryDelete(spawnId: AgentId, key: string): boolean {
    return this.requireSpawn(spawnId).memoryDelete(key);
  }

  /** Clear all entries from a spawn's shared memory */
  memoryClear(spawnId: AgentId): void {
    this.requireSpawn(spawnId).memoryClear();
  }

  /** Serialize a spawn's entire shared memory to a snapshot */
  getMemorySnapshot(spawnId: AgentId): MemorySnapshot {
    return this.requireSpawn(spawnId).serializeMemory();
  }

  /**
   * Subscribe to all memory changes on a spawn's SharedMemory.
   * Returns an unsubscribe function.
   */
  subscribeMemory(
    spawnId: AgentId,
    callback: (payload: MemoryEventPayload) => void
  ): () => void {
    return this.requireSpawn(spawnId).onMemoryChange(callback);
  }

  // ─── Skill Registration ──────────────────────────────────────────

  /** Register a skill on the MainAgent (available to all SpawnAgents) */
  registerSkill(name: string, description: string, version = "1.0.0"): void {
    this.main.registerSkill(name, description, version);
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  /** Look up a SpawnAgent by ID; throws if missing */
  private requireSpawn(spawnId: AgentId): SpawnAgent {
    if (!this._main) throw new Error("Bridge not initialized");
    const spawn = this.main.getChild(spawnId);
    if (!spawn) throw new Error(`SpawnAgent "${spawnId}" not found`);
    return spawn;
  }
}

/** Singleton instance — import and use directly */
export const spawnBridge = new SpawnBridge();
