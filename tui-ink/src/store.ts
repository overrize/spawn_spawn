// Store — 单一可变状态。Ink 组件用 useStore() 订阅。
// 手动 subscribe + useState,避免 useSyncExternalStore 与 Ink React 的兼容问题。

import { useEffect, useState } from "react";
import type {
  AgentInfo, Message, TodoItem, TuiEvent, Session, LogLevel,
} from "./protocol.js";

interface State {
  agents: Map<string, AgentInfo>;
  selectedAgent: string;          // 当前选中,渲染右栏用
  messagesByAgent: Map<string, Message[]>;
  todosByAgent: Map<string, TodoItem[]>;
  stepByAgent: Map<string, string>;
  pendingApprovals: Message[];    // 待审批的 tool calls
  pendingInputAgents: Set<string>; // agents with queued user messages not yet processed
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  sessionsByAgent: Map<string, Session[]>;
  currentSessionByAgent: Map<string, string>;
  layout: "v1" | "v3";
  scrollOffset: number;
  agentPaneScroll: number;   // manual scroll offset for the left agent panel
  minLevel: LogLevel;
}

const state: State = {
  agents: new Map(),
  selectedAgent: "pm",
  messagesByAgent: new Map(),
  todosByAgent: new Map(),
  stepByAgent: new Map(),
  pendingApprovals: [],
  pendingInputAgents: new Set(),
  cost_usd: 0,
  tokens_in: 0,
  tokens_out: 0,
  sessionsByAgent: new Map(),
  currentSessionByAgent: new Map(),
  layout: "v1",
  scrollOffset: 0,
  agentPaneScroll: 0,
  minLevel: "info",
};

const listeners = new Set<() => void>();
let _notifyPending = false;
const notify = () => {
  if (_notifyPending) return;
  _notifyPending = true;
  setImmediate(() => {
    _notifyPending = false;
    listeners.forEach((l) => l());
  });
};

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 在非 React 上下文(事件回调、命令分派)读取当前状态。 */
export function getState(): State { return state; }

export function useStore<T>(sel: (s: State) => T): T {
  const [val, setVal] = useState<T>(() => sel(state));
  useEffect(() => subscribe(() => setVal(sel(state))), []);
  return val;
}

let mid = 0;
const newMid = () => `m${++mid}`;

function pushMessage(agent: string, m: Omit<Message, "id" | "ts">) {
  const list = state.messagesByAgent.get(agent) ?? [];
  list.push({ id: newMid(), ts: Date.now(), ...m });
  state.messagesByAgent.set(agent, list);
}

export function ensureAgent(a: AgentInfo) {
  const existing = state.agents.get(a.id);
  state.agents.set(a.id, { ...existing, ...a });
  if (!state.messagesByAgent.has(a.id)) state.messagesByAgent.set(a.id, []);
  if (!state.todosByAgent.has(a.id)) state.todosByAgent.set(a.id, []);
  if (!state.sessionsByAgent.has(a.id)) newSession(a.id);
  notify();
}

export function selectAgent(id: string) {
  if (state.agents.has(id)) { state.selectedAgent = id; state.scrollOffset = 0; notify(); }
}

export function userMessage(toAgent: string, text: string) {
  pushMessage(toAgent, { agent: "user", to: toAgent, kind: "text", text });
  notify();
}

/** Mark that a user message is queued but the agent hasn't started processing it yet. */
export function markPendingInput(agentId: string): void {
  state.pendingInputAgents.add(agentId);
  notify();
}

export function clearPendingInput(agentId: string): void {
  state.pendingInputAgents.delete(agentId);
  notify();
}

export function abortAgent(agentId: string): void {
  state.pendingApprovals = state.pendingApprovals.filter((p) => p.agent !== agentId);
  notify();
}

export function approve(toolId: string) {
  const m = state.pendingApprovals.find((p) => p.tool_id === toolId);
  if (m) m.approved = true;
  state.pendingApprovals = state.pendingApprovals.filter((p) => p.tool_id !== toolId);
  notify();
}

export function reject(toolId: string) {
  state.pendingApprovals = state.pendingApprovals.filter((p) => p.tool_id !== toolId);
  notify();
}

export function newSession(agentId: string): string {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const sessions = state.sessionsByAgent.get(agentId) ?? [];
  const session: Session = {
    id,
    agentId,
    title: "(new session)",
    createdAt: Date.now(),
    messageCount: 0,
  };
  sessions.push(session);
  state.sessionsByAgent.set(agentId, sessions);
  state.currentSessionByAgent.set(agentId, id);
  notify();
  return id;
}

export function switchSession(agentId: string, sessionId: string): void {
  const sessions = state.sessionsByAgent.get(agentId) ?? [];
  if (sessions.find((s) => s.id === sessionId)) {
    state.currentSessionByAgent.set(agentId, sessionId);
    notify();
  }
}

export function setLayout(l: "v1" | "v3"): void {
  state.layout = l;
  notify();
}

export function setMinLevel(l: LogLevel): void {
  state.minLevel = l;
  notify();
}

const PERMANENT_IDS = new Set(["pm", "process-monitor"]);

/** Called when user sends next message to PM — hides all completed (done) non-permanent agents. */
export function clearDoneAgents(): void {
  let changed = false;
  for (const [, agent] of state.agents) {
    if (agent.state === "done" && !PERMANENT_IDS.has(agent.id) && !agent.hidden) {
      agent.hidden = true;
      changed = true;
      if (state.selectedAgent === agent.id) {
        state.selectedAgent = agent.parent ?? "pm";
        state.scrollOffset = 0;
      }
    }
  }
  if (changed) notify();
}

export function resumeAgent(id: string): void {
  const a = state.agents.get(id);
  if (!a) return;
  a.state = "run";
  a.sub = "resuming…";
  state.stepByAgent.set(id, "");
  notify();
}

export function updateAgentInfo(id: string, patch: Partial<AgentInfo>): void {
  const info = state.agents.get(id);
  if (!info) return;
  Object.assign(info, patch);
  notify();
}

export function applyEvent(e: TuiEvent) {
  switch (e.type) {
    case "agent.state": {
      const a = state.agents.get(e.agent);
      if (a) {
        a.state = e.state;
        if (e.sub !== undefined) a.sub = e.sub;
        else if (e.state === "idle" || e.state === "done" || e.state === "err") a.sub = "";
      }
      // Agent actually started processing — clear pending-input flag
      if (e.state === "run") state.pendingInputAgents.delete(e.agent);
      break;
    }
    case "todo.set":
      state.todosByAgent.set(e.agent, e.items);
      break;
    case "step":
      state.stepByAgent.set(e.agent, e.text);
      break;
    case "message":
      if (e.to === "user") {
        pushMessage(e.agent, { agent: e.agent, to: "user", kind: "text", text: e.text, level: "info" });
      } else {
        pushMessage(e.agent, { agent: e.agent, to: e.to, kind: "text", text: `→ @${e.to}: ${e.text}`, level: "info" });
        pushMessage(e.to,    { agent: e.agent, to: e.to, kind: "text", text: `← @${e.agent}: ${e.text}`, level: "info" });
      }
      // 自动更新当前 session 的标题和计数
      {
        const sessId = state.currentSessionByAgent.get(e.agent);
        if (sessId) {
          const sessions = state.sessionsByAgent.get(e.agent) ?? [];
          const sess = sessions.find((s) => s.id === sessId);
          if (sess) {
            sess.messageCount++;
            if (sess.title === "(new session)" && e.to === "user") {
              sess.title = e.text.slice(0, 40);
            }
          }
        }
      }
      break;
    case "tool.call": {
      const m: Message = {
        id: newMid(), ts: Date.now(),
        agent: e.agent, to: "user", kind: "tool_call",
        text: `${e.name}(${shortArgs(e.args)})`,
        tool_name: e.name, tool_args: e.args, tool_id: e.id,
        needs_approval: !!e.needs_approval, approved: !e.needs_approval,
        level: e.needs_approval ? "warn" : "debug",
      };
      const list = state.messagesByAgent.get(e.agent) ?? [];
      list.push(m);
      state.messagesByAgent.set(e.agent, list);
      if (e.needs_approval) state.pendingApprovals.push(m);
      break;
    }
    case "tool.result":
      pushMessage(e.agent, {
        agent: e.agent, to: "user", kind: "tool_result",
        text: `→ ${e.ok ? "✓" : "✗"} ${e.output.slice(0, 160)}`,
        tool_id: e.id,
        level: e.ok ? "debug" : "error",
      });
      break;
    case "spawn": {
      ensureAgent({
        id: e.child, name: e.child, role: e.role,
        parent: e.parent, state: "idle", goal: e.goal, sub: e.goal, model: e.model,
        dispatch: e.dispatch,
      });
      pushMessage(e.parent, {
        agent: e.parent, to: "user", kind: "system",
        text: `⑂ spawn ${e.child} (${e.role}) — ${e.goal}`,
        level: "info",
      });
      // Auto-focus the new child only if currently focused on parent
      if (state.selectedAgent === e.parent) {
        state.selectedAgent = e.child;
        state.scrollOffset = 0;
      }
      break;
    }
    case "agent.done": {
      const a = state.agents.get(e.agent);
      if (a) a.state = e.success ? "done" : "err";
      state.stepByAgent.set(e.agent, e.reason ?? (e.success ? "done" : "failed"));
      // Switch back to parent so the user sees PM's follow-up reply
      if (state.selectedAgent === e.agent && a?.parent) {
        state.selectedAgent = a.parent;
        state.scrollOffset = 0;
      }
      break;
    }
    case "agent.error": {
      const a = state.agents.get(e.agent);
      if (a) { a.state = "err"; a.sub = e.detail ?? e.code; }
      pushMessage(e.agent, {
        agent: e.agent, to: "user", kind: "system",
        text: `⚠ ${e.code}${e.detail ? ": " + e.detail : ""}`,
        level: "error",
      });
      break;
    }
    case "task.notification": {
      // Notify parent agent that a child has completed (foreground or background mode)
      const status = e.success ? "成功完成" : "失败";
      pushMessage(e.parent, {
        agent: e.child_id, to: "user", kind: "system",
        text: `[系统-通知] 子 agent ${e.child_id} ${status}。理由: ${e.reason ?? "（无）"}`,
        level: e.success ? "info" : "warn",
      });
      // Update child state in todo (mark done)
      const childAgent = state.agents.get(e.child_id);
      if (childAgent) {
        childAgent.state = e.success ? "done" : "err";
        childAgent.sub = e.reason ?? (e.success ? "done" : "failed");
      }
      break;
    }
    // S6: new event types
    case "pm.alert":
      pushMessage(e.agent, {
        agent: e.agent, to: "user", kind: "system",
        text: `PM[${e.severity}] ${e.code}: ${e.detail}`,
        level: e.severity === "error" ? "error" : "warn",
      });
      break;
    case "unit.handup":
      pushMessage(e.parent, {
        agent: e.agent, to: "user", kind: "system",
        text: `↑ handup from ${e.agent}: ${e.summary.slice(0, 120)}`,
        level: "info",
      });
      break;
    case "memory.snapshot":
      pushMessage(e.agent, {
        agent: e.agent, to: "user", kind: "system",
        text: `💾 memory snapshot → ${e.path} (${e.size_kb}kb)`,
        level: "debug",
      });
      break;
    case "shutdown.start":
      pushMessage(e.agent, {
        agent: e.agent, to: "user", kind: "system",
        text: `⏹ shutdown: ${e.reason}`,
        level: "info",
      });
      break;
    case "proposal.new":
      pushMessage(e.agent, {
        agent: e.agent, to: "user", kind: "system",
        text: `📝 proposal ${e.proposal_id} (${e.target})`,
        level: "info",
      });
      break;
    case "proposal.decision":
      // no agent field — add to leader conv
      pushMessage("leader", {
        agent: "leader", to: "user", kind: "system",
        text: `🗳 proposal ${e.proposal_id}: ${e.decision}${e.reason ? " — " + e.reason : ""}`,
        level: "info",
      });
      break;
    case "task.notification": {
      const status = e.success ? "成功" : "失败";
      const reason = e.reason ? `。理由: ${e.reason}` : "";
      pushMessage(e.parent, {
        agent: e.agent,
        to: e.parent,
        kind: "system",
        text: `[系统-通知] 子 agent ${e.child_id} ${status}${reason}`,
        level: "info",
      });
      break;
    }
  }
  notify();
}

export const CONV_PAGE = 12;

export function scrollBy(delta: number): void {
  // Upper clamp is handled by ConvPane (it knows total line count).
  // Here just prevent negative so ] at bottom doesn't go past 0.
  state.scrollOffset = Math.max(0, state.scrollOffset + delta);
  notify();
}

export function scrollAgentBy(delta: number, totalAgents: number, maxVisible: number): void {
  const max = Math.max(0, totalAgents - maxVisible);
  state.agentPaneScroll = Math.max(0, Math.min(max, state.agentPaneScroll + delta));
  notify();
}

/** Hide all completed/errored non-permanent agents from the panel. */
export function pruneAgents(): number {
  let count = 0;
  for (const [, agent] of state.agents) {
    if (PERMANENT_IDS.has(agent.id) || agent.hidden) continue;
    if (agent.state === "done" || agent.state === "err") {
      agent.hidden = true;
      count++;
      if (state.selectedAgent === agent.id) {
        state.selectedAgent = agent.parent ?? "pm";
        state.scrollOffset = 0;
      }
    }
  }
  state.agentPaneScroll = 0;
  if (count > 0) notify();
  return count;
}

function shortArgs(args: unknown): string {
  try {
    const s = typeof args === "string" ? args : JSON.stringify(args);
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  } catch { return ""; }
}

export function _resetForTest(): void {
  state.agents.clear();
  state.selectedAgent = "pm";
  state.messagesByAgent.clear();
  state.todosByAgent.clear();
  state.stepByAgent.clear();
  state.pendingApprovals.length = 0;
  state.pendingInputAgents.clear();
  state.cost_usd = 0;
  state.tokens_in = 0;
  state.tokens_out = 0;
  state.sessionsByAgent.clear();
  state.currentSessionByAgent.clear();
  state.layout = "v1";
  state.scrollOffset = 0;
  state.agentPaneScroll = 0;
  state.minLevel = "info";
}
