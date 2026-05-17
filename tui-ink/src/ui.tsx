// V1 三栏 inbox 的 Ink 移植。
// agents | conversation (+todo sidebar) | input + status bar
// 配色:paper 主题用 Ink 默认终端色;状态点用文字字形。

import React, { createContext, useContext } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useStore, approve, reject, switchSession, CONV_PAGE } from "./store.js";
import type {
  AgentInfo, Message, TodoItem, AgentRunState,
} from "./protocol.js";
import type { PaletteName } from "./config.js";

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
export function VDivider() {
  const rows = typeof process !== "undefined" ? (process.stdout.rows ?? 24) : 24;
  return (
    <Box flexDirection="column" width={1} flexShrink={0}>
      {Array.from({ length: rows }, (_, i) => <Text key={i} dimColor>│</Text>)}
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
      <Box flexDirection="column" paddingX={1}>
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

// ── 中栏:conversation ──────────────────────────────────────────────────────
export function ConvPane({ scrollOffset = 0 }: { scrollOffset?: number }) {
  const p = usePalette();
  const sel = useStore((s) => s.selectedAgent);
  const a = useStore((s) => s.agents.get(s.selectedAgent));
  const messages = useStore((s) => s.messagesByAgent.get(s.selectedAgent) ?? []);
  const step = useStore((s) => s.stepByAgent.get(s.selectedAgent));
  const pending = useStore((s) => s.pendingApprovals.filter((p) => p.agent === s.selectedAgent));
  const minLevel = useStore((s) => s.minLevel);

  // Use terminal height to show as many messages as possible; fall back to CONV_PAGE
  const termRows = typeof process !== "undefined" ? (process.stdout.rows ?? 24) : 24;
  const PAGE = Math.max(CONV_PAGE, termRows - 8);
  const end     = Math.max(0, messages.length - scrollOffset);
  const start   = Math.max(0, end - PAGE);
  const LEVEL_RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const visible = messages.slice(start, end).filter((m) =>
    (LEVEL_RANK[m.level ?? "info"] ?? 1) >= (LEVEL_RANK[minLevel] ?? 1)
  );

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text color={p.accent}>◆ </Text>
          <Text bold>{a?.name ?? sel}</Text>
          <Text dimColor> · {a?.role ?? "?"} · {a?.model ?? "?"}</Text>
        </Box>
        <Text dimColor> [P][F][C]</Text>
      </Box>

      <Box flexDirection="column" marginTop={1} flexGrow={1}>
        {/* spacer pushes messages to bottom of available space */}
        <Box flexGrow={1} />
        {start > 0 && (
          <Text dimColor>↑ {start} older (scroll up)</Text>
        )}
        {visible.length === 0 && (
          <Text dimColor italic>no messages yet · type below to start</Text>
        )}
        {visible.map((m) => <Bubble key={m.id} m={m} />)}

        {/* 流式内联气泡：agent 运行中时显示，TTFT 阶段也显示 */}
        {a?.state === "run" && scrollOffset === 0 && (
          <Box flexDirection="column" marginBottom={1} width="100%">
            <Text color={p.dim} bold>◆ {a?.name ?? sel}</Text>
            <Box marginLeft={2} flexShrink={1}>
              <Text dimColor wrap="wrap">{step || "generating…"}</Text>
              <Text color={p.accent}> ◐</Text>
            </Box>
          </Box>
        )}

        {scrollOffset > 0 && (
          <Text dimColor>↓ newer (scroll down)</Text>
        )}
      </Box>

      {/* 待审批 */}
      {pending.length > 0 && <ApprovalCard m={pending[0]!} />}
    </Box>
  );
}

// ── Lightweight markdown renderer ────────────────────────────────────────────
// Supports: ### h3 / ## h2 / # h1, ```code blocks```, **bold**, `inline code`,
// --- hr, blank lines. Everything else renders as plain wrapped text.

type MdKind = "h1" | "h2" | "h3" | "code" | "hr" | "empty" | "text";
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
  return (
    <Box flexDirection="row">
      {toks.map((tok, i) => (
        <Text key={i} bold={tok.bold} color={tok.code ? codeColor : undefined} wrap="wrap">
          {tok.text}
        </Text>
      ))}
    </Box>
  );
}

function MdBody({ text, p }: { text: string; p: Palette }) {
  const segs = parseMd(text.length > 6000 ? text.slice(0, 5997) + "…" : text);
  return (
    <Box flexDirection="column">
      {segs.map((seg, i) => {
        switch (seg.kind) {
          case "h1":    return <Text key={i} bold color={p.accent}>{seg.text}</Text>;
          case "h2":    return <Text key={i} bold color={p.accent}>{seg.text}</Text>;
          case "h3":    return <Text key={i} bold color={p.warn}>{seg.text}</Text>;
          case "code":  return <Text key={i} color={p.dim}>{seg.text}</Text>;
          case "hr":    return <Text key={i} dimColor>{"─".repeat(40)}</Text>;
          case "empty": return <Text key={i}>{" "}</Text>;
          default:      return <MdLine key={i} text={seg.text} dimColor={p.dim} />;
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
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box>
        <Text color={p.accent}>● </Text><Text dimColor>{running} running  </Text>
        <Text dimColor>◯ {idle} idle  </Text>
        {waiting > 0 && <Text color="yellow">⌛ {waiting} waiting  </Text>}
        <Text dimColor>$ {cost.toFixed(2)}</Text>
        {demo && <Text color="yellow" bold> [DEMO] </Text>}
      </Box>
      <Box>
        <Text dimColor>log:{minLevel}  </Text>
        <Text dimColor>tab cycle · enter send · [/] scroll · y/n approve · q quit</Text>
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
