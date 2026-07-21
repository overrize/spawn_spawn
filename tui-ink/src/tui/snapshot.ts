/**
 * store → TuiSnapshot selector (spawn-1.0 M3-7b-view).
 *
 * Pure projection of the store State into the render read-model. Keeps
 * render.ts decoupled from the store shape — the wire step (M3-7b-wire) calls
 * this inside a useStore selector. Pure ⇒ unit-testable without React.
 */

import type { AgentInfo, Message, TodoItem } from "../protocol.js";
import type { AgentRow, ChatMsg, LogRow, TodoRow, TuiSnapshot } from "./render.js";

interface StoreLike {
  agents: Map<string, AgentInfo>;
  selectedAgent: string;
  messagesByAgent: Map<string, Message[]>;
  todosByAgent: Map<string, TodoItem[]>;
  pendingApprovals: Message[];
}

export interface SnapshotOpts {
  model?: string;
  webOn?: boolean;
  input?: string;
}

function mapState(s: AgentInfo["state"]): AgentRow["state"] {
  return s === "run" || s === "idle" || s === "done" || s === "err" ? s : "idle";
}

/** Order agents as a stable pre-order tree (root → children), skipping hidden. */
function orderedTree(agents: Map<string, AgentInfo>): AgentInfo[] {
  const all = [...agents.values()].filter((a) => !a.hidden);
  const byParent = new Map<string, AgentInfo[]>();
  for (const a of all) {
    const key = a.parent ?? "";
    (byParent.get(key) ?? byParent.set(key, []).get(key)!).push(a);
  }
  const out: AgentInfo[] = [];
  const visit = (id: string) => {
    for (const child of byParent.get(id) ?? []) { out.push(child); visit(child.id); }
  };
  // roots = agents whose parent is absent or not in the map
  const roots = all.filter((a) => !a.parent || !agents.has(a.parent));
  for (const r of roots) { out.push(r); visit(r.id); }
  return out;
}

function depthOf(a: AgentInfo, agents: Map<string, AgentInfo>): number {
  if (typeof a.depth === "number") return a.depth;
  let d = 0, cur: AgentInfo | undefined = a;
  while (cur?.parent && agents.has(cur.parent) && d < 10) { d++; cur = agents.get(cur.parent); }
  return d;
}

const TODO_STATE: Record<string, TodoRow["state"]> = {
  done: "done", run: "run", todo: "todo", warn: "run", err: "run",
};

export function buildSnapshot(state: StoreLike, opts: SnapshotOpts = {}): TuiSnapshot {
  const selectedId = state.selectedAgent;
  const tree = orderedTree(state.agents);

  const agents: AgentRow[] = tree.map((a) => ({
    id: a.id,
    depth: depthOf(a, state.agents),
    state: mapState(a.state),
    runtime: "--:--",
    sub: a.sub ?? a.goal ?? "",
  }));

  const chat: ChatMsg[] = (state.messagesByAgent.get(selectedId) ?? []).map((m) => ({
    from: m.agent === "user" ? "user" : m.agent,
    text: m.text,
    system: m.kind === "system" || m.kind === "tool_call" || m.kind === "tool_result",
  }));

  const todos: TodoRow[] = (state.todosByAgent.get(selectedId) ?? []).map((t) => ({
    state: TODO_STATE[t.state] ?? "todo",
    text: t.text,
  }));
  const runIdx = todos.findIndex((t) => t.state === "run");

  // Lightweight log: recent tool/system lines across agents (newest last).
  const logs: LogRow[] = [];
  for (const [agentId, msgs] of state.messagesByAgent) {
    for (const m of msgs) {
      if (m.kind === "tool_call" || m.kind === "system") {
        logs.push({ time: "", agent: agentId, kind: m.kind, summary: m.text });
      }
    }
  }

  const pa = state.pendingApprovals[0] ?? null;
  const rootGoal = state.agents.get(selectedId)?.goal
    ?? state.agents.get("pm")?.goal
    ?? tree[0]?.goal ?? "";

  return {
    goal: rootGoal,
    model: opts.model ?? state.agents.get(selectedId)?.model ?? "",
    webOn: opts.webOn ?? false,
    agents,
    selectedId,
    running: tree.filter((a) => a.state === "run").map((a) => a.id),
    chat,
    logs: logs.slice(-40),
    todos,
    planCurrentIdx: runIdx >= 0 ? runIdx : 0,
    input: opts.input ?? "",
    pendingApproval: pa ? { agent: pa.agent, tool: pa.tool_name ?? "tool", detail: pa.text } : null,
  };
}
