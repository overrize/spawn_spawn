import { v4 as uuidv4 } from "./uuid";
import { AgentId, TaskId, TaskContext, AgentType, JsonValue } from "./types";

/**
 * AgentContext — carries task context through the agent hierarchy.
 *
 * Propagation:
 *   Main ──(base context)──→ Spawn ──(inherits + scoped)──→ Fork
 *
 * Each layer appends itself to parentChain and can add scoped metadata.
 */
export class AgentContext {
  readonly taskId: TaskId;
  readonly agentId: AgentId;
  readonly agentType: AgentType;
  readonly description: string;
  readonly parentChain: AgentId[];
  readonly constraints: string[];
  readonly metadata: Record<string, JsonValue>;
  readonly createdAt: number;

  constructor(params: {
    taskId: TaskId;
    agentId: AgentId;
    agentType: AgentType;
    description: string;
    parentChain?: AgentId[];
    constraints?: string[];
    metadata?: Record<string, JsonValue>;
  }) {
    this.taskId = params.taskId;
    this.agentId = params.agentId;
    this.agentType = params.agentType;
    this.description = params.description;
    this.parentChain = params.parentChain ?? [];
    this.constraints = params.constraints ?? [];
    this.metadata = params.metadata ?? {};
    this.createdAt = Date.now();
  }

  /**
   * Create a root context for the Main agent.
   */
  static createRoot(description: string, constraints?: string[], metadata?: Record<string, JsonValue>): AgentContext {
    const taskId = uuidv4();
    const agentId = `main-${taskId.slice(0, 8)}`;
    return new AgentContext({
      taskId,
      agentId,
      agentType: AgentType.MAIN,
      description,
      constraints,
      metadata,
    });
  }

  /**
   * Derive a child context for a Spawn or Fork agent.
   * Appends the current agentId to parentChain.
   */
  derive(agentType: AgentType, description: string, constraints?: string[], metadata?: Record<string, JsonValue>): AgentContext {
    const prefix = agentType === AgentType.SPAWN ? "spawn" : "fork";
    const agentId = `${prefix}-${uuidv4().slice(0, 8)}`;

    // Merge constraints: child can add additional constraints
    const mergedConstraints = [...this.constraints, ...(constraints ?? [])];

    // Merge metadata: child can override/scoped overlay
    const mergedMetadata: Record<string, JsonValue> = { ...this.metadata, ...(metadata ?? {}) };

    return new AgentContext({
      taskId: this.taskId,
      agentId,
      agentType,
      description,
      parentChain: [...this.parentChain, this.agentId],
      constraints: mergedConstraints,
      metadata: mergedMetadata,
    });
  }

  /**
   * Get the root agent ID (first in parentChain, or self if root).
   */
  get rootAgentId(): AgentId {
    return this.parentChain.length > 0 ? this.parentChain[0] : this.agentId;
  }

  /**
   * Get the direct parent agent ID, or null if root.
   */
  get parentAgentId(): AgentId | null {
    return this.parentChain.length > 0 ? this.parentChain[this.parentChain.length - 1] : null;
  }

  /**
   * Depth in the agent hierarchy (0 = root).
   */
  get depth(): number {
    return this.parentChain.length;
  }

  /**
   * Serialize to a plain object (for logging, transmission).
   */
  toJSON(): TaskContext {
    return {
      taskId: this.taskId,
      description: this.description,
      parentChain: [...this.parentChain],
      constraints: [...this.constraints],
      metadata: { ...this.metadata },
    };
  }
}
