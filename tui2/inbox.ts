// tui2/inbox.ts — Layer 0: V1 multi-agent inbox with real chat

import { screen } from './engine/screen.js';
import { Renderer } from './engine/renderer.js';
import { Keyboard } from './engine/keyboard.js';
import { paperTheme } from './themes/paper.js';
import { cycleTheme } from './themes/index.js';
import { RGBA, Theme, TextStyle } from './engine/types.js';
import { streamChat, ModelConfig, DEFAULT_CONFIG } from './llm/provider.js';
import { TOOLS, executeTool, ToolCall } from './llm/tools.js';

// ─── Stub interfaces (connect real data here later) ───────────
// TODO: replace with live AgentState from src/agent/
type AgentStatus = 'running' | 'idle' | 'in-progress';
interface MockAgent   { id: string; name: string; status: AgentStatus; badge: string; subtitle: string; }
// TODO: replace with persistent session store
interface MockSession { agentId: string; title: string; unread: number; timeAgo: string; }
// TODO: replace with task tracker from src/tasks/
type TodoState = 'done' | 'active' | 'pending';
interface MockTodo    { agentId: string; text: string; state: TodoState; timeStr?: string; progress?: number; }

// ─── Mock stubs ───────────────────────────────────────────────

const AGENTS: MockAgent[] = [
  { id: 'leader',    name: 'leader',    status: 'running',     badge: 'L', subtitle: 'planning · 3 todos' },
  { id: 'secretary', name: 'secretary', status: 'idle',        badge: 'S', subtitle: 'watching inbox'     },
  { id: 'coder-01',  name: 'coder-01',  status: 'in-progress', badge: 'C', subtitle: 'edit src/api.ts'    },
];

const SESSIONS: MockSession[] = [
  { agentId: 'leader',    title: 'redesign login flow',   unread: 0, timeAgo: 'now'    },
  { agentId: 'leader',    title: 'kline ws reconnect',    unread: 0, timeAgo: '8m ago'  },
  { agentId: 'leader',    title: 'agents page wireframe', unread: 0, timeAgo: '1h ago'  },
  { agentId: 'secretary', title: 'settings · theme tok…', unread: 0, timeAgo: '3h ago'  },
  { agentId: 'secretary', title: 'i18n strings sweep',    unread: 0, timeAgo: 'y\'day'  },
];

const TODOS: MockTodo[] = [
  { agentId: 'leader',   text: '读取 docs/login.html',              state: 'done',   timeStr: '0:12'            },
  { agentId: 'leader',   text: '调度 secretary 监控 inbox',          state: 'done',   timeStr: '0:03'            },
  { agentId: 'leader',   text: '生成 3 种 wireframe 候选',            state: 'active', timeStr: '0:42', progress: 65 },
  { agentId: 'leader',   text: '汇总 + 出对比表',                    state: 'pending'                             },
  { agentId: 'coder-01', text: 'git checkout -b login/paper',       state: 'done',   timeStr: '0:01'            },
  { agentId: 'coder-01', text: '重写 LoginForm.tsx',                 state: 'active', timeStr: '1:24', progress: 40 },
  { agentId: 'coder-01', text: '接入 QuoteRail 组件',                state: 'pending'                             },
];

// ─── Real chat types ──────────────────────────────────────────

interface Msg {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  reasoning?: string;
  toolName?: string;
  args?: string;
  result?: string;
}

type HistoryEntry = { role: string; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; name?: string };

// ─── Layout ───────────────────────────────────────────────────

interface Layout {
  W: number; H: number;
  // column x positions and widths (dividers at div1X, div2X, div3X)
  agtX: number; agtW: number; div1X: number;
  sesX: number; sesW: number; div2X: number;
  cvX:  number; cvW:  number; div3X: number;
  tdX:  number; tdW:  number;
  // row positions
  contentY: number; contentH: number;
  sepY: number; inputY: number; hintsY: number; statusY: number;
}

function computeLayout(W: number, H: number): Layout {
  // Column widths — proportional, clamped
  const agtW = clamp(Math.floor(W * 0.14), 14, 20);
  const sesW = clamp(Math.floor(W * 0.20), 18, 28);
  const tdW  = clamp(Math.floor(W * 0.21), 22, 32);
  const cvW  = W - agtW - sesW - tdW - 3; // 3 divider chars

  const div1X = agtW;
  const sesX  = div1X + 1;
  const div2X = sesX + sesW;
  const cvX   = div2X + 1;
  const div3X = cvX + cvW;
  const tdX   = div3X + 1;

  const contentY = 2;
  const contentH = Math.max(4, H - 6); // 2 header + 4 footer
  const sepY     = contentY + contentH;
  const inputY   = sepY + 1;
  const hintsY   = inputY + 1;
  const statusY  = H - 1;

  return { W, H, agtX: 0, agtW, div1X, sesX, sesW, div2X, cvX, cvW, div3X, tdX, tdW, contentY, contentH, sepY, inputY, hintsY, statusY };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ─── App state ────────────────────────────────────────────────

type FocusPane = 'agents' | 'sessions' | 'conv' | 'todo' | 'input';

const SETTINGS_FIELDS: Array<{ key: keyof ModelConfig; label: string; mask: boolean }> = [
  { key: 'apiKey',      label: 'API Key',     mask: true  },
  { key: 'model',       label: 'Model',       mask: false },
  { key: 'baseUrl',     label: 'Base URL',    mask: false },
  { key: 'thinking',    label: 'Thinking',    mask: false },
  { key: 'maxTokens',   label: 'Max Tokens',  mask: false },
  { key: 'temperature', label: 'Temperature', mask: false },
];

interface State {
  theme: Theme;
  focus: FocusPane;
  agentSel: number;
  sessSel: number;
  msgScroll: number;
  autoScroll: boolean;
  input: string;
  cursor: number;
  running: boolean;
  // real chat
  messages: Msg[];
  history: HistoryEntry[];
  config: ModelConfig;
  streaming: boolean;
  // settings overlay
  settingsOpen: boolean;
  settingsField: number;
  settingsValue: string;
}

const state: State = {
  theme: paperTheme,
  focus: 'input',
  agentSel: 0,
  sessSel: 0,
  msgScroll: 9999,
  autoScroll: true,
  input: '',
  cursor: 0,
  running: true,
  messages: [{ role: 'system', content: 'multi-agent inbox · Ctrl+O config · Ctrl+Q quit · Tab switch pane' }],
  history: [],
  config: { ...DEFAULT_CONFIG },
  streaming: false,
  settingsOpen: false,
  settingsField: 0,
  settingsValue: '',
};

// ─── Text helpers ─────────────────────────────────────────────

function st(fg?: RGBA, bg?: RGBA, bold?: boolean, dim?: boolean): TextStyle {
  return { fg, bg, bold: bold ?? false, dim: dim ?? false };
}

// char visual width (CJK = 2)
function cw(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return cp >= 0x1100 && (cp <= 0x115F || (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE10 && cp <= 0xFE1F) || (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6)) ? 2 : 1;
}

function svw(s: string): number { let w = 0; for (const c of s) w += cw(c); return w; }

// truncate to visual width, appending '…'
function vtrim(s: string, maxW: number): string {
  if (svw(s) <= maxW) return s;
  let w = 0, out = '';
  for (const c of s) {
    const cw2 = cw(c);
    if (w + cw2 > maxW - 1) return out + '…';
    out += c; w += cw2;
  }
  return out;
}

// wrap to visual-width lines
function wrapStr(text: string, maxW: number): string[] {
  const lines: string[] = [];
  let cur = '', curW = 0;
  for (const c of text) {
    if (c === '\n') { lines.push(cur); cur = ''; curW = 0; continue; }
    const cw2 = cw(c);
    if (curW + cw2 > maxW) { lines.push(cur); cur = c; curW = cw2; }
    else { cur += c; curW += cw2; }
  }
  lines.push(cur);
  return lines.filter((_, i) => i < lines.length - 1 || lines[i] !== '') || [''];
}

function pbar(pct: number, width: number): string {
  const f = Math.round(clamp(pct, 0, 100) / 100 * width);
  return '█'.repeat(f) + '░'.repeat(Math.max(0, width - f));
}

function statusDot(s: AgentStatus, c: Theme['colors']): [string, RGBA] {
  return s === 'running' ? ['●', c.success] : s === 'in-progress' ? ['◐', c.warning] : ['○', c.muted];
}

function todoIcon(s: TodoState, c: Theme['colors']): [string, RGBA] {
  return s === 'done' ? ['✓', c.muted] : s === 'active' ? ['◐', c.warning] : ['○', c.muted];
}

// ─── Render: Title bar ────────────────────────────────────────

function renderTitle(r: Renderer, lay: Layout, s: State): void {
  const c = s.theme.colors;
  r.draw({ type: 'fill', bounds: { x: 0, y: 0, width: lay.W, height: 1 }, style: { bg: c.surface } });
  r.draw({ type: 'text', x: 1, y: 0, text: '○ ○ ○', style: st(c.muted) });
  r.draw({ type: 'text', x: 8, y: 0, text: 'multi-agent · inbox', style: st(c.foreground, undefined, true) });
  const nav = '^K  AGENTS  LOGS  SETTINGS';
  r.draw({ type: 'text', x: lay.W - nav.length - 1, y: 0, text: nav, style: st(c.muted) });
}

// ─── Render: Column headers ───────────────────────────────────

function renderHeaders(r: Renderer, lay: Layout, s: State): void {
  const c = s.theme.colors;
  const y = 1;
  r.draw({ type: 'fill', bounds: { x: 0, y, width: lay.W, height: 1 }, style: { bg: c.surface } });

  // Agents header
  const aHdr = `AGENTS ${AGENTS.length}`;
  r.draw({ type: 'text', x: lay.agtX + 1, y, text: aHdr, style: st(c.muted, undefined, true) });
  if (lay.agtW >= 16) {
    const newBtn = '+NEW';
    r.draw({ type: 'text', x: lay.div1X - newBtn.length - 1, y, text: newBtn, style: st(c.accent) });
  }

  // Sessions header
  const sHdr = `SESSIONS ${SESSIONS.length}`;
  r.draw({ type: 'text', x: lay.sesX + 1, y, text: sHdr, style: st(c.muted, undefined, true) });
  if (lay.sesW >= 22) {
    r.draw({ type: 'text', x: lay.div2X - 7, y, text: 'FILTER', style: st(c.muted) });
  }

  // Conversation header
  const model = vtrim(s.config.model, lay.cvW - 18);
  const convTitle = s.streaming ? `◐ ${model}` : `◆ ${model}`;
  r.draw({ type: 'text', x: lay.cvX + 1, y, text: convTitle, style: st(s.streaming ? c.warning : c.info, undefined, true) });
  const actions = 'PAUSE  FORK  CONFIG';
  if (lay.cvW > actions.length + 10) {
    r.draw({ type: 'text', x: lay.div3X - actions.length - 1, y, text: actions, style: st(c.muted) });
  }

  // Todo header
  r.draw({ type: 'text', x: lay.tdX + 1, y, text: 'TODO', style: st(c.muted, undefined, true) });

  // Dividers on header row
  r.draw({ type: 'text', x: lay.div1X, y, text: '│', style: st(c.border) });
  r.draw({ type: 'text', x: lay.div2X, y, text: '│', style: st(c.border) });
  r.draw({ type: 'text', x: lay.div3X, y, text: '│', style: st(c.border) });
}

// ─── Render: Column dividers ──────────────────────────────────

function renderDividers(r: Renderer, lay: Layout, s: State): void {
  const c = s.theme.colors;
  for (let y = lay.contentY; y < lay.contentY + lay.contentH; y++) {
    r.draw({ type: 'text', x: lay.div1X, y, text: '│', style: st(c.border) });
    r.draw({ type: 'text', x: lay.div2X, y, text: '│', style: st(c.border) });
    r.draw({ type: 'text', x: lay.div3X, y, text: '│', style: st(c.border) });
  }
  r.draw({ type: 'hline', x: 0, y: lay.sepY, width: lay.W, char: '─', style: st(c.border) });
}

// ─── Render: Agent list ───────────────────────────────────────

function renderAgents(r: Renderer, lay: Layout, s: State): void {
  const c = s.theme.colors;
  const focused = s.focus === 'agents';
  const innerW = lay.agtW - 3; // 1 left margin + 1 badge + 1 right margin

  for (let i = 0; i < AGENTS.length; i++) {
    const a = AGENTS[i];
    const y0 = lay.contentY + i * 3;
    if (y0 + 1 >= lay.contentY + lay.contentH) break;

    const sel = i === s.agentSel;
    if (sel) r.draw({ type: 'fill', bounds: { x: lay.agtX, y: y0, width: lay.agtW, height: 2 }, style: { bg: c.selectionBg } });

    const [dot, dotC] = statusDot(a.status, c);
    const nameC = sel ? c.selectionFg : c.foreground;
    const subC  = sel ? c.selectionFg : c.muted;
    const bg    = sel ? c.selectionBg : undefined;

    // focus indicator
    if (focused && sel) r.draw({ type: 'text', x: lay.agtX, y: y0, text: '▌', style: st(c.accent) });

    // status dot + name
    r.draw({ type: 'text', x: lay.agtX + 1, y: y0,     text: dot,                     style: st(dotC, bg) });
    r.draw({ type: 'text', x: lay.agtX + 3, y: y0,     text: vtrim(a.name, innerW - 2), style: st(nameC, bg, sel) });
    // badge right-aligned inside column (2 chars from divider)
    r.draw({ type: 'text', x: lay.div1X - 2, y: y0,    text: a.badge,                 style: st(sel ? c.selectionFg : c.accent, bg, true) });
    // subtitle
    r.draw({ type: 'text', x: lay.agtX + 3, y: y0 + 1, text: vtrim(a.subtitle, innerW), style: st(subC, bg, false, !sel) });
  }
}

// ─── Render: Session list ─────────────────────────────────────

function renderSessions(r: Renderer, lay: Layout, s: State): void {
  const c = s.theme.colors;
  const focused = s.focus === 'sessions';
  const innerW = lay.sesW - 2;

  for (let i = 0; i < SESSIONS.length; i++) {
    const sess = SESSIONS[i];
    const y0 = lay.contentY + i * 3;
    if (y0 + 1 >= lay.contentY + lay.contentH) break;

    const sel = i === s.sessSel;
    if (sel) r.draw({ type: 'fill', bounds: { x: lay.sesX, y: y0, width: lay.sesW, height: 2 }, style: { bg: c.selectionBg } });

    const hasUnread = sess.unread > 0;
    const ind = hasUnread ? '●' : '○';
    const indC = sel ? c.selectionFg : (hasUnread ? c.accent : c.muted);
    const titleC = sel ? c.selectionFg : c.foreground;
    const timeC  = sel ? c.selectionFg : c.muted;
    const bg     = sel ? c.selectionBg : undefined;

    if (focused && sel) r.draw({ type: 'text', x: lay.sesX, y: y0, text: '▌', style: st(c.accent) });

    // Badge right-aligned (reserve space)
    const badgeStr = sess.unread > 0 ? `[${sess.unread}]` : '';
    const badgeW = badgeStr.length;
    const titleW = innerW - 2 - (badgeW > 0 ? badgeW + 1 : 0);

    r.draw({ type: 'text', x: lay.sesX + 1, y: y0,     text: ind,                      style: st(indC, bg) });
    r.draw({ type: 'text', x: lay.sesX + 3, y: y0,     text: vtrim(sess.title, titleW), style: st(titleC, bg, hasUnread && !sel) });
    if (badgeW > 0)
      r.draw({ type: 'text', x: lay.div2X - badgeW - 1, y: y0, text: badgeStr, style: st(sel ? c.selectionFg : c.accent, bg, true) });
    r.draw({ type: 'text', x: lay.sesX + 3, y: y0 + 1, text: sess.timeAgo,             style: st(timeC, bg, false, true) });
  }
}

// ─── Render: Conversation (real chat) ────────────────────────

function buildConvLines(s: State, convW: number): Array<{ txt: string; style: TextStyle; bg?: RGBA }> {
  const c = s.theme.colors;
  type Line = { txt: string; style: TextStyle; bg?: RGBA };
  const lines: Line[] = [];
  const textW = convW - 3;

  for (const msg of s.messages) {
    if (msg.role === 'system') {
      lines.push({ txt: `· ${vtrim(msg.content, textW - 2)}`, style: st(c.muted, undefined, false, true) });
      continue;
    }
    if (msg.role === 'user') {
      lines.push({ txt: '▶ YOU', style: st(c.accent, undefined, true) });
      for (const ln of wrapStr(msg.content, textW))
        lines.push({ txt: '  ' + ln, style: st(c.foreground) });
      lines.push({ txt: '', style: st(c.muted) });
      continue;
    }
    if (msg.role === 'assistant') {
      lines.push({ txt: '◆ ASSISTANT', style: st(c.info, undefined, true) });
      if (msg.reasoning) {
        for (const ln of wrapStr(msg.reasoning, textW))
          lines.push({ txt: '  ' + ln, style: st(c.muted, undefined, false, true) });
      }
      for (const ln of wrapStr(msg.content, textW))
        lines.push({ txt: '  ' + ln, style: st(c.foreground) });
      lines.push({ txt: '', style: st(c.muted) });
      continue;
    }
    if (msg.role === 'tool') {
      lines.push({ txt: `▶ TOOL · ${msg.toolName ?? ''}`, style: st(c.accentDim) });
      if (msg.args)
        lines.push({ txt: `  args: ${vtrim(msg.args, textW - 8)}`, style: st(c.muted), bg: c.surfaceAlt });
      if (msg.result)
        lines.push({ txt: `  → ${vtrim(msg.result, textW - 4)}`, style: st(c.muted), bg: c.surfaceAlt });
      lines.push({ txt: '', style: st(c.muted) });
      continue;
    }
  }
  return lines;
}

function renderConversation(r: Renderer, lay: Layout, s: State): void {
  const c = s.theme.colors;
  const lines = buildConvLines(s, lay.cvW);

  const maxScroll = Math.max(0, lines.length - lay.contentH);
  const startLine = s.autoScroll ? maxScroll : Math.min(s.msgScroll, maxScroll);

  for (let i = 0; i < lay.contentH; i++) {
    const li = startLine + i;
    if (li >= lines.length) break;
    const ln = lines[li];
    const y = lay.contentY + i;
    if (ln.bg) r.draw({ type: 'fill', bounds: { x: lay.cvX + 1, y, width: lay.cvW - 1, height: 1 }, style: { bg: ln.bg } });
    if (ln.txt) r.draw({ type: 'text', x: lay.cvX + 1, y, text: vtrim(ln.txt, lay.cvW - 2), style: ln.style });
  }

  // Scrollbar
  if (lines.length > lay.contentH) {
    const sbH = Math.max(1, Math.floor(lay.contentH ** 2 / lines.length));
    const sbY = lay.contentY + Math.floor((startLine / Math.max(1, lines.length - lay.contentH)) * (lay.contentH - sbH));
    for (let i = 0; i < sbH && sbY + i < lay.contentY + lay.contentH; i++)
      r.draw({ type: 'text', x: lay.div3X - 1, y: sbY + i, text: '▐', style: st(c.muted) });
  }
}

// ─── Render: Todo sidebar ────────────────────────────────────

function renderTodo(r: Renderer, lay: Layout, s: State): void {
  const c = s.theme.colors;
  const agentIds = [...new Set(TODOS.map(t => t.agentId))];
  let y = lay.contentY;

  for (const aid of agentIds) {
    if (y >= lay.contentY + lay.contentH) break;
    const todos = TODOS.filter(t => t.agentId === aid);
    const done = todos.filter(t => t.state === 'done').length;

    // Section header row
    r.draw({ type: 'fill', bounds: { x: lay.tdX, y, width: lay.tdW, height: 1 }, style: { bg: c.surface } });
    const hdr = `TODO · ${aid.toUpperCase()}`;
    r.draw({ type: 'text', x: lay.tdX + 1, y, text: vtrim(hdr, lay.tdW - 6), style: st(c.muted, c.surface, true) });
    const cnt = `${done}/${todos.length}`;
    r.draw({ type: 'text', x: lay.tdX + lay.tdW - cnt.length - 1, y, text: cnt, style: st(c.accent, c.surface, true) });
    y++;

    for (const todo of todos) {
      if (y >= lay.contentY + lay.contentH) break;
      const [icon, iconC] = todoIcon(todo.state, c);
      const timeW  = todo.timeStr ? todo.timeStr.length + 1 : 0;
      const txtW   = lay.tdW - 4 - timeW;
      const txtC   = todo.state === 'done' ? c.muted : c.foreground;

      r.draw({ type: 'text', x: lay.tdX + 1, y, text: icon, style: st(iconC) });
      r.draw({ type: 'text', x: lay.tdX + 3, y, text: vtrim(todo.text, txtW), style: st(txtC, undefined, false, todo.state === 'done') });
      if (todo.timeStr)
        r.draw({ type: 'text', x: lay.tdX + lay.tdW - todo.timeStr.length - 1, y, text: todo.timeStr, style: st(c.muted) });
      y++;

      if (todo.state === 'active' && todo.progress != null && y < lay.contentY + lay.contentH) {
        const barW = lay.tdW - 4;
        r.draw({ type: 'text', x: lay.tdX + 3, y, text: pbar(todo.progress, barW), style: st(c.accent) });
        y++;
      }
    }
    if (y < lay.contentY + lay.contentH) y++; // spacer
  }
}

// ─── Render: Input + hints ────────────────────────────────────

function renderInput(r: Renderer, lay: Layout, s: State): void {
  const c = s.theme.colors;

  r.draw({ type: 'fill', bounds: { x: 0, y: lay.inputY, width: lay.W, height: 1 }, style: { bg: c.surface } });

  if (!s.input) {
    r.draw({ type: 'text', x: 2, y: lay.inputY,
      text: vtrim('type a message  ·  ^K palette  ·  @ mention agent', lay.W - 4),
      style: st(c.muted, c.surface, false, true) });
  } else {
    r.draw({ type: 'text', x: 1, y: lay.inputY, text: '›', style: st(c.accent) });
    // visible window of input
    const visW = lay.W - 4;
    const visStart = Math.max(0, s.cursor - visW + 1);
    const visInput = s.input.slice(visStart);
    r.draw({ type: 'text', x: 3, y: lay.inputY, text: vtrim(visInput, visW), style: st(c.foreground) });
    // cursor
    const cursorX = 3 + svw(s.input.slice(visStart, s.cursor));
    const cursorCh = s.input[s.cursor] ?? ' ';
    r.draw({ type: 'text', x: cursorX, y: lay.inputY, text: cursorCh, style: st(c.selectionFg, c.selectionBg) });
  }

  // Hints
  r.draw({ type: 'fill', bounds: { x: 0, y: lay.hintsY, width: lay.W, height: 1 }, style: { bg: c.surface } });
  const hints: [string, string][] = [['▌',''], ['Enter','send'], ['S+Enter','newline'], ['^K','cmd'], ['Tab','focus'], ['^T','theme'], ['^O','config'], ['^Q','quit']];
  let hx = 1;
  for (const [key, desc] of hints) {
    if (key === '▌') { r.draw({ type: 'text', x: hx, y: lay.hintsY, text: '▌ ', style: st(c.accent) }); hx += 2; continue; }
    const seg = ` ${key}`;
    r.draw({ type: 'text', x: hx, y: lay.hintsY, text: seg, style: st(c.accent, undefined, true) }); hx += seg.length;
    if (desc) { r.draw({ type: 'text', x: hx, y: lay.hintsY, text: ` ${desc}`, style: st(c.muted, undefined, false, true) }); hx += desc.length + 1; }
    if (hx > lay.W - 12) break;
  }
}

// ─── Render: Status bar ───────────────────────────────────────

function renderStatus(r: Renderer, lay: Layout, s: State): void {
  const c = s.theme.colors;
  r.draw({ type: 'fill', bounds: { x: 0, y: lay.statusY, width: lay.W, height: 1 }, style: { bg: c.surface } });

  let x = 1;
  const put = (txt: string, fg: RGBA, bold = false) => {
    r.draw({ type: 'text', x, y: lay.statusY, text: txt, style: st(fg, undefined, bold) }); x += txt.length;
  };

  const running = AGENTS.filter(a => a.status === 'running' || a.status === 'in-progress').length;
  const waiting = AGENTS.filter(a => a.status === 'idle').length;

  put('●', c.success); put(` ${running} RUNNING  `, c.muted);
  put('○', c.muted);   put(` ${waiting} WAITING  `, c.muted);
  if (s.streaming)     put('● STREAMING  ', c.warning, true);
  put(`MODEL: ${s.config.model}  `, c.muted);

  const focusTxt = `[${s.focus.toUpperCase()}]`;
  r.draw({ type: 'text', x: lay.W - focusTxt.length - 8, y: lay.statusY, text: focusTxt, style: st(c.accentDim) });
  r.draw({ type: 'text', x: lay.W - 7, y: lay.statusY, text: '^? HELP', style: st(c.muted) });
}

// ─── Render: Settings overlay ─────────────────────────────────

function renderSettings(r: Renderer, lay: Layout, s: State): void {
  const c = s.theme.colors;
  const bw = 54, bh = SETTINGS_FIELDS.length + 5;
  const bx = Math.floor((lay.W - bw) / 2);
  const by = Math.floor((lay.H - bh) / 2);

  // dim backdrop
  r.draw({ type: 'fill', bounds: { x: 0, y: 0, width: lay.W, height: lay.H }, style: { bg: { r: 0, g: 0, b: 0, a: 0.6 } } });

  // box
  r.draw({ type: 'box', bounds: { x: bx, y: by, width: bw, height: bh }, titleStyle: { fg: c.accent } });
  r.draw({ type: 'text', x: bx + 2, y: by, text: ' CONFIG ', style: st(c.accent, undefined, true) });

  for (let i = 0; i < SETTINGS_FIELDS.length; i++) {
    const f = SETTINGS_FIELDS[i];
    const y = by + 2 + i;
    const isSel = i === s.settingsField;
    const val = isSel ? s.settingsValue : (f.mask ? '•'.repeat(16) : String(s.config[f.key]));
    const label = (f.label + ':').padEnd(14);
    if (isSel) r.draw({ type: 'fill', bounds: { x: bx + 1, y, width: bw - 2, height: 1 }, style: { bg: c.selectionBg } });
    r.draw({ type: 'text', x: bx + 2, y, text: label, style: st(isSel ? c.selectionFg : c.muted, isSel ? c.selectionBg : undefined) });
    r.draw({ type: 'text', x: bx + 16, y, text: vtrim(val, bw - 18), style: st(isSel ? c.selectionFg : c.foreground, isSel ? c.selectionBg : undefined) });
  }

  r.draw({ type: 'text', x: bx + 2, y: by + bh - 2,
    text: 'Up/Down: field   Enter: save field   Esc: close',
    style: st(c.muted, undefined, false, true) });
}

// ─── Real chat logic ──────────────────────────────────────────

function pushMsg(msg: Msg): void {
  state.messages = [...state.messages, msg];
}

async function runAgentLoop(): Promise<void> {
  let maxIter = 10;
  while (maxIter-- > 0) {
    const idx = state.messages.length;
    pushMsg({ role: 'assistant', content: '', reasoning: '' });
    state.autoScroll = true;

    let fc = '', fr = '';
    const toolCalls: ToolCall[] = [];

    try {
      for await (const ch of streamChat(state.config, state.history, TOOLS)) {
        fc = ch.content; fr = ch.reasoning ?? '';
        toolCalls.length = 0; toolCalls.push(...ch.toolCalls);
        state.messages[idx] = { role: 'assistant', content: fc, reasoning: fr };
        if (ch.done) break;
      }

      if (toolCalls.length > 0) {
        state.history.push({ role: 'assistant', content: fc || null, tool_calls: toolCalls });
        for (const tc of toolCalls) {
          const res = executeTool(tc);
          state.history.push(res);
          pushMsg({ role: 'tool', toolName: tc.function.name, args: (() => { try { const a = JSON.parse(tc.function.arguments); return Object.entries(a).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join(', '); } catch { return tc.function.arguments.slice(0, 80); } })(), result: res.content.slice(0, 200), content: '' });
        }
        continue;
      }

      state.history.push({ role: 'assistant', content: fc });
      state.streaming = false;
      return;
    } catch (e) {
      state.messages[idx] = { role: 'system', content: 'Error: ' + String(e) };
      state.streaming = false;
      return;
    }
  }
  state.streaming = false;
}

function send(): void {
  const msg = state.input.trim();
  state.input = ''; state.cursor = 0;
  if (!msg || state.streaming) return;
  pushMsg({ role: 'user', content: msg });
  state.history.push({ role: 'user', content: msg });
  state.autoScroll = true;
  if (!state.config.apiKey) { pushMsg({ role: 'system', content: 'No API key. Press Ctrl+O to configure.' }); return; }
  state.streaming = true;
  runAgentLoop();
}

function saveSettingsField(): void {
  const f = SETTINGS_FIELDS[state.settingsField];
  if (f.key === 'thinking')    (state.config as any)[f.key] = state.settingsValue.toLowerCase() === 'true';
  else if (f.key === 'maxTokens' || f.key === 'temperature') (state.config as any)[f.key] = Number(state.settingsValue) || (state.config as any)[f.key];
  else (state.config as any)[f.key] = state.settingsValue;
}

// ─── Frame ────────────────────────────────────────────────────

function renderFrame(r: Renderer, s: State): void {
  const { width: W, height: H } = screen.getSize();
  const lay = computeLayout(W, H);
  const c = s.theme.colors;

  r.clear();
  r.draw({ type: 'fill', bounds: { x: 0, y: 0, width: W, height: H }, style: { bg: c.background } });

  renderTitle(r, lay, s);
  renderHeaders(r, lay, s);
  renderDividers(r, lay, s);
  renderAgents(r, lay, s);
  renderSessions(r, lay, s);
  renderConversation(r, lay, s);
  renderTodo(r, lay, s);
  renderInput(r, lay, s);
  renderStatus(r, lay, s);

  if (s.settingsOpen) renderSettings(r, lay, s);

  r.flush();
}

// ─── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  screen.enter();
  screen.setTitle('multi-agent · inbox');

  const { width: W, height: H } = screen.getSize();
  const renderer = new Renderer(W, H);
  const keyboard = new Keyboard();

  screen.onResize((w, h) => renderer.resize(w, h));

  screen.onKey(buf => {
    for (const key of keyboard.feed(buf)) {

      // ── Settings overlay ──
      if (state.settingsOpen) {
        if (key.name === 'escape') { state.settingsOpen = false; continue; }
        if (key.name === 'up')    { saveSettingsField(); state.settingsField = Math.max(0, state.settingsField - 1); state.settingsValue = String(state.config[SETTINGS_FIELDS[state.settingsField].key]); continue; }
        if (key.name === 'down')  { saveSettingsField(); state.settingsField = Math.min(SETTINGS_FIELDS.length - 1, state.settingsField + 1); state.settingsValue = String(state.config[SETTINGS_FIELDS[state.settingsField].key]); continue; }
        if (key.name === 'enter') { saveSettingsField(); state.settingsOpen = false; continue; }
        if (key.name === 'backspace') { state.settingsValue = state.settingsValue.slice(0, -1); continue; }
        if (key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32) { state.settingsValue += key.sequence; continue; }
        continue;
      }

      // ── Global ──
      if (key.ctrl && key.name === 'q') { state.running = false; continue; }
      if (key.ctrl && key.name === 't') { state.theme = cycleTheme(state.theme); continue; }
      if (key.ctrl && key.name === 'o') {
        state.settingsOpen = true; state.settingsField = 0;
        state.settingsValue = String(state.config[SETTINGS_FIELDS[0].key]);
        continue;
      }
      if (key.name === 'escape' && state.streaming) { state.streaming = false; continue; }

      // ── Tab cycles focus ──
      if (key.name === 'tab') {
        const panes: FocusPane[] = ['agents', 'sessions', 'conv', 'todo', 'input'];
        state.focus = panes[(panes.indexOf(state.focus) + 1) % panes.length];
        continue;
      }

      // ── Pane nav ──
      if (state.focus === 'agents') {
        if (key.name === 'up')    { state.agentSel = Math.max(0, state.agentSel - 1); continue; }
        if (key.name === 'down')  { state.agentSel = Math.min(AGENTS.length - 1, state.agentSel + 1); continue; }
        if (key.name === 'right') { state.focus = 'sessions'; continue; }
        if (key.name === 'enter') { state.focus = 'input'; continue; }
        continue;
      }

      if (state.focus === 'sessions') {
        if (key.name === 'up')    { state.sessSel = Math.max(0, state.sessSel - 1); continue; }
        if (key.name === 'down')  { state.sessSel = Math.min(SESSIONS.length - 1, state.sessSel + 1); continue; }
        if (key.name === 'left')  { state.focus = 'agents'; continue; }
        if (key.name === 'right') { state.focus = 'conv'; continue; }
        if (key.name === 'enter') { state.focus = 'input'; continue; }
        continue;
      }

      if (state.focus === 'conv') {
        if (key.name === 'up'   || key.name === 'pageup')   { state.msgScroll = Math.max(0, state.msgScroll - (key.name === 'pageup' ? 10 : 1)); state.autoScroll = false; continue; }
        if (key.name === 'down' || key.name === 'pagedown') { state.msgScroll += (key.name === 'pagedown' ? 10 : 1); continue; }
        if (key.name === 'end')  { state.autoScroll = true; continue; }
        if (key.name === 'left') { state.focus = 'sessions'; continue; }
        if (key.name === 'right'){ state.focus = 'todo'; continue; }
        if (key.name === 'enter' || key.name === 'escape') { state.focus = 'input'; continue; }
        continue;
      }

      if (state.focus === 'todo') {
        if (key.name === 'left')  { state.focus = 'conv'; continue; }
        if (key.name === 'enter' || key.name === 'escape') { state.focus = 'input'; continue; }
        continue;
      }

      // ── Input (default) ──
      if (key.name === 'backspace') {
        if (state.cursor > 0) { state.input = state.input.slice(0, state.cursor - 1) + state.input.slice(state.cursor); state.cursor--; }
      } else if (key.name === 'left')  { state.cursor = Math.max(0, state.cursor - 1);
      } else if (key.name === 'right') { state.cursor = Math.min(state.input.length, state.cursor + 1);
      } else if (key.name === 'home')  { state.cursor = 0;
      } else if (key.name === 'end')   { state.cursor = state.input.length;
      } else if (key.name === 'up')    { state.focus = 'conv'; state.autoScroll = false;
      } else if (key.name === 'enter') { send();
      } else if (key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32) {
        state.input = state.input.slice(0, state.cursor) + key.sequence + state.input.slice(state.cursor);
        state.cursor++;
      }
    }
  });

  setInterval(() => {
    if (!state.running) { screen.exit(); process.exit(0); }
    try { renderFrame(renderer, state); } catch {}
  }, 33);
}

main().catch(err => {
  try { screen.exit(); } catch {}
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
