import { AgentStatus, VALID_TRANSITIONS } from "./types";

/** Error thrown on invalid state transitions */
export class InvalidTransitionError extends Error {
  constructor(from: AgentStatus, to: AgentStatus) {
    super(`Invalid state transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/**
 * AgentState — manages lifecycle state machine for all agent types.
 *
 * Valid transitions:
 *   IDLE → INITIALIZING → RUNNING ⇄ PAUSED
 *                    ↓         ↓
 *                    ✕   TERMINATING → TERMINATED
 *                    ↓         ↑
 *                  ERROR ──────┘
 */
export class AgentState {
  private _current: AgentStatus;
  private readonly _history: Array<{ from: AgentStatus; to: AgentStatus; timestamp: number }>;

  constructor(initial: AgentStatus = AgentStatus.IDLE) {
    this._current = initial;
    this._history = [];
  }

  /** Current agent status */
  get current(): AgentStatus {
    return this._current;
  }

  /** Full transition history */
  get history(): ReadonlyArray<{ from: AgentStatus; to: AgentStatus; timestamp: number }> {
    return this._history;
  }

  /** Attempt a transition. Throws InvalidTransitionError if invalid. */
  transition(to: AgentStatus): void {
    const allowed = VALID_TRANSITIONS[this._current];
    if (!allowed.includes(to)) {
      throw new InvalidTransitionError(this._current, to);
    }

    this._history.push({
      from: this._current,
      to,
      timestamp: Date.now(),
    });
    this._current = to;
  }

  /** Check if a transition is allowed without performing it */
  canTransition(to: AgentStatus): boolean {
    return VALID_TRANSITIONS[this._current].includes(to);
  }

  /** Whether the agent is in a terminal state */
  get isTerminal(): boolean {
    return this._current === AgentStatus.TERMINATED || this._current === AgentStatus.ERROR;
  }

  /** Whether the agent is active (can do work) */
  get isActive(): boolean {
    return this._current === AgentStatus.RUNNING;
  }

  /** Reset to IDLE (for testing) */
  reset(): void {
    this._current = AgentStatus.IDLE;
    this._history.length = 0;
  }
}
