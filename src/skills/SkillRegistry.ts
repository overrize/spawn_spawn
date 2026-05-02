import { AgentId } from "../core/types";

/**
 * A Skill is a named capability that can be loaded by an agent.
 * MainAgent owns the skill registry and shares it with SpawnAgents.
 */
export interface Skill {
  /** Unique skill identifier */
  name: string;
  /** Human-readable description */
  description: string;
  /** The skill version */
  version: string;
  /** Skill metadata (e.g., parameters, capabilities) */
  metadata?: Record<string, unknown>;
}

/**
 * SkillRegistry — manages available skills.
 *
 * MainAgent creates and owns the registry.
 * SpawnAgents receive a read-only reference.
 * ForkAgents do NOT get skills directly — they inherit via their Spawn parent.
 */
export class SkillRegistry {
  private _skills: Map<string, Skill>;
  private _ownerId: AgentId;

  constructor(ownerId: AgentId) {
    this._skills = new Map();
    this._ownerId = ownerId;
  }

  /** Register a new skill */
  register(skill: Skill): void {
    if (this._skills.has(skill.name)) {
      throw new Error(`Skill "${skill.name}" is already registered`);
    }
    this._skills.set(skill.name, { ...skill });
  }

  /** Unregister a skill */
  unregister(name: string): boolean {
    return this._skills.delete(name);
  }

  /** Check if a skill is available */
  has(name: string): boolean {
    return this._skills.has(name);
  }

  /** Get a skill by name */
  get(name: string): Skill | undefined {
    const skill = this._skills.get(name);
    return skill ? { ...skill } : undefined;
  }

  /** List all registered skill names */
  list(): string[] {
    return Array.from(this._skills.keys());
  }

  /** List all registered skills with full metadata */
  listAll(): Skill[] {
    return Array.from(this._skills.values()).map((s) => ({ ...s }));
  }

  /** Number of registered skills */
  get size(): number {
    return this._skills.size;
  }

  /**
   * Create a read-only view of this registry.
   * SpawnAgents receive this view — they can read but not mutate.
   */
  createReadOnlyView(): ReadonlySkillRegistry {
    return new ReadonlySkillRegistry(this);
  }
}

/**
 * ReadonlySkillRegistry — read-only delegate.
 * Used by SpawnAgents to access skills without mutating the registry.
 */
export class ReadonlySkillRegistry {
  private _source: SkillRegistry;

  constructor(source: SkillRegistry) {
    this._source = source;
  }

  has(name: string): boolean {
    return this._source.has(name);
  }

  get(name: string): Skill | undefined {
    return this._source.get(name);
  }

  list(): string[] {
    return this._source.list();
  }

  listAll(): Skill[] {
    return this._source.listAll();
  }

  get size(): number {
    return this._source.size;
  }
}
