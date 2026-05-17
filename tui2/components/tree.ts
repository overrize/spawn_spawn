import { Bounds, DrawCommand, Theme } from '../engine/types.js';
import { styled, statusColor, statusIcon, truncate } from './text.js';
import { AgentTreeNode } from '../store/index.js';
import { AgentType } from '../../src/core/types.js';

const TREE_CHARS = {
  branch: '├── ',
  last:   '└── ',
  pipe:   '│   ',
  space:  '    ',
  connector: '│ ',
  spaceConnector: '  ',
};

export function agentTree(
  bounds: Bounds,
  tree: AgentTreeNode | null,
  selectedId: string | null,
  theme: Theme,
): DrawCommand[] {
  const commands: DrawCommand[] = [];
  if (!tree) {
    const msg = 'No agents spawned';
    commands.push({
      type: 'text',
      x: bounds.x + Math.floor((bounds.width - msg.length) / 2),
      y: bounds.y + Math.floor(bounds.height / 2),
      text: msg,
      style: styled({ fg: theme.colors.muted }),
    });
    return commands;
  }

  const lines = flattenTreeLines(tree, '', true);

  const scrollOffset = 0;
  const maxLines = bounds.height;

  for (let i = scrollOffset; i < Math.min(lines.length, scrollOffset + maxLines); i++) {
    const line = lines[i];
    const y = bounds.y + i - scrollOffset;
    if (y >= bounds.y + bounds.height) break;

    const isSelected = line.agentId === selectedId;
    const lineStyle = isSelected
      ? styled({ fg: theme.colors.selectionFg, bg: theme.colors.selectionBg })
      : styled({ fg: line.isMain ? theme.colors.accent : theme.colors.foreground });

    const prefix = line.prefix + (line.isMain ? '◆ ' : line.isSpawn ? '◉ ' : '○ ');

    const statusCol = statusColor(line.status as any, theme);
    const icon = statusIcon(line.status as any);

    const name = line.isMain
      ? 'MainAgent (orchestrator)'
      : truncate(line.label, bounds.width - prefix.length - 15);

    const statusStr = ` ${icon} ${line.status}`;
    const forkInfo = line.forkCount !== undefined && line.forkCount > 0
      ? `  forks=${line.forkCount}` : '';
    const depthInfo = line.depth !== undefined ? `  d=${line.depth}` : '';

    const rightInfo = `${statusStr}${forkInfo}${depthInfo}`;

    if (isSelected) {
      commands.push({
        type: 'fill',
        bounds: { x: bounds.x, y, width: bounds.width, height: 1 },
        style: { bg: theme.colors.selectionBg },
      });
    }

    commands.push({
      type: 'text',
      x: bounds.x,
      y,
      text: prefix + name,
      style: isSelected
        ? styled({ fg: theme.colors.selectionFg, bg: theme.colors.selectionBg })
        : styled({ fg: line.isMain ? theme.colors.accent : theme.colors.foreground }),
    });

    const infoX = bounds.x + bounds.width - rightInfo.length - 1;
    if (infoX > bounds.x + prefix.length + 3) {
      commands.push({
        type: 'text',
        x: Math.max(bounds.x + prefix.length + 3, infoX),
        y,
        text: rightInfo,
        style: isSelected
          ? styled({ fg: statusCol, bg: theme.colors.selectionBg, dim: true })
          : styled({ fg: statusCol, dim: true }),
      });
    }
  }

  return commands;
}

interface TreeLine {
  prefix: string;
  label: string;
  agentId: string;
  status: string;
  isMain: boolean;
  isSpawn: boolean;
  forkCount?: number;
  depth?: number;
}

function flattenTreeLines(node: AgentTreeNode, prefix: string, isRoot: boolean): TreeLine[] {
  const lines: TreeLine[] = [];

  lines.push({
    prefix: isRoot ? '' : prefix,
    label: node.info.id,
    agentId: node.info.id,
    status: node.info.status,
    isMain: node.info.type === AgentType.MAIN,
    isSpawn: node.info.type === AgentType.SPAWN,
    forkCount: node.info.forkCount,
    depth: node.info.depth,
  });

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const isLast = i === node.children.length - 1;
    const childPrefix = isRoot
      ? (isLast ? TREE_CHARS.last : TREE_CHARS.branch)
      : prefix + (isLast ? TREE_CHARS.last : TREE_CHARS.branch);

    const continuation = prefix + (isLast ? TREE_CHARS.space : TREE_CHARS.pipe);

    for (const line of flattenTreeLines(child, continuation, false)) {
      if (line.prefix === '') {
        lines.push({ ...line, prefix: childPrefix });
      } else {
        lines.push(line);
      }
    }
  }

  return lines;
}
