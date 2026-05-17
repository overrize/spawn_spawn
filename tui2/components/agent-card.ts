import { Bounds, DrawCommand, Theme } from '../engine/types.js';
import { styled, statusColor, statusIcon, truncate } from './text.js';
import { progressBar, resourceGauge, SPINNER_FRAMES } from './progress-bar.js';
import { AgentStore, AgentTreeNode } from '../store/index.js';
import { AgentType, AgentStatus } from '../../src/core/types.js';
import { AgentInfo } from '../../omo-bridge/spawn-bridge.js';

export interface CardData {
  id: string;
  type: 'main' | 'spawn' | 'fork';
  name: string;
  status: string;
  depth: number;
  forkCount: number;
  memoryKeys: number;
  memoryTotal: number;
  taskDescription: string | null;
  taskProgress: number;
  taskStatus: string | null;
  duration: number;
  isSelected: boolean;
}

let spinnerIdx = 0;

export function tickSpinner(): string {
  spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[spinnerIdx];
}

export function agentCard(bounds: Bounds, card: CardData, theme: Theme): DrawCommand[] {
  const commands: DrawCommand[] = [];
  const y = bounds.y;
  const w = bounds.width;

  if (card.isSelected) {
    commands.push({
      type: 'fill',
      bounds: { x: bounds.x, y, width: w, height: 1 },
      style: { bg: theme.colors.selectionBg },
    });
  }

  let x = bounds.x;
  const selFg = card.isSelected ? theme.colors.selectionFg : undefined;
  const selBg = card.isSelected ? theme.colors.selectionBg : undefined;

  const indent = '  '.repeat(card.depth);
  const typeIcon = card.type === 'main' ? '⬢' : card.type === 'spawn' ? '◉' : '○';
  const name = truncate(card.name, 20);

  commands.push({
    type: 'text', x, y,
    text: `${indent}${typeIcon} ${name}`,
    style: styled({ fg: card.type === 'main' ? theme.colors.accent : theme.colors.foreground, bg: selBg }),
  });
  x += indent.length + 2 + Math.min(name.length, 20);

  const icon = statusIcon(card.status as AgentStatus);
  const col = statusColor(card.status as AgentStatus, theme);
  const statusStr = ` ${icon} ${card.status}`;
  commands.push({ type: 'text', x, y, text: statusStr, style: styled({ fg: col, bg: selBg }) });
  x += statusStr.length + 1;

  if (card.forkCount > 0 && card.type !== 'fork') {
    const fStr = ` forks:${card.forkCount}`;
    commands.push({ type: 'text', x, y, text: fStr, style: styled({ fg: theme.colors.muted, dim: true, bg: selBg }) });
    x += fStr.length;
  }

  if (card.memoryTotal > 0) {
    const memLabel = `mem:${card.memoryKeys}/${card.memoryTotal}`;
    const memPct = card.memoryTotal > 0 ? (card.memoryKeys / card.memoryTotal) * 100 : 0;
    const memCol = memPct > 80 ? theme.colors.error : memPct > 50 ? theme.colors.warning : theme.colors.success;
    commands.push({ type: 'text', x, y, text: ` ${memLabel}`, style: styled({ fg: memCol, dim: true, bg: selBg }) });
    x += memLabel.length + 1;
  }

  if (card.taskStatus === 'running') {
    const spinner = tickSpinner();
    const taskStr = ` ${spinner} ${truncate(card.taskDescription ?? '', w - x - 20)}`;
    commands.push({ type: 'text', x, y, text: taskStr, style: styled({ fg: theme.colors.info, bg: selBg }) });
    x += taskStr.length;

    if (x + 12 < bounds.x + w) {
      const pb = progressBar(
        { x, y, width: bounds.x + w - x, height: 1 },
        card.taskProgress,
        theme,
        { barWidth: Math.min(16, bounds.x + w - x - 8) },
      );
      for (const c of pb) commands.push(c);
    }
  } else if (card.taskStatus === 'completed') {
    commands.push({ type: 'text', x, y, text: ' ✓ done', style: styled({ fg: theme.colors.success, bg: selBg }) });
  } else if (card.duration > 0) {
    const durStr = ` ${formatDuration(card.duration)}`;
    commands.push({ type: 'text', x, y, text: durStr, style: styled({ fg: theme.colors.muted, dim: true, bg: selBg }) });
  }

  return commands;
}

export function agentCardList(
  bounds: Bounds,
  cards: CardData[],
  selectedId: string | null,
  theme: Theme,
): DrawCommand[] {
  const commands: DrawCommand[] = [];
  const maxCards = bounds.height;

  for (let i = 0; i < Math.min(cards.length, maxCards); i++) {
    const card = cards[i];
    const y = bounds.y + i;
    const cardBounds: Bounds = { x: bounds.x, y, width: bounds.width, height: 1 };

    const cmds = agentCard(cardBounds, card, theme);
    for (const c of cmds) commands.push(c);
  }

  return commands;
}

export function buildCardsFromStore(state: AgentStore): CardData[] {
  const cards: CardData[] = [];
  const tree = state.tree;
  if (!tree) return cards;

  function walk(node: AgentTreeNode, depth: number): void {
    const info = node.info;
    const isSpawn = info.type === AgentType.SPAWN;
    const spawnMem = isSpawn ? (state.memoryKeys.get(info.id)?.size ?? 0) : 0;

    const taskEntries: Array<{ desc: string; progress: number; status: string | null }> = [];
    if (isSpawn) {
      const mem = state.memoryKeys.get(info.id);
      if (mem) {
        for (const [key, val] of mem) {
          if (key.startsWith('task:') && key.endsWith(':desc')) {
            const taskId = key.replace(':desc', '');
            const status = String(mem.get(taskId + ':status') ?? '');
            const progress = Number(mem.get(taskId + ':progress') ?? 0);
            const desc = String(val ?? '');
            taskEntries.push({ desc, progress, status });
          }
        }
      }
    }

    const task = taskEntries[0] ?? null;

    cards.push({
      id: info.id,
      type: info.type === AgentType.MAIN ? 'main' : info.type === AgentType.SPAWN ? 'spawn' : 'fork',
      name: info.type === AgentType.MAIN ? 'MainAgent' : info.id.slice(0, 12) + '..',
      status: info.status,
      depth,
      forkCount: info.forkCount ?? 0,
      memoryKeys: isSpawn ? spawnMem : 0,
      memoryTotal: 24,
      taskDescription: task?.desc ?? null,
      taskProgress: task?.progress ?? 0,
      taskStatus: task?.status ?? null,
      duration: 0,
      isSelected: info.id === state.selectedId,
    });

    for (const child of node.children) {
      walk(child, depth + 1);
    }
  }

  walk(tree, 0);
  return cards;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}
