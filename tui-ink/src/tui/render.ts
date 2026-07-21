/**
 * Pure renderer for the single-main-view TUI (spawn-1.0 M3-7b-view).
 *
 * renderFrame(snapshot, view, cols, rows) → string[] where EVERY line has
 * display width exactly === cols. Because the whole frame is one main view
 * (no side-by-side panes), there are no vertical dividers to misalign — long
 * content wraps/truncates within the single box. This is the structural fix
 * for the CJK divider-misalignment bug.
 *
 * Reads a TuiSnapshot (built from the store by the caller), so this module is
 * decoupled from the store and snapshot-testable.
 */

import { displayWidth, padToWidth, truncateToWidth, wrapToWidth } from "./width.js";
import type { ViewState } from "./viewState.js";

export interface AgentRow {
  id: string;
  depth: number;
  state: "run" | "idle" | "done" | "err";
  runtime: string;   // "02:14" | "--:--"
  sub: string;       // current action / goal
}
export interface ChatMsg { from: string; text: string; system?: boolean }
export interface LogRow { time: string; agent: string; kind: string; summary: string }
export interface TodoRow { state: "done" | "run" | "todo"; text: string }

export interface TuiSnapshot {
  goal: string;
  model: string;
  webOn: boolean;
  agents: AgentRow[];
  selectedId: string;
  running: string[];
  chat: ChatMsg[];
  logs: LogRow[];
  todos: TodoRow[];
  planCurrentIdx: number;        // 0-based index of the "run" todo
  input: string;
  pendingApproval: { agent: string; tool: string; detail: string } | null;
}

// ── Box primitives — every returned line is exactly `cols` wide ───────────────

function topBorder(title: string, cols: number): string {
  const label = ` ${title} `;
  const rest = cols - 2 - displayWidth(label);
  return "┌" + label + "─".repeat(Math.max(0, rest)) + "┐";
}
function midBorder(title: string, cols: number): string {
  if (!title) return "├" + "─".repeat(cols - 2) + "┤";
  const label = `─ ${title} `;
  const rest = cols - 2 - displayWidth(label);
  return "├" + label + "─".repeat(Math.max(0, rest)) + "┤";
}
function bottomBorder(cols: number): string {
  return "└" + "─".repeat(cols - 2) + "┘";
}
/** Content row: "│ " + content + " │", padded to exactly cols. */
function row(inner: string, cols: number): string {
  return "│ " + padToWidth(inner, cols - 4) + " │";
}
function blank(cols: number): string {
  return row("", cols);
}

const STATE_DOT: Record<AgentRow["state"], string> = {
  run: "●", idle: "○", done: "○", err: "✗",
};

// ── Sections ──────────────────────────────────────────────────────────────────

function agentTreeLines(s: TuiSnapshot, cols: number): string[] {
  return s.agents.map((a) => {
    const indent = a.depth > 0 ? "  ".repeat(a.depth - 1) + "├─ " : "";
    const dot = STATE_DOT[a.state];
    const sel = a.id === s.selectedId ? "▸" : " ";
    const head = `${sel} ${indent}${dot} ${a.id}`;
    const headCol = padToWidth(head, 30);
    const st = padToWidth(a.state, 9);
    const rt = padToWidth(a.runtime, 7);
    return row(`${headCol}${st}${rt}${truncateToWidth(a.sub, cols - 4 - 30 - 9 - 7)}`, cols);
  });
}

function chatLines(s: TuiSnapshot, cols: number): string[] {
  const out: string[] = [];
  for (const m of s.chat) {
    out.push(row(m.system ? `· ${m.text}` : m.from, cols));
    if (!m.system) {
      for (const w of wrapToWidth(m.text, cols - 4)) out.push(row(w, cols));
    }
    out.push(blank(cols));
  }
  return out;
}

function logLines(s: TuiSnapshot, cols: number): string[] {
  return s.logs.map((l) =>
    row(`${padToWidth(l.time, 9)}${padToWidth(l.agent, 8)}${padToWidth(l.kind, 12)}${l.summary}`, cols));
}

function planLines(s: TuiSnapshot, level: ViewState["planLevel"], cols: number): string[] {
  const total = s.todos.length;
  const cur = s.todos[s.planCurrentIdx]?.text ?? "(无)";
  if (level === 0) {
    return [midBorder("Progress", cols), row(`[${s.planCurrentIdx + 1}/${total}] current: ${cur}`, cols)];
  }
  if (level === 1) {
    const next = s.todos.slice(s.planCurrentIdx + 1).map((t) => t.text).slice(0, 2).join(" · ");
    return [
      midBorder("Plan", cols),
      row(`[${s.planCurrentIdx + 1}/${total}] → ${cur}`, cols),
      row(`next: ${next || "(无)"}`, cols),
    ];
  }
  // full
  const mark = { done: "✓", run: "→", todo: "·" } as const;
  const filled = Math.round((s.planCurrentIdx / Math.max(1, total)) * 12);
  const bar = "■".repeat(filled) + "□".repeat(12 - filled);
  return [
    midBorder("Plan", cols),
    row(`[${s.planCurrentIdx + 1}/${total}] ${bar}`, cols),
    blank(cols),
    ...s.todos.map((t) => row(`  ${mark[t.state]} ${t.text}`, cols)),
  ];
}

function statusBar(s: TuiSnapshot, view: ViewState, cols: number): string[] {
  const running = `Running ${s.running.join(" · ")}`;
  const hints = view.mode === "home" ? "Enter open   Tab next   Esc home"
    : view.mode === "logs" ? "Ctrl+L chat/logs   Esc home"
    : "Ctrl+T plan   Ctrl+L logs   Esc home";
  return [midBorder("", cols), row(`${padToWidth(running, cols - 4 - displayWidth(hints) - 2)}  ${hints}`, cols)];
}

function approvalOverlay(s: TuiSnapshot, cols: number): string[] {
  const a = s.pendingApproval!;
  return [
    midBorder("⚠ Approval", cols),
    row(`${a.agent} → ${a.tool}`, cols),
    row(truncateToWidth(a.detail, cols - 4), cols),
    row("y approve    n reject", cols),
  ];
}

// ── Frame ─────────────────────────────────────────────────────────────────────

export function renderFrame(s: TuiSnapshot, view: ViewState, cols: number): string[] {
  const title = view.mode === "home" ? "Spawn"
    : view.mode === "logs" ? "Spawn / Logs"
    : `Spawn / ${s.selectedId}`;
  const meta = view.mode === "logs" ? "events · live" : `${s.model} · web: ${s.webOn ? "on" : "off"}`;
  const out: string[] = [];
  out.push(topBorder(title, cols));
  out.push(row(`${padToWidth("Goal  " + s.goal, cols - 4 - displayWidth(meta) - 2)}  ${meta}`, cols));

  // Main pane
  out.push(midBorder(view.mode === "home" ? "Agents" : view.mode === "logs" ? "" : "", cols));
  const body = view.mode === "home" ? agentTreeLines(s, cols)
    : view.mode === "logs" ? logLines(s, cols)
    : chatLines(s, cols);
  out.push(...body);

  // Plan layer (not shown in logs to keep it full-height; matches mockups keeping it in home/chat)
  if (view.mode !== "logs") out.push(...planLines(s, view.planLevel, cols));

  // Approval overlay takes priority above input
  if (s.pendingApproval) out.push(...approvalOverlay(s, cols));

  // Input + status
  out.push(midBorder("Input", cols));
  out.push(row(`> ${s.input}`, cols));
  out.push(...statusBar(s, view, cols));
  out.push(bottomBorder(cols));
  return out;
}
