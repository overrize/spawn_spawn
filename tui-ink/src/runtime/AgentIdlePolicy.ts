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

export function decideAgentIdleAfterNoTools(s: AgentIdleState): AgentIdleAction {
  if (s.acted) return "noop";
  if (s.hasPendingTodos) return s.continuations < 3 && !s.gaveUp ? "nudge" : "hard-circuit";
  if (s.sentToUser && (s.activeChildren ?? 0) === 0) return "converge";
  return s.continuations < 2 && !s.gaveUp ? "silent-nudge" : "silent-hard-circuit";
}

