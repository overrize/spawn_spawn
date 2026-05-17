import { screen } from './engine/screen.js';
import { Keyboard } from './engine/keyboard.js';
import { streamChat, ModelConfig, DEFAULT_CONFIG } from './llm/provider.js';
import { TOOLS, executeTool, ToolCall } from './llm/tools.js';

const keyboard = new Keyboard();
let config: ModelConfig = { ...DEFAULT_CONFIG };

interface Msg { role: string; content: string; reasoning?: string }
const msgs: Msg[] = [
  { role: 'system', content: 'Spawn Chat - Enter send, Ctrl+Q quit, Ctrl+O config.' },
];
const history: Array<{ role: string; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; name?: string }> = [];
let input = ''; let cursor = 0;
let running = true;
let streaming = false;
let scrollOffset = 0;
let autoScroll = true;
let settingsOpen = false;
let settingsField = 0;
let settingsValue = '';

const FIELDS: Array<{ key: keyof ModelConfig; label: string; mask: boolean }> = [
  { key: 'apiKey', label: 'API Key', mask: true },
  { key: 'model', label: 'Model', mask: false },
  { key: 'thinking', label: 'Thinking', mask: false },
  { key: 'maxTokens', label: 'Max Tokens', mask: false },
  { key: 'temperature', label: 'Temperature', mask: false },
];

screen.enter();
screen.setTitle('Spawn Chat');

screen.onKey(buf => {
  for (const k of keyboard.feed(buf)) {
    if (settingsOpen) { handleSettingsKey(k); continue; }
    if (streaming) { if (k.name === 'escape') { streaming = false; } continue; }
    if (k.ctrl && k.name === 'o') { settingsOpen = true; settingsField = 0; settingsValue = String(config[FIELDS[0].key]); continue; }
    if (k.ctrl && k.name === 'q') { running = false; continue; }
    if (k.name === 'pageup' || k.name === 'scrollup') { scrollUp(); continue; }
    if (k.name === 'pagedown' || k.name === 'scrolldown') { scrollDown(); continue; }
    if (k.name === 'enter') { send(); continue; }
    if (k.name === 'backspace') { if (cursor > 0) { input = input.slice(0, cursor-1) + input.slice(cursor); cursor--; } continue; }
    if (k.name === 'left') { cursor = Math.max(0, cursor-1); continue; }
    if (k.name === 'right') { cursor = Math.min(input.length, cursor+1); continue; }
    if (k.name === 'home') { cursor = 0; continue; }
    if (k.name === 'end') { cursor = input.length; continue; }
    if (k.sequence.length === 1 && k.sequence.charCodeAt(0) >= 32) {
      input = input.slice(0, cursor) + k.sequence + input.slice(cursor); cursor++;
    }
  }
});

function handleSettingsKey(k: any): void {
  if (k.name === 'escape') { settingsOpen = false; return; }
  if (k.name === 'enter') { saveSettings(); return; }
  if (k.name === 'up') { settingsField = Math.max(0, settingsField-1); settingsValue = String(config[FIELDS[settingsField].key]); return; }
  if (k.name === 'down') { settingsField = Math.min(FIELDS.length-1, settingsField+1); settingsValue = String(config[FIELDS[settingsField].key]); return; }
  if (k.name === 'backspace') { settingsValue = settingsValue.slice(0,-1); return; }
  if (k.sequence?.length === 1 && k.sequence.charCodeAt(0) >= 32) { settingsValue += k.sequence; }
}

function saveSettings(): void {
  const f = FIELDS[settingsField];
  if (f.key === 'thinking') (config as any)[f.key] = settingsValue.toLowerCase() === 'true';
  else if (f.key === 'maxTokens' || f.key === 'temperature') (config as any)[f.key] = Number(settingsValue) || (config as any)[f.key];
  else (config as any)[f.key] = settingsValue;
  settingsOpen = false;
}

function send(): void {
  const msg = input.trim();
  input = ''; cursor = 0;
  if (!msg || streaming) return;
  msgs.push({ role: 'user', content: msg });
  history.push({ role: 'user', content: msg });
  autoScroll = true;
  if (!config.apiKey) { msgs.push({ role: 'system', content: 'No API key. Press Ctrl+O.' }); return; }
  streaming = true;

  runAgentLoop();
}

async function runAgentLoop(): Promise<void> {
  let maxIter = 10;
  while (maxIter-- > 0) {
    const idx = msgs.length;
    msgs.push({ role: 'assistant', content: '', reasoning: '' });

    let fc = '', fr = '';
    const toolCalls: ToolCall[] = [];

    try {
      for await (const ch of streamChat(config, history, TOOLS)) {
        fc = ch.content; fr = ch.reasoning;
        toolCalls.length = 0;
        toolCalls.push(...ch.toolCalls);
        msgs[idx] = { role: 'assistant', content: fc, reasoning: fr };
        if (ch.done) break;
      }

      if (toolCalls.length > 0) {
        history.push({ role: 'assistant', content: fc || null, tool_calls: toolCalls });
        for (const tc of toolCalls) {
          const result = executeTool(tc);
          history.push(result);
          msgs.push({ role: 'system', content: `Tool [${tc.function.name}]: ${result.content.slice(0, 200)}` });
        }
        continue;
      }

      history.push({ role: 'assistant', content: fc });
      streaming = false;
      return;
    } catch (e) {
      msgs[idx] = { role: 'system', content: 'Error: ' + String(e) };
      streaming = false;
      return;
    }
  }
  streaming = false;
}

function scrollUp(): void { scrollOffset = Math.max(0, scrollOffset - 10); autoScroll = false; }
function scrollDown(): void { scrollOffset += 10; }

function render(): void {
  const W = process.stdout.columns ?? 80, H = process.stdout.rows ?? 24;
  let o = '\x1b[2J\x1b[H';

  if (settingsOpen) {
    const bw = 52, bh = FIELDS.length + 4;
    const bx = Math.floor((W-bw)/2), by = Math.floor((H-bh)/2);
    o += '\x1b[48;5;0m\x1b[2J';
    for (let i = 0; i < bh; i++) {
      o += '\x1b[' + (by+i+1) + ';' + (bx+1) + 'H';
      if (i === 0) o += '\x1b[33m┌' + '─'.repeat(bw-2) + '┐';
      else if (i === bh-1) o += '└' + '─'.repeat(bw-2) + '┘';
      else o += '│' + ' '.repeat(bw-2) + '│';
    }
    o += '\x1b[' + (by+1) + ';' + (bx+3) + 'H\x1b[33;1m Config (Ctrl+O) \x1b[0m';
    for (let i = 0; i < FIELDS.length; i++) {
      const f = FIELDS[i];
      const val = i === settingsField ? settingsValue : f.mask ? '•'.repeat(24) : String(config[f.key]);
      o += '\x1b[' + (by+2+i) + ';' + (bx+2) + 'H';
      if (i === settingsField) o += '\x1b[7m';
      o += (f.label + ': ').padEnd(16) + val + '\x1b[0m';
    }
    o += '\x1b[' + (by+bh-1) + ';' + (bx+2) + 'H\x1b[2mEnter save  Esc close\x1b[0m';
  } else {
    let y = 1, lineIdx = 0;
    const bodyH = H - 2;
    const tl = totalLines(W);
    if (autoScroll) scrollOffset = Math.max(0, tl - bodyH);

    for (const m of msgs) {
      const ul = m.role === 'user' ? 1 : countLines(m.content, W-2) + (m.reasoning ? countLines(m.reasoning, W-2) : 0);
      if (lineIdx + ul <= scrollOffset) { lineIdx += ul; continue; }
      const start = Math.max(0, scrollOffset - lineIdx);
      let loc = 0;
      if (m.role === 'user') {
        if (loc >= start && y < H-1) { o += '\x1b[' + (y+1) + ';1H\x1b[33m> ' + m.content.slice(0, W-2) + '\x1b[0m'; y++; }
        loc++;
      } else {
        if (m.reasoning) for (const l of wrapLines(m.reasoning, W-2)) {
          if (loc >= start && y < H-1) { o += '\x1b[' + (y+1) + ';1H\x1b[2m  ' + l + '\x1b[0m'; y++; }
          loc++;
        }
        for (const l of wrapLines(m.content, W-2)) {
          if (loc >= start && y < H-1) { o += '\x1b[' + (y+1) + ';1H  ' + l; y++; }
          loc++;
        }
        if (streaming && m === msgs[msgs.length-1] && y > 1) o += '\x1b[' + y + ';' + (W-1) + 'H\x1b[33m█\x1b[0m';
      }
      lineIdx += ul;
    }

    if (tl > bodyH) {
      const th = Math.max(1, Math.floor((bodyH*bodyH)/tl));
      const ty = 1 + Math.floor((scrollOffset/tl) * bodyH);
      for (let i = 0; i < th && ty+i < H-1; i++) o += '\x1b[' + (ty+i+1) + ';' + W + 'H\x1b[2m \x1b[0m';
    }

    o += '\x1b[1;1H\x1b[7m Model: ' + config.model + (config.thinking ? ' (thinking)' : '') + ' '.repeat(W - 10 - config.model.length - (config.thinking ? 12 : 0)) + '\x1b[0m';
    o += '\x1b[' + (H-1) + ';1H' + '─'.repeat(W);
    o += '\x1b[' + H + ';1H> ' + input;
    if (input.length) {
      const cx = 3 + visualWidth(input.slice(0, cursor));
      o += '\x1b[' + H + ';' + (cx+1) + 'H\x1b[7m' + (input[cursor] || ' ') + '\x1b[0m';
    }
  }

  process.stdout.write(o);
}

function countLines(t: string, w: number): number {
  if (!t) return 0;
  let n = 0, vis = 0;
  for (const ch of t) {
    if (ch === '\n') { n++; vis = 0; continue; }
    const cw = ch.charCodeAt(0) < 0x80 ? 1 : 2;
    if (vis + cw > w) { n++; vis = cw; } else { vis += cw; }
  }
  return n + (vis > 0 ? 1 : 0);
}

function wrapLines(t: string, w: number): string[] {
  if (!t) return [];
  const lines: string[] = [];
  let cur = '', vis = 0;
  for (const ch of t) {
    if (ch === '\n') { lines.push(cur); cur = ''; vis = 0; continue; }
    const cw = ch.charCodeAt(0) < 0x80 ? 1 : 2;
    if (vis + cw > w) { lines.push(cur); cur = ch; vis = cw; }
    else { cur += ch; vis += cw; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function totalLines(W: number): number {
  let n = 0;
  for (const m of msgs) {
    if (m.role === 'user') n++;
    else {
      if (m.reasoning) n += countLines(m.reasoning, W-2);
      n += countLines(m.content, W-2) || 1;
    }
  }
  return n;
}

function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) < 0x80 ? 1 : 2;
  return w;
}

setInterval(() => {
  if (!running) { screen.exit(); process.exit(0); }
  try { render(); } catch {}
}, 33);

render();
