import { Bounds, DrawCommand, Theme } from '../engine/types.js';
import { styled, statusColor, statusIcon, truncate } from './text.js';
import { AgentStore } from '../store/index.js';
import { AgentType, AgentStatus } from '../../src/core/types.js';

export function compactAgentBar(
  bounds: Bounds,
  state: AgentStore,
  theme: Theme,
): DrawCommand[] {
  const commands: DrawCommand[] = [];

  commands.push({
    type: 'fill',
    bounds,
    style: { bg: theme.colors.surface },
  });

  if (!state.tree) {
    commands.push({
      type: 'text', x: bounds.x + 2, y: bounds.y,
      text: 'No agents',
      style: styled({ fg: theme.colors.muted }),
    });
    return commands;
  }

  let x = bounds.x + 1;

  const mainIcon = statusIcon(state.tree.info.status as AgentStatus);
  const mainCol = statusColor(state.tree.info.status as AgentStatus, theme);
  const mainStr = `${mainIcon} Main`;
  commands.push({ type: 'text', x, y: bounds.y, text: mainStr, style: styled({ fg: mainCol, bold: true }) });
  x += mainStr.length + 1;

  for (const spawn of state.tree.children) {
    const col = statusColor(spawn.info.status as AgentStatus, theme);
    const icon = statusIcon(spawn.info.status as AgentStatus);
    const name = truncate(spawn.info.id, 8);
    const forkStr = spawn.children.length > 0 ? `(${spawn.children.length})` : '';

    const selected = spawn.info.id === state.selectedId;
    const selBg = selected ? theme.colors.selectionBg : undefined;
    const selFg = selected ? theme.colors.selectionFg : undefined;

    const spawnStr = ` ${icon} ${name}${forkStr}`;
    if (x + spawnStr.length > bounds.width - 20) {
      commands.push({ type: 'text', x, y: bounds.y, text: '…', style: styled({ fg: theme.colors.muted }) });
      break;
    }

    if (selected) {
      commands.push({
        type: 'fill',
        bounds: { x: x - 1, y: bounds.y, width: spawnStr.length + 1, height: 1 },
        style: { bg: theme.colors.selectionBg },
      });
    }

    commands.push({
      type: 'text', x, y: bounds.y,
      text: spawnStr,
      style: styled({ fg: col, bg: selBg }),
    });
    x += spawnStr.length;
  }

  const stats = `  ${state.team.totalMemoryKeys} keys`;
  if (x + stats.length < bounds.width - 2) {
    commands.push({
      type: 'text', x: bounds.x + bounds.width - stats.length - 2, y: bounds.y,
      text: stats,
      style: styled({ fg: theme.colors.muted, dim: true }),
    });
  }

  return commands;
}
