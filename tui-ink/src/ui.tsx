// V1 三栏 inbox 的 Ink 移植。
// agents | conversation (+todo sidebar) | input + status bar
// 配色:paper 主题用 Ink 默认终端色;状态点用文字字形。

import React, { createContext, useContext, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { useStore, approve, reject, switchSession } from "./store.js";
import type {
  AgentInfo, Message, TodoItem, AgentRunState,
} from "./protocol.js";
import type { PaletteName } from "./config.js";

// ── Layout debug logger ──────────────────────────────────────────────────────
// Writes to OS temp dir so it never touches the project or TUI output.
// Tail it with: tail -f <path printed on startup>
const LAYOUT_LOG = path.join(os.tmpdir(), "tui-layout-debug.log");
let _layoutLogPrinted = false;

function layoutLog(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LAYOUT_LOG, line); } catch { /* non-fatal */ }
  if (!_layoutLogPrinted) {
    _layoutLogPrinted = true;
    // Print once to stderr (visible before TUI takes over)
    process.stderr.write(`[layout-debug] logging to ${LAYOUT_LOG}\n`);
  }
}

// FIXED_COLS = AgentsPane(22) + VDiv(1) + VDiv(1) + TodoPane(32) = 56
const FIXED_COLS = 56;
// CONV_OVERHEAD = paddingLeft(1) + scrollbar(1) + spare(1)
const CONV_OVERHEAD = 3;

function checkLayout(termCols: number, contentCols: number) {
  const expectedContent = termCols - FIXED_COLS - CONV_OVERHEAD;
  const clamped = contentCols < expectedContent; // hit Math.max(20,...) floor
  const overflow = termCols < FIXED_COLS + 20;   // terminal too narrow for layout
  if (clamped || overflow || contentCols !== expectedContent) {
    layoutLog(
      `LAYOUT termCols=${termCols} fixedCols=${FIXED_COLS} overhead=${CONV_OVERHEAD} ` +
      `expectedContent=${expectedContent} actualContent=${contentCols}` +
      (clamped  ? " [CLAMPED-AT-FLOOR]" : "") +
      (overflow ? " [TERMINAL-TOO-NARROW]" : ""),
    );
  }
}

// ── 字形 ────────────────────────────────────────────────────────────────────
const STATE_GLYPH: Record<AgentRunState, string> = {
  idle: "·", run: "◐", wait: "◯", done: "✓", warn: "⚠", err: "✗",
};
const TODO_GLYPH: Record<TodoItem["state"], string> = {
  todo: "◯", run: "◐", done: "✓", warn: "⚠", err: "✗",
};

// ── 调色板 ──────────────────────────────────────────────────────────────────
export const PALETTES = {
  paper: {
    accent:  "#0074d9",
    success: "#2ecc40",
    warn:    "#ff851b",
    error:   "#ff4136",
    dim:     "#888888",
    text:    "#dddddd",
  },
  green: {
    accent:  "#00ff41",
    success: "#00ff41",
    warn:    "#ffff00",
    error:   "#ff0000",
    dim:     "#007700",
    text:    "#00ff41",
  },
  amber: {
    accent:  "#ffb000",
    success: "#ffb000",
    warn:    "#ff8800",
    error:   "#ff0000",
    dim:     "#885500",
    text:    "#ffb000",
  },
} as const;

export type Palette = typeof PALETTES[PaletteName];

export const PaletteContext = createContext<Palette>(PALETTES.paper);
export const usePalette = () => useContext(PaletteContext);

function stateColor(state: AgentRunState, p: Palette): string {
  switch (state) {
    case "run":  return p.accent;
    case "done": return p.success;
    case "warn": return p.warn;
    case "err":  return p.error;
    default:     return p.dim;
  }
}

// ── 头部 titlebar ───────────────────────────────────────────────────────────
function TitleBar({ tabs = ["[Tab]switch", "[P]ause", "[F]ork", "[C]onfig", "[q]uit"] }: { tabs?: string[] }) {
  const p = usePalette();
  const pending = useStore((s) => s.pendingApprovals);
  const first = pending[0];
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}
         justifyContent="space-between">
      <Box>
        <Text dimColor>● ● ● </Text>
        <Text bold>multi-agent · inbox</Text>
        {pending.length > 0 && (
          <Text color={p.warn} bold>
            {"  "}⚠ {first!.agent}: {first!.tool_name ?? "tool"} — y/n approve ({pending.length})
          </Text>
        )}
      </Box>
      <Text dimColor>{tabs.join("  ")}</Text>
    </Box>
  );
}

// ── 垂直分隔线 ────────────────────────────────────────────────────────────────
// Height = terminal rows - 7 fixed rows (TitleBar=3 + InputBar=3 + StatusBar=1).
// Using full `rows` causes overflow that wraps past terminal bottom and
// reappears at TitleBar rows, creating a stray │ next to the title text.
export function VDivider() {
  const rows = typeof process !== "undefined" ? (process.stdout.rows ?? 24) : 24;
  const h = Math.max(1, rows - 7);
  return (
    <Box flexDirection="column" width={1} flexShrink={0}>
      {Array.from({ length: h }, (_, i) => <Text key={i} dimColor>│</Text>)}
    </Box>
  );
}

// ── 左栏:agents 列表 ───────────────────────────────────────────────────────
export function AgentsPane({ width }: { width: number }) {
  const agents = useStore((s) => Array.from(s.agents.values()));
  const sel = useStore((s) => s.selectedAgent);

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Box paddingX={1} paddingY={0}>
        <Text dimColor>AGENTS </Text><Text dimColor>{agents.length}</Text>
      </Box>
      <Box flexDirection="column" paddingX={1} overflowY="hidden" height={24}>
        {agents.length === 0 && (
          <Text dimColor italic>(none yet — press enter to spawn leader)</Text>
        )}
        {agents.map((a) => (
          <AgentRow key={a.id} a={a} selected={a.id === sel} />
        ))}
      </Box>
    </Box>
  );
}

function AgentRow({ a, selected }: { a: AgentInfo; selected: boolean }) {
  const p = usePalette();
  const depth = a.depth ?? (a.parent ? 1 : 0);
  const indent = depth > 0 ? "  ".repeat(depth) + "└" : "";
  const marginLeft = depth > 0 ? depth * 2 + 2 : 3;
  const color = stateColor(a.state, p);
  const step = useStore((s) => s.stepByAgent.get(a.id));
  const todos = useStore((s) => s.todosByAgent.get(a.id) ?? []);
  const todoDone = todos.filter((t) => t.state === "done").length;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={selected ? p.accent : undefined}>{selected ? "▎" : " "}</Text>
        <Text dimColor>{indent}</Text>
        <Text color={color}>{STATE_GLYPH[a.state]} </Text>
        <Text bold={selected}>{truncate(a.name, 14)}</Text>
        <Text dimColor> {a.role[0]}</Text>
      </Box>
      {a.sub && (
        <Box marginLeft={marginLeft}>
          <Text dimColor wrap="truncate-end">{a.sub}</Text>
        </Box>
      )}
      {a.model && (
        <Box marginLeft={marginLeft}>
          <Text dimColor wrap="truncate-end">{a.model}</Text>
        </Box>
      )}
      {a.state === "run" && step && (
        <Box marginLeft={marginLeft}>
          <Text color={p.accent} wrap="truncate-end">› {step}</Text>
        </Box>
      )}
      {todos.length > 0 && (
        <Box marginLeft={marginLeft}>
          <Text dimColor>todo {todoDone}/{todos.length}</Text>
        </Box>
      )}
    </Box>
  );
}

// ── 左二栏:sessions 列表 ──────────────────────────────────────────────────────
export function SessionsPane({ width }: { width: number }) {
  const p = usePalette();
  const sel = useStore((s) => s.selectedAgent);
  const sessions = useStore((s) => s.sessionsByAgent.get(s.selectedAgent) ?? []);
  const currentId = useStore((s) => s.currentSessionByAgent.get(s.selectedAgent));

  return (
    <Box flexDirection="column" width={width} flexShrink={0} borderStyle="single"
         borderColor="gray" borderTop={false} borderLeft={false} borderBottom={false}>
      <Box paddingX={1}>
        <Text dimColor>SESSIONS </Text>
        <Text dimColor>{sessions.length}</Text>
      </Box>
      <Box flexDirection="column" paddingX={1}>
        {sessions.length === 0 && (
          <Text dimColor italic>(none)</Text>
        )}
        {sessions.map((s) => (
          <Box key={s.id} flexDirection="column">
            <Box>
              <Text color={s.id === currentId ? p.accent : undefined}>
                {s.id === currentId ? "▎" : " "}
              </Text>
              <Text bold={s.id === currentId} dimColor={s.id !== currentId}>
                {truncate(s.title, width - 6)}
              </Text>
            </Box>
            <Box marginLeft={2}>
              <Text dimColor>{s.messageCount} msgs</Text>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

// ── Flat line buffer for smooth line-level scrolling ─────────────────────────
// Converts messages → RenderLine[]. scrollOffset is a LINE index, not a message
// index, giving true terminal-like continuous scrolling (content slides, not jumps).

interface RenderLine {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

const MD_INLINE = /\*\*(.+?)\*\*|`([^`]+)`/g;
function stripInline(s: string): string {
  return s.replace(MD_INLINE, (_, b, c) => b ?? c ?? "");
}

// Terminal display width: CJK / fullwidth / emoji chars occupy 2 columns.
function charWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115F) ||  // Hangul Jamo
    (cp >= 0x2E80 && cp <= 0x303E) ||  // CJK Radicals + Kangxi
    (cp >= 0x3040 && cp <= 0x33FF) ||  // Kana, Bopomofo, CJK compat
    (cp >= 0x3400 && cp <= 0x9FFF) ||  // CJK Ext-A + Unified
    (cp >= 0xA000 && cp <= 0xA4CF) ||  // Yi
    (cp >= 0xAC00 && cp <= 0xD7AF) ||  // Hangul Syllables
    (cp >= 0xF900 && cp <= 0xFAFF) ||  // CJK Compatibility Ideographs
    (cp >= 0xFE10 && cp <= 0xFE6F) ||  // Vertical/CJK compat forms
    (cp >= 0xFF00 && cp <= 0xFF60) ||  // Fullwidth Latin/punctuation
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||  // Fullwidth Signs
    (cp >= 0x1F300 && cp <= 0x1FAFF)   // Emoji block
  ) return 2;
  return cp >= 0x20 ? 1 : 0;           // control chars → 0
}

function displayWidth(s: string): number {
  let w = 0;
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i) ?? 0;
    w += charWidth(cp);
    i += cp > 0xFFFF ? 2 : 1; // surrogate pair = 2 JS chars
  }
  return w;
}

function wrapAt(text: string, cols: number): string[] {
  if (!text) return [""];
  if (displayWidth(text) <= cols) return [text];
  const out: string[] = [];
  let rem = text;
  while (displayWidth(rem) > cols) {
    // Walk character by character tracking display columns
    let w = 0;
    let lastSpace = -1;
    let hardCut = rem.length;
    for (let i = 0; i < rem.length; ) {
      const cp = rem.codePointAt(i) ?? 0;
      const cw = charWidth(cp);
      if (w + cw > cols) { hardCut = i; break; }
      w += cw;
      if (rem[i] === " ") lastSpace = i;
      i += cp > 0xFFFF ? 2 : 1;
    }
    // Prefer word boundary if it's not too far back
    const cut = lastSpace >= Math.floor(hardCut * 0.35) ? lastSpace : hardCut;
    out.push(rem.slice(0, cut).trimEnd());
    rem = rem.slice(cut === lastSpace ? cut + 1 : cut);
  }
  if (rem) out.push(rem);
  return out;
}

function messagesToLines(msgs: Message[], cols: number, p: Palette): RenderLine[] {
  const out: RenderLine[] = [];
  for (const m of msgs) {
    if (m.kind === "tool_call") {
      const arg = truncate(JSON.stringify(m.tool_args ?? {}), 52);
      out.push({ text: `► ${m.tool_name}(${arg})`, color: m.needs_approval ? p.warn : p.dim });
      continue;
    }
    if (m.kind === "tool_result") {
      const preview = m.text.replace(/\n/g, " ").slice(0, 120);
      out.push({ text: `  ${preview}`, dim: true });
      continue;
    }
    if (m.kind === "system") {
      const c = m.level === "error" ? p.error : p.warn;
      for (const raw of m.text.split("\n"))
        for (const l of wrapAt(raw, cols)) out.push({ text: l, color: c });
      out.push({ text: "" });
      continue;
    }
    // Regular text message
    const who = m.agent === "user" ? "▶ you" : `◆ ${m.agent}`;
    const wc  = m.agent === "user" ? p.accent : (m.level === "error" ? p.error : p.text);
    out.push({ text: who, color: wc, bold: true });
    let inCode = false;
    for (const raw of m.text.split("\n")) {
      const t = raw.trimStart();
      if (t.startsWith("```"))  { inCode = !inCode; continue; }
      if (inCode)               { for (const l of wrapAt("  " + raw, cols)) out.push({ text: l, dim: true }); continue; }
      if (t.startsWith("### ")) { for (const l of wrapAt("  " + stripInline(t.slice(4)), cols)) out.push({ text: l, color: p.warn,   bold: true }); continue; }
      if (t.startsWith("## "))  { for (const l of wrapAt("  " + stripInline(t.slice(3)), cols)) out.push({ text: l, color: p.accent, bold: true }); continue; }
      if (t.startsWith("# "))   { for (const l of wrapAt("  " + stripInline(t.slice(2)), cols)) out.push({ text: l, color: p.accent, bold: true }); continue; }
      if (t === "---" || t === "***") { out.push({ text: "  " + "─".repeat(Math.min(32, cols - 4)), dim: true }); continue; }
      if (!t) { out.push({ text: "" }); continue; }
      if (/^\|[\s\-:|]+\|$/.test(t)) continue; // separator row
      for (const l of wrapAt("  " + stripInline(raw), cols)) out.push({ text: l });
    }
    out.push({ text: "" }); // gap between messages
  }
  return out;
}

// ── Scrollbar ────────────────────────────────────────────────────────────────
function ScrollBar({ total, visible, offset }: { total: number; visible: number; offset: number }) {
  const p = usePalette();
  const barH = visible;
  if (barH < 2 || total <= visible) return null;

  const maxOff = total - visible;
  const ratio  = maxOff > 0 ? offset / maxOff : 0; // 0 = newest, 1 = oldest
  const thumbSize = Math.max(1, Math.round((visible / total) * barH));
  // thumb moves from bottom (ratio=0/newest) to top (ratio=1/oldest)
  const thumbTop  = Math.round(ratio * (barH - thumbSize));

  const rows: string[] = [];
  for (let i = 0; i < barH; i++) {
    rows.push(i >= thumbTop && i < thumbTop + thumbSize ? "█" : "│");
  }

  return (
    <Box flexDirection="column" width={1}>
      {rows.map((ch, i) => (
        <Text key={i} color={ch === "█" ? p.accent : p.dim}>{ch}</Text>
      ))}
    </Box>
  );
}

// ── 中栏:conversation ──────────────────────────────────────────────────────
export function ConvPane({ scrollOffset = 0 }: { scrollOffset?: number }) {
  const p = usePalette();
  const sel = useStore((s) => s.selectedAgent);
  const a = useStore((s) => s.agents.get(s.selectedAgent));
  const messages = useStore((s) => s.messagesByAgent.get(s.selectedAgent) ?? []);
  const step = useStore((s) => s.stepByAgent.get(s.selectedAgent));
  const pending = useStore((s) => s.pendingApprovals.filter((pa) => pa.agent === s.selectedAgent));
  const minLevel = useStore((s) => s.minLevel);

  const termRows = typeof process !== "undefined" ? (process.stdout.rows ?? 24) : 24;
  const termCols = typeof process !== "undefined" ? (process.stdout.columns ?? 80) : 80;
  const pendingRows = pending.length > 0 ? 5 : 0;
  // rows available for message content (total - TitleBar3 - InputBar3 - StatusBar1 - header2 - marginTop1)
  const availRows = Math.max(4, termRows - 10 - pendingRows);
  // Responsive sidebar widths (must match index.tsx breakpoints exactly)
  const agW = termCols >= 120 ? 22 : termCols >= 90 ? 18 : 14;
  const toW = termCols >= 120 ? 32 : termCols >= 90 ? 24 : 18;
  // content cols: termCols minus actual sidebar widths + dividers + CONV_OVERHEAD
  const contentCols = Math.max(20, termCols - (agW + 1 + 1 + toW + CONV_OVERHEAD));

  // Layout invariant check — logs to LAYOUT_LOG on every render where something is off
  const prevLayout = useRef({ termCols: -1, contentCols: -1 });
  if (prevLayout.current.termCols !== termCols || prevLayout.current.contentCols !== contentCols) {
    prevLayout.current = { termCols, contentCols };
    checkLayout(termCols, contentCols);
  }

  const LEVEL_RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const filtered = messages.filter((m) =>
    (LEVEL_RANK[m.level ?? "info"] ?? 1) >= (LEVEL_RANK[minLevel] ?? 1)
  );

  // Flatten all messages into individual display lines
  const msgLines = messagesToLines(filtered, contentCols, p);

  // Append live streaming indicator when agent is generating
  const liveLines: RenderLine[] = (a?.state === "run" && scrollOffset === 0) ? [
    { text: `◆ ${a?.name ?? sel}`, color: p.dim, bold: true },
    { text: `  ${step || "generating…"} ◐`, dim: true },
  ] : [];

  const allLines = [...msgLines, ...liveLines];
  const total    = allLines.length;

  // Clamp offset: can't scroll past start of content
  const maxOff = Math.max(0, total - availRows);
  const off     = Math.min(scrollOffset, maxOff);

  // Slice the visible window (newest content at bottom)
  const winEnd   = Math.max(0, total - off);
  const winStart = Math.max(0, winEnd - availRows);
  const visible  = allLines.slice(winStart, winEnd);

  return (
    <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text color={p.accent}>◆ </Text>
          <Text bold>{a?.name ?? sel}</Text>
          <Text dimColor> · {a?.role ?? "?"} · {a?.model ?? "?"}</Text>
        </Box>
        <Text dimColor> [P][F][C]</Text>
      </Box>

      <Box flexDirection="row" marginTop={1} flexGrow={1}>
        {/* message content */}
        <Box flexDirection="column" flexGrow={1}>
          <Box flexGrow={1} />

          {winStart > 0 && (
            <Text dimColor>↑ {winStart} lines above</Text>
          )}
          {total === 0 && (
            <Text dimColor italic>no messages yet · type below to start</Text>
          )}

          {visible.map((line, i) => (
            <Text key={i} bold={line.bold ?? false} color={line.color} dimColor={line.dim ?? false}>
              {line.text || " "}
            </Text>
          ))}

          {off > 0 && (
            <Text dimColor>↓ {off} lines below</Text>
          )}
        </Box>

        {/* scrollbar */}
        <ScrollBar total={total} visible={availRows} offset={off} />
      </Box>

      {pending.length > 0 && <ApprovalCard m={pending[0]!} />}
    </Box>
  );
}

// ── Lightweight markdown renderer ────────────────────────────────────────────
// Supports: ### h3 / ## h2 / # h1, ```code blocks```, **bold**, `inline code`,
// --- hr, blank lines. Everything else renders as plain wrapped text.

type MdKind = "h1" | "h2" | "h3" | "code" | "hr" | "empty" | "table_row" | "text";
interface MdSeg { kind: MdKind; text: string }

function parseMd(raw: string): MdSeg[] {
  const segs: MdSeg[] = [];
  let inCode = false;
  for (const line of raw.split("\n")) {
    const t = line.trimStart();
    if (t.startsWith("```")) { inCode = !inCode; continue; }
    if (inCode)              { segs.push({ kind: "code",  text: line }); continue; }
    if (t.startsWith("### "))   { segs.push({ kind: "h3", text: t.slice(4) }); continue; }
    if (t.startsWith("## "))    { segs.push({ kind: "h2", text: t.slice(3) }); continue; }
    if (t.startsWith("# "))     { segs.push({ kind: "h1", text: t.slice(2) }); continue; }
    if (t === "---" || t === "***") { segs.push({ kind: "hr",    text: "" }); continue; }
    if (!t)                     { segs.push({ kind: "empty", text: "" }); continue; }
    // Table separator |---|---| → skip (no visual noise)
    if (/^\|[\s\-:|]+\|$/.test(t)) continue;
    // Table data row | cell | cell | → dim styled
    if (t.startsWith("|") && t.endsWith("|")) {
      segs.push({ kind: "table_row", text: t }); continue;
    }
    segs.push({ kind: "text", text: line });
  }
  return segs;
}

interface InlineTok { bold: boolean; code: boolean; text: string }

function parseInline(line: string): InlineTok[] {
  const toks: InlineTok[] = [];
  let s = line;
  while (s) {
    const b = s.indexOf("**");
    const c = s.indexOf("`");
    const first = b === -1 ? c : c === -1 ? b : Math.min(b, c);
    if (first === -1) { toks.push({ bold: false, code: false, text: s }); break; }
    if (first > 0) { toks.push({ bold: false, code: false, text: s.slice(0, first) }); s = s.slice(first); continue; }
    if (s.startsWith("**")) {
      const e = s.indexOf("**", 2);
      if (e === -1) { toks.push({ bold: false, code: false, text: s }); break; }
      toks.push({ bold: true, code: false, text: s.slice(2, e) });
      s = s.slice(e + 2);
    } else {
      const e = s.indexOf("`", 1);
      if (e === -1) { toks.push({ bold: false, code: false, text: s }); break; }
      toks.push({ bold: false, code: true, text: s.slice(1, e) });
      s = s.slice(e + 1);
    }
  }
  return toks;
}

function MdLine({ text, dimColor: codeColor }: { text: string; dimColor: string }) {
  const toks = parseInline(text);
  if (toks.length === 1 && !toks[0]!.bold && !toks[0]!.code) {
    return <Text wrap="wrap">{text}</Text>;
  }
  // Use nested Text (not Box row) so the entire line wraps as one unit
  return (
    <Text wrap="wrap">
      {toks.map((tok, i) => (
        <Text key={i} bold={tok.bold} color={tok.code ? codeColor : undefined}>
          {tok.text}
        </Text>
      ))}
    </Text>
  );
}

function MdBody({ text, p }: { text: string; p: Palette }) {
  const segs = parseMd(text.length > 6000 ? text.slice(0, 5997) + "…" : text);
  return (
    <Box flexDirection="column">
      {segs.map((seg, i) => {
        switch (seg.kind) {
          case "h1":        return <Text key={i} bold color={p.accent} wrap="wrap">{seg.text}</Text>;
          case "h2":        return <Text key={i} bold color={p.accent} wrap="wrap">{seg.text}</Text>;
          case "h3":        return <Text key={i} bold color={p.warn}   wrap="wrap">{seg.text}</Text>;
          case "code":      return <Text key={i} color={p.dim}         wrap="wrap">{seg.text}</Text>;
          case "hr":        return <Text key={i} dimColor>{"─".repeat(32)}</Text>;
          case "empty":     return <Text key={i}>{" "}</Text>;
          case "table_row": return <Text key={i} color={p.dim} wrap="wrap">{seg.text}</Text>;
          default:          return <MdLine key={i} text={seg.text} dimColor={p.dim} />;
        }
      })}
    </Box>
  );
}

function Bubble({ m }: { m: Message }) {
  const p = usePalette();
  const level = m.level ?? "info";
  const errColor = level === "error" ? p.error : p.warn;

  if (m.kind === "tool_call") {
    return (
      <Box marginBottom={0}>
        <Text dimColor>► </Text>
        <Text color={errColor}>{m.tool_name}</Text>
        <Text dimColor>({truncate(JSON.stringify(m.tool_args ?? {}), 60)})</Text>
        {m.needs_approval && !m.approved && (
          <Text color={errColor}> · needs approval</Text>
        )}
      </Box>
    );
  }
  if (m.kind === "tool_result") {
    return (
      <Box marginBottom={0}>
        <Text dimColor>  {truncate(m.text, 80)}</Text>
      </Box>
    );
  }
  if (m.kind === "system") {
    const sysLines = m.text.split("\n");
    return (
      <Box flexDirection="column">
        {sysLines.map((l, i) => <Text key={i} color={errColor} wrap="wrap">{l}</Text>)}
      </Box>
    );
  }
  const who = m.agent === "user" ? "▶ you" : `◆ ${m.agent}`;
  const whoColor = m.agent === "user" ? p.accent : (level === "error" ? p.error : p.text);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={whoColor} bold>{who}</Text>
      <Box marginLeft={2}><MdBody text={m.text} p={p} /></Box>
    </Box>
  );
}

function ApprovalCard({ m }: { m: Message }) {
  const p = usePalette();
  return (
    <Box borderStyle="single" borderColor={p.warn} paddingX={1} flexDirection="column"
         marginTop={1}>
      <Text color={p.warn} bold>⚠ approve tool call</Text>
      <Box>
        <Text>{m.tool_name}</Text>
        <Text dimColor>({truncate(JSON.stringify(m.tool_args ?? {}), 80)})</Text>
      </Box>
      <Text dimColor>
        press <Text color={p.success}>y</Text> approve · <Text color={p.error}>n</Text> reject
      </Text>
    </Box>
  );
}

// ── 右栏:todo + step ──────────────────────────────────────────────────────
export function TodoPane({ width }: { width: number }) {
  const sel = useStore((s) => s.selectedAgent);
  const todos = useStore((s) => s.todosByAgent.get(s.selectedAgent) ?? []);
  const done = todos.filter((t) => t.state === "done").length;

  return (
    <Box flexDirection="column" width={width} flexShrink={0} paddingLeft={1} paddingRight={1}>
      <Box justifyContent="space-between">
        <Text dimColor>TODO · {sel}</Text>
        <Text dimColor>{done}/{todos.length}</Text>
      </Box>
      {todos.length === 0 && (
        <Text dimColor italic>(empty)</Text>
      )}
      <Box flexDirection="column" marginTop={1}>
        {todos.map((t) => <TodoRow key={t.id} t={t} />)}
      </Box>
    </Box>
  );
}

function TodoRow({ t }: { t: TodoItem }) {
  const p = usePalette();
  const color = t.state === "done" ? p.success : t.state === "run" ? p.accent :
                t.state === "warn" ? p.warn : t.state === "err" ? p.error : undefined;
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        <Text color={color}>{TODO_GLYPH[t.state]} </Text>
        <Text dimColor={t.state === "done"}>{truncate(t.text, 20)}</Text>
      </Box>
      {t.state === "run" && t.progress != null && (
        <Box marginLeft={2}><ProgressBar pct={t.progress} accent={p.accent} /></Box>
      )}
    </Box>
  );
}

function ProgressBar({ pct, width = 16, accent }: { pct: number; width?: number; accent: string }) {
  const n = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return (
    <Text dimColor>
      <Text color={accent}>{"█".repeat(n)}</Text>
      {"░".repeat(width - n)} {pct}%
    </Text>
  );
}

// ── 底部 status bar ─────────────────────────────────────────────────────────
export function StatusBar({ demo }: { demo?: boolean }) {
  const p = usePalette();
  const agents = useStore((s) => Array.from(s.agents.values()));
  const running = agents.filter((a) => a.state === "run").length;
  const waiting = agents.filter((a) => a.state === "wait").length;
  const idle    = agents.filter((a) => a.state === "idle").length;
  const cost = useStore((s) => s.cost_usd);
  const minLevel = useStore((s) => s.minLevel);
  const termCols = typeof process !== "undefined" ? (process.stdout.columns ?? 80) : 80;
  const termRows = typeof process !== "undefined" ? (process.stdout.rows ?? 24) : 24;
  const contentCols = Math.max(20, termCols - (FIXED_COLS + CONV_OVERHEAD));
  const isDebug = minLevel === "debug";
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box>
        <Text color={p.accent}>● </Text><Text dimColor>{running} running  </Text>
        <Text dimColor>◯ {idle} idle  </Text>
        {waiting > 0 && <Text color="yellow">⌛ {waiting} waiting  </Text>}
        <Text dimColor>$ {cost.toFixed(2)}</Text>
        {demo && <Text color="yellow" bold> [DEMO] </Text>}
        {isDebug && (
          <Text color={contentCols <= 20 ? "red" : p.dim}>
            {" "}cols={termCols}×{termRows} cont={contentCols}
          </Text>
        )}
      </Box>
      <Box>
        <Text dimColor>log:{minLevel}  </Text>
        <Text dimColor>tab cycle · enter send · [ up  ] dn · y/n approve · q quit</Text>
      </Box>
    </Box>
  );
}

// ── V3: DAG 拓扑 mini-map ────────────────────────────────────────────────────
export function DagView({ maxHeight = 12 }: { maxHeight?: number }) {
  const p = usePalette();
  const agents = useStore((s) => Array.from(s.agents.values()));

  const childrenOf = new Map<string | undefined, AgentInfo[]>();
  for (const a of agents) {
    const key = a.parent;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(a);
  }

  const layers: AgentInfo[][] = [];
  let current = childrenOf.get(undefined) ?? [];
  while (current.length > 0 && layers.length * 2 < maxHeight) {
    layers.push(current);
    const next = current.flatMap((a) => childrenOf.get(a.id) ?? []);
    current = next;
  }

  if (layers.length === 0) {
    return (
      <Box>
        <Text dimColor>(no agents — type a message to spawn leader)</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {layers.map((layer, li) => (
        <Box key={li} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-around">
            {layer.map((a) => (
              <Box key={a.id}>
                <Text color={stateColor(a.state, p)}>{STATE_GLYPH[a.state]} </Text>
                <Text bold>{a.name}</Text>
                <Text dimColor> {a.role[0]}</Text>
              </Box>
            ))}
          </Box>
          {li < layers.length - 1 && (
            <Box flexDirection="row" justifyContent="space-around">
              {layer.map((a) => (
                <Text key={a.id} dimColor>│</Text>
              ))}
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
}

// ── 输入栏 ──────────────────────────────────────────────────────────────────
export function InputBar({
  value, onChange, onSubmit, hint, focused = true,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  hint?: string;
  focused?: boolean;
}) {
  const p = usePalette();
  return (
    <Box borderStyle="single" borderColor="gray" borderLeft={false} borderRight={false}
         paddingX={1}>
      <Text color={p.accent}>› </Text>
      {focused ? (
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={hint ?? "type a message · @agent to switch · /command"}
        />
      ) : (
        <Text dimColor>{hint ?? "y approve · n reject"}</Text>
      )}
    </Box>
  );
}

// ── utils ──────────────────────────────────────────────────────────────────
function truncate(s: string, n: number): string {
  if (!s) return "";
  const flat = s.replace(/\s+/g, " ");
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

export { TitleBar };
