import { AgentState } from "../core/AgentState";
import { AgentContext } from "../core/AgentContext";
import { AgentId, AgentStatus, AgentType } from "../core/types";

/**
 * Agent lifecycle hook interface.
 * Subclasses override these to define behavior.
 */
export interface AgentHooks {
  /** Called during INITIALIZING transition */
  onInit?(): Promise<void>;
  /** Called after entering RUNNING state */
  onStart?(): Promise<void>;
  /** Called when PAUSED */
  onPause?(): Promise<void>;
  /** Called when RESUMING */
  onResume?(): Promise<void>;
  /** Called after entering TERMINATED */
  onTerminate?(): Promise<void>;
  /** Called when transitioning to ERROR */
  onError?(error: Error): Promise<void>;
}

/**
 * BaseAgent — abstract agent class.
 *
 * Provides:
 *   - Lifecycle state machine (AgentState)
 *   - Context management (AgentContext)
 *   - Hook system for lifecycle events
 *   - Error boundary for safe execution
 *
 * Subclasses:
 *   - MainAgent — root orchestrator
 *   - SpawnAgent — intermediate, owns SharedMemory
 *   - ForkAgent — leaf, inherits context, references SharedMemory
 */
export abstract class BaseAgent {
  readonly context: AgentContext;
  readonly state: AgentState;
  protected hooks: AgentHooks;
  /** Error that caused transition to ERROR state, if any */
  protected _error: Error | null = null;

  constructor(context: AgentContext, hooks?: AgentHooks) {
    this.context = context;
    this.state = new AgentState(AgentStatus.IDLE);
    this.hooks = hooks ?? {};
  }

  /** Agent identifier */
  get id(): AgentId {
    return this.context.agentId;
  }

  /** Agent type */
  get type(): AgentType {
    return this.context.agentType;
  }

  /** Current status */
  get status(): AgentStatus {
    return this.state.current;
  }

  /** Most recent error */
  get error(): Error | null {
    return this._error;
  }

  // ─── Lifecycle Methods ──────────────────────────────────────────

  /** Initialize the agent: IDLE → INITIALIZING → RUNNING */
  async init(): Promise<void> {
    try {
      this.guardTransition(AgentStatus.INITIALIZING);
      this.state.transition(AgentStatus.INITIALIZING);

      if (this.hooks.onInit) {
        await this.hooks.onInit();
      }

      this.state.transition(AgentStatus.RUNNING);

      if (this.hooks.onStart) {
        await this.hooks.onStart();
      }
    } catch (err) {
      this.handleError(err as Error);
    }
  }

  /** Pause the agent: RUNNING → PAUSED */
  async pause(): Promise<void> {
    try {
      this.guardTransition(AgentStatus.PAUSED);
      this.state.transition(AgentStatus.PAUSED);

      if (this.hooks.onPause) {
        await this.hooks.onPause();
      }
    } catch (err) {
      this.handleError(err as Error);
    }
  }

  /** Resume the agent: PAUSED → RESUMING → RUNNING */
  async resume(): Promise<void> {
    try {
      this.guardTransition(AgentStatus.RESUMING);
      this.state.transition(AgentStatus.RESUMING);

      if (this.hooks.onResume) {
        await this.hooks.onResume();
      }

      this.state.transition(AgentStatus.RUNNING);
    } catch (err) {
      this.handleError(err as Error);
    }
  }

  /** Terminate the agent: RUNNING/PAUSED/ERROR → TERMINATING → TERMINATED */
  async terminate(): Promise<void> {
    try {
      this.state.transition(AgentStatus.TERMINATING);

      if (this.hooks.onTerminate) {
        await this.hooks.onTerminate();
      }

      this.state.transition(AgentStatus.TERMINATED);
    } catch (err) {
      this.handleError(err as Error);
    }
  }

  // ─── Protected Helpers ──────────────────────────────────────────

  protected guardTransition(to: AgentStatus): void {
    if (!this.state.canTransition(to)) {
      throw new Error(
        `Agent ${this.id}: Cannot transition from ${this.state.current} to ${to}`
      );
    }
  }

  protected handleError(err: Error): void {
    this._error = err;
    // Try to go to ERROR state — if already terminal, just store it
    try {
      if (this.state.canTransition(AgentStatus.ERROR)) {
        this.state.transition(AgentStatus.ERROR);
      }
    } catch {
      // Already terminal or invalid — swallow
    }
    if (this.hooks.onError) {
      this.hooks.onError(err).catch(() => {
        // Swallow — error handler should not throw
      });
    }
  }

  // ─── Abstract ───────────────────────────────────────────────────

  /** Execute the agent's primary task logic. Subclasses must implement. */
  abstract execute(): Promise<void>;

  /** String representation */
  toString(): string {
    return `${this.type}[${this.id}](${this.status})`;
  }
}
