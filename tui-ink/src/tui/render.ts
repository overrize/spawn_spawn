/**
 * Pure renderer for the vertical single-main-view TUI (spawn-1.0 M3-7c).
 *
 * Old UI's rich style, new scrolling interaction. Default = Agents tree;
 * Enter → agent chat; Ctrl+T plan drawer above input; Ctrl+L logs/chat;
 * running-status line always above input (full-duplex state stays visible).
 * Vertical, refresh-stable, no left/right panes.
 *
 * renderFrame(snapshot, view, cols, rows) → EXACTLY `rows` lines, each EXACTLY
 * `cols` wide: fills the terminal (the "没铺满" fix), borders always aligned
 * (CJK-safe). The main body shows a scrolling window (tail = newest, or offset).
 */

import { displayWidth, truncateToWidth, wrapToWidth } from "./width.js";
import type { ViewState } from "./viewState.js";

export type AgentState = "run" | "idle" | "done" | "err" | "waiting";

export interface AgentRow {
  id: string;
  depth: number;
  last: boolean;      // last child at its level (tree connector)
  state: AgentState;
  sub: string;
}
export interface ChatMsg { from: string; text: string; system?: boolean }
export interface LogRow { time: string; agent: string; kind: string; summary: string }
export interface TodoRow { state: "done" | "run" | "todo"; text: string }

export interface TuiSnapshot {
  model: string;
  webOn: boolean;
  agents: AgentRow[];
  selectedId: string;
  statusLine: string;
  chat: ChatMsg[];
  logs: LogRow[];
  todos: TodoRow[];
  planCurrentIdx: number;
  input: string;
  scrollOffset: number;   // 0 = tail (newest); >0 scrolls up into history
  pendingApproval: { agent: string; tool: string; detail: string } | null;
}

/** Pad/truncate to exactly `n` cols, filling with `fill`. */
function fit(s: string, n: number, fill = " "): string {
  const t = truncateToWidth(s, n);
  const gap = n - displayWidth(t);
  return t + (gap > 0 ? fill.repeat(gap) : "");
}
const bTop = (c: number) => "┌" + "─".repeat(c - 2) + "┐";
const bMid = (title: string, c: number) => "├" + fit(title ? "─ " + title + " " : "", c - 2, "─") + "┤";
const bBot = (c: number) => "└" + "─".repeat(c - 2) + "┘";
const row = (inner: string, c: number) => "│" + fit(" " + inner, c - 2) + "│";

const DOT: Record<AgentState, string> = { run: "●", waiting: "◐", idle: "○", done: "✓", err: "✗" };
const STATE_LABEL: Record<AgentState, string> = {
  run: "running", waiting: "waiting", idle: "idle", done: "done", err: "error",
};

// ── Body builders (inner strings, unwrapped) ─────────────────────────────────

function agentBody(s: TuiSnapshot, cols: number): string[] {
  const out: string[] = [""];
  for (const a of s.agents) {
    const conn = a.depth === 0 ? "" : "  ".repeat(Math.max(0, a.depth - 1)) + (a.last ? "└─ " : "├─ ");
    const sel = a.id === s.selectedId ? "▸ " : "  ";
    const left = `${sel}${conn}${DOT[a.state]} ${a.id}`;
    const label = STATE_LABEL[a.state];
    out.push(fit(left, cols - 4 - 9) + label);
    if (a.sub) out.push(fit("", left.length >= 0 ? 4 : 0) + "    " + truncateToWidth(a.sub, cols - 12));
  }
  return out;
}

function chatBody(s: TuiSnapshot, cols: number): string[] {
  const out: string[] = [];
  for (const m of s.chat) {
    out.push(m.from);
    for (const w of wrapToWidth(m.text, cols - 6)) out.push("  " + w);
    out.push("");
  }
  return out;
}

function logBody(s: TuiSnapshot, cols: number): string[] {
  return s.logs.map((l) =>
    `${fit(l.time, 9)}${fit(l.agent, 12)}${fit(l.kind, 10)}${truncateToWidth(l.summary, cols - 35)}`);
}

// ── Frame ─────────────────────────────────────────────────────────────────────

export function renderFrame(s: TuiSnapshot, view: ViewState, cols: number, rows: number): string[] {
  const title = view.mode === "home" ? "spawn"
    : view.mode === "logs" ? `spawn / ${s.selectedId} · logs`
    : `spawn / ${s.selectedId}`;
  const bodyTitle = view.mode === "home" ? "Agents" : view.mode === "logs" ? "logs" : "";

  const body = view.mode === "home" ? agentBody(s, cols)
    : view.mode === "logs" ? logBody(s, cols)
    : chatBody(s, cols);

  // Drawers (above status): plan + approval.
  const drawer: string[] = [];
  if (view.planLevel > 0 && view.mode !== "logs" && s.todos.length) {
    drawer.push(bMid("Plan", cols));
    if (view.planLevel === 1) {
      const cur = s.todos[s.planCurrentIdx];
      drawer.push(row(`[${s.planCurrentIdx + 1}/${s.todos.length}] → ${cur?.text ?? "(无)"}`, cols));
    } else {
      s.todos.forEach((t, i) => {
        const mark = t.state === "done" ? "done" : t.state === "run" ? "run " : "todo";
        drawer.push(row(`${i + 1}. [${mark}] ${t.text}`, cols));
      });
    }
  }
  if (s.pendingApproval) {
    drawer.push(bMid("⚠ approval", cols));
    drawer.push(row(`${s.pendingApproval.agent} → ${s.pendingApproval.tool}    [y] approve   [n] reject`, cols));
    drawer.push(row(truncateToWidth(s.pendingApproval.detail, cols - 4), cols));
  }

  // Layout: top(1)+title(1)+bodyHeader(1) + body(N) + drawer + statusSep(1)+status(1) + inputSep(1)+input(1) + bottom(1)
  const overhead = 3 + drawer.length + 2 + 2 + 1;
  const bodyBudget = Math.max(1, rows - overhead);

  // Scrolling window: show tail by default; scrollOffset scrolls up.
  const start = Math.max(0, body.length - bodyBudget - s.scrollOffset);
  const windowed = body.slice(start, start + bodyBudget);
  while (windowed.length < bodyBudget) windowed.push("");

  const out: string[] = [];
  out.push(bTop(cols));
  // Title as its own content row (per spec), model/web right-aligned.
  const meta = view.mode === "logs" ? "events · live" : `${s.model}${s.webOn ? " · web: on" : ""}`;
  out.push(row(fit(title, cols - 4 - displayWidth(meta) - 1) + " " + meta, cols));
  out.push(bMid(bodyTitle, cols));
  for (const b of windowed) out.push(row(b, cols));
  out.push(...drawer);
  out.push(bMid("", cols));
  out.push(row(s.statusLine || "idle", cols));
  out.push(bMid("", cols));
  out.push(row(`› ${s.input}`, cols));
  out.push(bBot(cols));
  return out.slice(0, rows);
}
