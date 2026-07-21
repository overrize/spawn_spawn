/**
 * store → TuiSnapshot selector (spawn-1.0 M3-7c). Pure projection of the store
 * State into the render read-model; keeps render.ts decoupled from the store.
 */

import type { AgentInfo, Message, TodoItem } from "../protocol.js";
import type { AgentRow, AgentState, ChatMsg, LogRow, TodoRow, TuiSnapshot } from "./render.js";

interface StoreLike {
  agents: Map<string, AgentInfo>;
  selectedAgent: string;
  messagesByAgent: Map<string, Message[]>;
  todosByAgent: Map<string, TodoItem[]>;
  pendingApprovals: Message[];
}

export interface SnapshotOpts { model?: string; webOn?: boolean; input?: string; scrollOffset?: number }

function mapState(s: AgentInfo["state"]): AgentState {
  if (s === "run" || s === "idle" || s === "done" || s === "err") return s;
  return "waiting";
}

/** Pre-order tree (root → children), with `last` = last child at its level. */
function orderedTree(agents: Map<string, AgentInfo>): Array<{ a: AgentInfo; depth: number; last: boolean }> {
  const all = [...agents.values()].filter((a) => !a.hidden);
  const kids = new Map<string, AgentInfo[]>();
  for (const a of all) {
    const k = a.parent && agents.has(a.parent) ? a.parent : "";
    (kids.get(k) ?? kids.set(k, []).get(k)!).push(a);
  }
  const out: Array<{ a: AgentInfo; depth: number; last: boolean }> = [];
  const visit = (id: string, depth: number) => {
    const list = kids.get(id) ?? [];
    list.forEach((c, i) => { out.push({ a: c, depth, last: i === list.length - 1 }); visit(c.id, depth + 1); });
  };
  visit("", 0);
  return out;
}

const TODO_STATE: Record<string, TodoRow["state"]> = { done: "done", run: "run", todo: "todo", warn: "run", err: "run" };

function statusLine(agents: AgentInfo[]): string {
  const running = agents.filter((a) => a.state === "run").map((a) => `${a.id} running`);
  const doneN = agents.filter((a) => a.state === "done").length;
  const parts = [...running];
  if (doneN) parts.push(`${doneN} done`);
  return parts.join(" · ") || "idle";
}

export function buildSnapshot(state: StoreLike, opts: SnapshotOpts = {}): TuiSnapshot {
  const selectedId = state.selectedAgent;
  const tree = orderedTree(state.agents);
  const allAgents = [...state.agents.values()].filter((a) => !a.hidden);

  const agents: AgentRow[] = tree.map(({ a, depth, last }) => ({
    id: a.id, depth, last, state: mapState(a.state), sub: a.sub ?? "",
  }));

  const chat: ChatMsg[] = (state.messagesByAgent.get(selectedId) ?? []).map((m) => ({
    from: m.agent === "user" ? "user" : m.agent,
    text: m.text,
    system: m.kind === "system" || m.kind === "tool_call" || m.kind === "tool_result",
  }));

  const todos: TodoRow[] = (state.todosByAgent.get(selectedId) ?? []).map((t) => ({
    state: TODO_STATE[t.state] ?? "todo", text: t.text,
  }));
  const runIdx = todos.findIndex((t) => t.state === "run");

  const logs: LogRow[] = [];
  for (const [agentId, msgs] of state.messagesByAgent) {
    for (const m of msgs) {
      if (m.kind === "tool_call" || m.kind === "system") logs.push({ time: "", agent: agentId, kind: m.kind, summary: m.text });
    }
  }

  const pa = state.pendingApprovals[0] ?? null;

  return {
    model: opts.model ?? state.agents.get(selectedId)?.model ?? "",
    webOn: opts.webOn ?? false,
    agents,
    selectedId,
    statusLine: statusLine(allAgents),
    chat,
    logs: logs.slice(-200),
    todos,
    planCurrentIdx: runIdx >= 0 ? runIdx : 0,
    input: opts.input ?? "",
    scrollOffset: opts.scrollOffset ?? 0,
    pendingApproval: pa ? { agent: pa.agent, tool: pa.tool_name ?? "tool", detail: pa.text } : null,
  };
}
