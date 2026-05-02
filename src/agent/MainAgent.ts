import { EventEmitter } from "events";
import { BaseAgent, AgentHooks } from "./BaseAgent";
import { AgentContext } from "../core/AgentContext";
import {
  AgentStatus,
  AgentType,
  SpawnConfig,
  ForkConfig,
  AgentId,
} from "../core/types";
import { SkillRegistry, ReadonlySkillRegistry } from "../skills/SkillRegistry";
import { SpawnAgent } from "./SpawnAgent";

/**
 * MainAgent — root orchestrator.
 *
 * Responsibilities:
 *   - Owns the SkillRegistry (shared as read-only with children)
 *   - Creates SpawnAgents with task context propagation
 *   - Tracks all child SpawnAgents
 *   - Cascading termination: terminating Main terminates all Spawns
 */
export class MainAgent extends BaseAgent {
  /** Skill registry — shared with all SpawnAgents */
  readonly skills: SkillRegistry;

  /** Read-only view of skills for SpawnAgents */
  readonly sharedSkills: ReadonlySkillRegistry;

  /** All spawned children */
  private _children: Map<AgentId, SpawnAgent>;

  /** Event emitter for spawn/fork/terminate notifications */
  readonly events: EventEmitter;

  constructor(context: AgentContext, hooks?: AgentHooks) {
    super(context, hooks);
    this.skills = new SkillRegistry(this.id);
    this.sharedSkills = this.skills.createReadOnlyView();
    this._children = new Map();
    this.events = new EventEmitter();
    this.events.setMaxListeners(50);
  }

  // ─── Skill Management ───────────────────────────────────────────

  /** Register a skill (available to all SpawnAgents) */
  registerSkill(name: string, description: string, version = "1.0.0"): void {
    this.skills.register({ name, description, version });
  }

  // ─── Spawning ───────────────────────────────────────────────────

  /**
   * Spawn a new SpawnAgent.
   * The SpawnAgent inherits skills (read-only) and task context from Main.
   */
  spawn(config: SpawnConfig): SpawnAgent {
    const childContext = this.context.derive(
      AgentType.SPAWN,
      config.taskDescription,
      config.constraints,
      config.metadata
    );

    const spawnAgent = new SpawnAgent(childContext, this.sharedSkills, this.id);
    this._children.set(spawnAgent.id, spawnAgent);

    this.events.emit("spawn:created", {
      parentId: this.id,
      childId: spawnAgent.id,
      timestamp: Date.now(),
    });

    return spawnAgent;
  }

  /**
   * Fork from an existing SpawnAgent.
   * The ForkAgent inherits SpawnAgent's context and shares its memory.
   */
  fork(fromSpawnId: AgentId, config: ForkConfig) {
    const spawnAgent = this._children.get(fromSpawnId);
    if (!spawnAgent) {
      throw new Error(
        `Cannot fork: SpawnAgent "${fromSpawnId}" not found in children of Main "${this.id}"`
      );
    }
    if (spawnAgent.status !== AgentStatus.RUNNING && spawnAgent.status !== AgentStatus.IDLE) {
      throw new Error(
        `Cannot fork: SpawnAgent "${fromSpawnId}" is in state "${spawnAgent.status}"`
      );
    }

    const forkAgent = spawnAgent.fork(config);

    this.events.emit("fork:created", {
      spawnId: fromSpawnId,
      forkId: forkAgent.id,
      timestamp: Date.now(),
    });

    return forkAgent;
  }

  // ─── Child Management ───────────────────────────────────────────

  /** Get a SpawnAgent by ID */
  getChild(id: AgentId): SpawnAgent | undefined {
    return this._children.get(id);
  }

  /** List all SpawnAgent IDs */
  get childIds(): AgentId[] {
    return Array.from(this._children.keys());
  }

  /** Total number of SpawnAgents */
  get childCount(): number {
    return this._children.size;
  }

  /** Get all fork IDs across all spawn children */
  getAllForkIds(): AgentId[] {
    const ids: AgentId[] = [];
    for (const child of this._children.values()) {
      ids.push(...child.forkIds);
    }
    return ids;
  }

  /** Terminate a specific SpawnAgent (cascades to its Forks) */
  async terminateChild(id: AgentId): Promise<void> {
    const child = this._children.get(id);
    if (!child) throw new Error(`SpawnAgent "${id}" not found`);
    await child.terminate();
    this._children.delete(id);
    this.events.emit("spawn:terminated", { childId: id, timestamp: Date.now() });
  }

  /** Terminate all SpawnAgents */
  async terminateAllChildren(): Promise<void> {
    const ids = Array.from(this._children.keys());
    await Promise.all(ids.map((id) => this.terminateChild(id)));
  }

  // ─── Override terminate for cascading cleanup ────────────────────

  async terminate(): Promise<void> {
    // Cascading: terminate all children first
    await this.terminateAllChildren();
    await super.terminate();
  }

  // ─── MainAgent execution ─────────────────────────────────────────

  /** Execute the MainAgent's primary task */
  async execute(): Promise<void> {
    if (this.status !== AgentStatus.RUNNING) {
      throw new Error(`MainAgent "${this.id}" is not RUNNING (current: ${this.status})`);
    }
    // MainAgent's execute is a no-op by default — subclasses override
  }
}
