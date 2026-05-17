import { screen } from './engine/screen.js';
import { Renderer } from './engine/renderer.js';
import { Keyboard } from './engine/keyboard.js';
import { store } from './store/index.js';
import { defaultTheme } from './themes/default.js';
import { cycleTheme } from './themes/index.js';
import { memoryTable } from './components/table.js';
import { eventLog } from './components/log.js';
import { commandPalette, PaletteItem } from './components/input.js';
import { chatView, ChatMessage } from './components/chat.js';
import { compactAgentBar } from './components/compact-tree.js';
import { agentTree } from './components/tree.js';
import { agentCardList, buildCardsFromStore, tickSpinner } from './components/agent-card.js';
import { spawnBridge } from '../omo-bridge/index.js';
import { box } from './components/box.js';
import { parseCommand, ParsedCommand } from './engine/command-parser.js';
import { TextStyle, RGBA, Bounds, Theme, ParsedKey, DrawCommand } from './engine/types.js';

let currentTheme = defaultTheme;

async function main(): Promise<void> {
  screen.enter();
  screen.setTitle('SpawnTUI');

  let running = true;
  let viewMode: 'cards' | 'tree' = 'cards';
  let paletteOpen = false;
  let paletteQuery = '';
  let paletteIdx = 0;
  let chatMessages: ChatMessage[] = [];
  let chatInput = '';
  let chatCursor = 0;

  const paletteItems: PaletteItem[] = [
    { key: 's', label: 'Spawn', description: 'spawn <desc>', action: 'spawn' },
    { key: 'f', label: 'Fork', description: 'fork <id> <desc>', action: 'fork' },
    { key: 'p', label: 'Pause', description: 'pause <id>', action: 'pause' },
    { key: 'r', label: 'Resume', description: 'resume <id>', action: 'resume' },
    { key: 't', label: 'Terminate', description: 'term <id>', action: 'terminate' },
    { key: 'm', label: 'Memory', description: 'memory set <k> <v>', action: 'memory:set' },
    { key: 'v', label: 'View', description: 'toggle cards/tree', action: 'view:toggle' },
    { key: 'th', label: 'Theme', description: 'cycle theme', action: 'theme:cycle' },
    { key: 'q', label: 'Quit', description: 'exit', action: 'quit' },
  ];

  const size = screen.getSize();
  const renderer = new Renderer(size.width, size.height);
  const keyboard = new Keyboard();

  await initDemo();
  store.init();

  addMsg('system', `Ready. ${store.getState().team.spawns.length} spawns, ${store.getState().team.forks.length} forks.`);
  addMsg('system', 'Type: spawn <desc> | fork <id> <desc> | pause <id> | memory set <k> <v> | help');

  const layout = computeLayout(size.width, size.height);
  let currentLayout = layout;

  screen.onResize((w, h) => {
    renderer.resize(w, h);
    currentLayout = computeLayout(w, h);
  });

  screen.onKey((buf) => {
    const keys = keyboard.feed(buf);
    for (const key of keys) {
      if (paletteOpen) { handlePaletteKey(key); continue; }
      if (key.name === 'enter') { submitChat(); continue; }
      if (key.name === 'escape') { chatInput = ''; chatCursor = 0; continue; }
      if (key.name === '/') { paletteOpen = true; paletteQuery = ''; paletteIdx = 0; continue; }
      if (key.name === 'backspace') {
        if (chatCursor > 0) { chatInput = chatInput.slice(0, chatCursor - 1) + chatInput.slice(chatCursor); chatCursor--; }
        continue;
      }
      if (key.name === 'left') { chatCursor = Math.max(0, chatCursor - 1); continue; }
      if (key.name === 'right') { chatCursor = Math.min(chatInput.length, chatCursor + 1); continue; }
      if (key.name === 'home') { chatCursor = 0; continue; }
      if (key.name === 'end') { chatCursor = chatInput.length; continue; }
      if (key.name === 'up') { moveSelection(-1); continue; }
      if (key.name === 'down') { moveSelection(1); continue; }
      if (key.name === 'v') { viewMode = viewMode === 'cards' ? 'tree' : 'cards'; continue; }
      if (key.name === 't') { currentTheme = cycleTheme(currentTheme); continue; }
      if (key.name === 'q' && chatInput === '') { running = false; continue; }
      if (key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32 && key.sequence.charCodeAt(0) <= 126) {
        chatInput = chatInput.slice(0, chatCursor) + key.sequence + chatInput.slice(chatCursor);
        chatCursor++;
      }
    }
  });

  function submitChat(): void {
    if (!chatInput.trim()) return;
    const cmd = parseCommand(chatInput);
    const raw = chatInput;
    chatInput = ''; chatCursor = 0;
    executeCommand(cmd, raw);
  }

  function executeCommand(cmd: ParsedCommand | null, raw: string): void {
    addMsg('user', raw);
    if (!cmd) { addMsg('error', `Unknown: ${raw.split(' ')[0]}. Type help.`); return; }

    const st = store.getState();
    const sel = st.selectedId;

    switch (cmd.action) {
      case 'spawn': {
        const desc = cmd.args.join(' ') || 'Untitled';
        spawnBridge.spawnAgent(desc).then(() => { store.refresh(); addMsg('system', `Spawned "${desc}"`); }).catch(e => addMsg('error', String(e)));
        break;
      }
      case 'fork': {
        const tid = cmd.args[0] ? findAgent(cmd.args[0]) : sel;
        if (!tid) { addMsg('error', 'Usage: fork <spawn-id> <desc>'); break; }
        const desc = cmd.args.slice(1).join(' ') || 'Untitled';
        spawnBridge.forkAgent(tid, desc).then(() => { store.refresh(); addMsg('system', `Forked "${desc}"`); }).catch(e => addMsg('error', String(e)));
        break;
      }
      case 'pause': {
        const tid = cmd.args[0] ? findAgent(cmd.args[0]) : sel;
        if (!tid) { addMsg('error', 'Usage: pause <agent-id>'); break; }
        spawnBridge.pauseAgent(tid).then(() => { store.refresh(); addMsg('system', `Paused ${tid.slice(0, 12)}..`); }).catch(e => addMsg('error', String(e)));
        break;
      }
      case 'resume': {
        const tid = cmd.args[0] ? findAgent(cmd.args[0]) : sel;
        if (!tid) { addMsg('error', 'Usage: resume <agent-id>'); break; }
        spawnBridge.resumeAgent(tid).then(() => { store.refresh(); addMsg('system', `Resumed ${tid.slice(0, 12)}..`); }).catch(e => addMsg('error', String(e)));
        break;
      }
      case 'terminate': {
        const tid = cmd.args[0] ? findAgent(cmd.args[0]) : sel;
        if (!tid) { addMsg('error', 'Usage: term <agent-id>'); break; }
        spawnBridge.terminateAgent(tid).then(() => { store.select(null); store.refresh(); addMsg('system', `Terminated ${tid.slice(0, 12)}..`); }).catch(e => addMsg('error', String(e)));
        break;
      }
      case 'memory:set': {
        if (cmd.args.length < 2) { addMsg('error', 'Usage: memory set <key> <value>'); break; }
        const tid = sel || st.agents.find(a => a.type === 'SPAWN')?.id;
        if (!tid) { addMsg('error', 'No spawn.'); break; }
        try { spawnBridge.memorySet(tid, cmd.args[0], JSON.parse(cmd.args.slice(1).join(' '))); }
        catch { spawnBridge.memorySet(tid, cmd.args[0], cmd.args.slice(1).join(' ')); }
        store.refresh();
        addMsg('system', `Memory: ${cmd.args[0]} = ${cmd.args.slice(1).join(' ')}`);
        break;
      }
      case 'memory:del': {
        if (cmd.args.length < 1) { addMsg('error', 'Usage: memory del <key>'); break; }
        const tid = sel || st.agents.find(a => a.type === 'SPAWN')?.id;
        if (!tid) { addMsg('error', 'No spawn.'); break; }
        spawnBridge.memoryDelete(tid, cmd.args[0]); store.refresh();
        addMsg('system', `Deleted: ${cmd.args[0]}`);
        break;
      }
      case 'memory:clear': {
        const tid = sel || st.agents.find(a => a.type === 'SPAWN')?.id;
        if (!tid) { addMsg('error', 'No spawn.'); break; }
        spawnBridge.memoryClear(tid); store.refresh();
        addMsg('system', 'Memory cleared.');
        break;
      }
      case 'select': {
        const id = findAgent(cmd.args[0] || '');
        if (id) { store.select(id); addMsg('system', `Selected ${id.slice(0, 12)}..`); }
        else addMsg('error', `Not found: ${cmd.args[0]}`);
        break;
      }
      case 'view:toggle': viewMode = viewMode === 'cards' ? 'tree' : 'cards'; addMsg('system', `View: ${viewMode}`); break;
      case 'theme:cycle': currentTheme = cycleTheme(currentTheme); addMsg('system', `Theme: ${currentTheme.name}`); break;
      case 'help':
        addMsg('system', 'spawn <d> | fork <id> <d> | pause/resume/term <id>');
        addMsg('system', 'memory set <k> <v> | del <k> | clear | select <id> | view | theme | quit');
        break;
      case 'quit': running = false; break;
      default: addMsg('error', `Unknown: ${cmd.action}`);
    }
  }

  function findAgent(p: string): string | null {
    const m = store.getState().agents.find(a => a.id.startsWith(p) || a.id.includes(p));
    return m?.id ?? null;
  }

  function addMsg(role: ChatMessage['role'], content: string): void {
    chatMessages = [...chatMessages, { role, content, timestamp: Date.now() }];
    if (chatMessages.length > 200) chatMessages = chatMessages.slice(-200);
  }

  function moveSelection(dir: number): void {
    const st = store.getState();
    if (!st.tree) return;
    const flat = flattenTree(st.tree);
    const idx = st.selectedId ? flat.findIndex(a => a === st.selectedId) : -1;
    const n = Math.max(0, Math.min(flat.length - 1, idx + dir));
    if (flat[n]) store.select(flat[n]);
  }

  function flattenTree(node: import('./store/index.js').AgentTreeNode): string[] {
    return [node.info.id, ...node.children.flatMap(c => flattenTree(c))];
  }

  function handlePaletteKey(key: ParsedKey): void {
    const filter = (q: string) => paletteItems.filter(i =>
      i.label.toLowerCase().includes(q.toLowerCase()) || i.description.toLowerCase().includes(q.toLowerCase()));

    if (key.name === 'escape') { paletteOpen = false; return; }
    if (key.name === 'enter') {
      const items = filter(paletteQuery);
      if (items[paletteIdx]) { chatInput = items[paletteIdx].label.toLowerCase() + ' '; chatCursor = chatInput.length; }
      paletteOpen = false;
      return;
    }
    if (key.name === 'up') { paletteIdx = Math.max(0, paletteIdx - 1); return; }
    if (key.name === 'down') { paletteIdx = Math.min(filter(paletteQuery).length - 1, paletteIdx + 1); return; }
    if (key.name === 'backspace') { paletteQuery = paletteQuery.slice(0, -1); paletteIdx = 0; return; }
    if (key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32 && key.sequence.charCodeAt(0) <= 126) {
      paletteQuery += key.sequence; paletteIdx = 0;
    }
  }

  function computeLayout(width: number, height: number) {
    const agentH = 1, chatH = 6, footerH = 1;
    const mainTop = agentH, mainH = height - agentH - chatH - footerH;
    const rw = Math.min(38, Math.floor(width * 0.3)), lw = width - rw;
    const rh = Math.floor(mainH * 0.55);

    return {
      agent: { x: 0, y: 0, width, height: agentH },
      tree: { x: 0, y: mainTop, width: lw, height: mainH },
      mem: { x: lw, y: mainTop, width: rw, height: rh },
      log: { x: lw, y: mainTop + rh, width: rw, height: mainH - rh },
      chat: { x: 0, y: mainTop + mainH, width, height: chatH },
      footer: { x: 0, y: height - footerH, width, height: footerH },
    };
  }

  function renderFrame(): void {
    const s = store.getState();
    const l = currentLayout;
    const t = currentTheme;

    renderer.clear();

    for (const c of compactAgentBar(l.agent, s, t)) renderer.draw(c);

    const ttl = viewMode === 'cards' ? ' Agents ' : ' Agent Tree ';
    for (const c of box(l.tree, t, { title: ttl })) renderer.draw(c);
    const ti: Bounds = { x: l.tree.x + 1, y: l.tree.y + 1, width: l.tree.width - 2, height: l.tree.height - 2 };
    if (viewMode === 'cards') for (const c of agentCardList(ti, buildCardsFromStore(s), s.selectedId, t)) renderer.draw(c);
    else for (const c of agentTree(ti, s.tree, s.selectedId, t)) renderer.draw(c);

    for (const c of box(l.mem, t, { title: ' Memory ' })) renderer.draw(c);
    const mi: Bounds = { x: l.mem.x + 1, y: l.mem.y + 1, width: l.mem.width - 2, height: l.mem.height - 2 };
    const sid = s.selectedId || s.agents.find(a => a.type === 'SPAWN')?.id || null;
    for (const c of memoryTable(mi, s.memoryKeys, sid, t)) renderer.draw(c);

    for (const c of box(l.log, t, { title: ' Events ' })) renderer.draw(c);
    const li: Bounds = { x: l.log.x + 1, y: l.log.y + 1, width: l.log.width - 2, height: l.log.height - 2 };
    for (const c of eventLog(li, s.events, t)) renderer.draw(c);

    for (const c of chatView(l.chat, chatMessages, chatInput, chatCursor, t)) renderer.draw(c);

    const hints = [
      { k: 's', d: 'spawn' }, { k: 'f', d: 'fork' }, { k: 'p', d: 'pause' },
      { k: 'r', d: 'resume' }, { k: 't', d: 'term' }, { k: '/', d: 'cmds' },
      { k: '↑↓', d: 'select' }, { k: 'v', d: 'view' }, { k: 'q', d: 'quit' },
    ];
    for (const c of footerHints(l.footer, hints, t)) renderer.draw(c);

    tickSpinner();

    if (paletteOpen) {
      const fs: Bounds = { x: 0, y: 0, width: l.agent.width, height: l.agent.height + l.tree.height + l.mem.height + l.chat.height + l.footer.height };
      for (const c of commandPalette(fs, paletteItems, paletteQuery, paletteIdx, t)) renderer.draw(c);
    }

    renderer.flush();
  }

  setInterval(() => {
    if (!running) { store.destroy(); screen.exit(); process.exit(0); }
    try { renderFrame(); } catch {}
  }, 33);
}

function footerHints(bounds: Bounds, hints: Array<{ k: string; d: string }>, theme: Theme): DrawCommand[] {
  const cmds: DrawCommand[] = [{ type: 'fill', bounds, style: { bg: theme.colors.surface } }];
  let x = bounds.x + 1;
  for (const h of hints) {
    const seg = ` ${h.k}:`;
    cmds.push({ type: 'text', x, y: bounds.y, text: seg, style: { fg: theme.colors.accent, bold: true } });
    x += seg.length;
    cmds.push({ type: 'text', x, y: bounds.y, text: h.d, style: { fg: theme.colors.muted, dim: true } });
    x += h.d.length;
    if (x > bounds.x + bounds.width - 10) break;
  }
  return cmds;
}

async function initDemo(): Promise<void> {
  try {
    const s1 = await spawnBridge.spawnAgent('Auth service', ['use-oauth2']);
    const s2 = await spawnBridge.spawnAgent('Database layer', ['postgres-only']);
    spawnBridge.memorySet(s1.spawnId, 'auth.provider', 'jwt');
    spawnBridge.memorySet(s1.spawnId, 'token.ttl', 3600);
    spawnBridge.memorySet(s2.spawnId, 'db.host', 'localhost');
    spawnBridge.memorySet(s2.spawnId, 'db.port', 5432);
    await spawnBridge.forkAgent(s1.spawnId, 'Login handler');
    await spawnBridge.forkAgent(s1.spawnId, 'Token refresh');
    await spawnBridge.forkAgent(s2.spawnId, 'Query builder');
  } catch {}
}

main().catch(err => {
  process.stderr.write(`Error: ${String(err)}\n`);
  try { screen.exit(); } catch {}
  process.exit(1);
});
