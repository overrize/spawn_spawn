import { Bounds, DrawCommand, Theme } from '../engine/types.js';
import { styled, statusColor, statusIcon } from './text.js';
import { SwarmTopology, SwarmNode, MemoryFlow } from '../store/swarm.js';

export function swarmView(
  bounds: Bounds,
  topology: SwarmTopology | null,
  theme: Theme,
): DrawCommand[] {
  const commands: DrawCommand[] = [];
  if (!topology) {
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

  const root = topology.root;
  const cx = bounds.x + Math.floor(bounds.width / 2);
  let y = bounds.y + 1;

  commands.push({
    type: 'text',
    x: cx - 12,
    y,
    text: `⬢ MainAgent (${root.status})`,
    style: styled({ fg: theme.colors.accent, bold: true }),
  });
  y += 2;

  if (root.children.length === 0) {
    commands.push({
      type: 'text',
      x: cx - 10,
      y,
      text: '(no spawns)',
      style: styled({ fg: theme.colors.muted }),
    });
    return commands;
  }

  const spawnWidth = Math.min(24, Math.floor((bounds.width - 4) / root.children.length));
  for (let i = 0; i < root.children.length; i++) {
    const spawn = root.children[i];
    const sx = bounds.x + 2 + i * Math.floor((bounds.width - 4) / root.children.length) + Math.floor(spawnWidth / 2);

    commands.push({
      type: 'text',
      x: sx - 1,
      y: y - 1,
      text: '│',
      style: styled({ fg: theme.colors.border }),
    });

    const col = statusColor(spawn.status as any, theme);
    const icon = statusIcon(spawn.status as any);
    const spawnLabel = `◉ ${icon} Spawn ${spawn.label.slice(0, 14)}`;
    commands.push({
      type: 'text',
      x: sx - Math.floor(spawnLabel.length / 2),
      y,
      text: spawnLabel,
      style: styled({ fg: col }),
    });

    y++;
    if (spawn.memoryKeys > 0) {
      commands.push({
        type: 'text',
        x: sx - 5,
        y,
        text: `mem:${spawn.memoryKeys}`,
        style: styled({ fg: theme.colors.info, dim: true }),
      });
      y++;
    }

    for (let j = 0; j < spawn.children.length; j++) {
      const fork = spawn.children[j];
      const fx = sx - Math.floor(spawnWidth / 2) + 2 + j * 3;

      commands.push({
        type: 'text',
        x: fx,
        y: y - 1,
        text: '│',
        style: styled({ fg: theme.colors.border, dim: true }),
      });

      const fcol = statusColor(fork.status as any, theme);
      const ficon = statusIcon(fork.status as any);
      commands.push({
        type: 'text',
        x: fx - 1,
        y,
        text: `${ficon}F`,
        style: styled({ fg: fcol, dim: true }),
      });
    }

    if (spawn.children.length > 0) y++;
    y++;
  }

  y++;
  commands.push({
    type: 'text',
    x: bounds.x + 1,
    y,
    text: '── Memory Flows ──',
    style: styled({ fg: theme.colors.border, dim: true }),
  });
  y++;

  const maxFlows = Math.min(topology.flows.length, bounds.height - y + bounds.y);
  for (let i = 0; i < maxFlows; i++) {
    const flow = topology.flows[i];
    if (y >= bounds.y + bounds.height) break;

    const flowStr = flow.action === 'write'
      ? `${flow.fromLabel.slice(0, 10)} ──WRITE──▶ ${flow.key.slice(0, 14)}`
      : `${flow.key.slice(0, 14)} ──READ──▶ ${flow.toLabel.slice(0, 10)}`;

    const truncated = flowStr.length > bounds.width - 2
      ? flowStr.slice(0, bounds.width - 3) + '…'
      : flowStr;

    commands.push({
      type: 'text',
      x: bounds.x + 2,
      y,
      text: truncated,
      style: styled({ fg: theme.colors.muted, dim: true }),
    });
    y++;
  }

  if (topology.flows.length === 0) {
    commands.push({
      type: 'text',
      x: bounds.x + 2,
      y,
      text: '(no memory flows yet)',
      style: styled({ fg: theme.colors.muted }),
    });
  }

  return commands;
}
