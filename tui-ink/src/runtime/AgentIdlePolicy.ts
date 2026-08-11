export type AgentIdleAction =
  | "nudge"
  | "hard-circuit"
  | "silent-nudge"
  | "silent-hard-circuit"
  | "converge"
  | "noop";

export interface AgentIdleState {
  acted: boolean;
  hasPendingTodos: boolean;
  continuations: number;
  gaveUp: boolean;
  sentToUser?: boolean;
  activeChildren?: number;
}

export function isActionEventType(type: string): boolean {
  return type === "tool.call"
    || type === "spawn"
    || type === "message"
    || type === "unit.handup"
    || type === "agent.done";
}

// Coding completion guard verdict: should a worker's agent.done(success) be blocked?
//  - "test_failed"       → RunTests showed failures (emits test_failed_but_claimed_done)
//  - "missing_evidence"  → ran a test command but never got a valid pass result
//  - "allow"             → success accepted
export type DoneGuardVerdict = "allow" | "test_failed" | "missing_evidence";
export function decideDoneGuard(s: {
  success: boolean;
  lastTestFailed: number | null;
  ranTestCommand: boolean;
}): DoneGuardVerdict {
  if (!s.success) return "allow";
  if (s.lastTestFailed !== null && s.lastTestFailed > 0) return "test_failed";
  if (s.ranTestCommand && s.lastTestFailed === null) return "missing_evidence";
  return "allow";
}

export function decideAgentIdleAfterNoTools(s: AgentIdleState): AgentIdleAction {
  if (s.acted) return "noop";
  if (s.hasPendingTodos) return s.continuations < 3 && !s.gaveUp ? "nudge" : "hard-circuit";
  if (s.sentToUser && (s.activeChildren ?? 0) === 0) return "converge";
  return s.continuations < 2 && !s.gaveUp ? "silent-nudge" : "silent-hard-circuit";
}

