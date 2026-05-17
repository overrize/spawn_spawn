import { Bounds, DrawCommand, Theme } from '../engine/types.js';
import { styled } from './text.js';

export function memoryTable(
  bounds: Bounds,
  memoryKeys: Map<string, Map<string, unknown>>,
  selectedSpawnId: string | null,
  theme: Theme,
): DrawCommand[] {
  const commands: DrawCommand[] = [];

  if (!selectedSpawnId) {
    const msg = 'Select a SpawnAgent to view memory';
    commands.push({
      type: 'text',
      x: bounds.x + Math.floor((bounds.width - msg.length) / 2),
      y: bounds.y + Math.floor(bounds.height / 2),
      text: msg,
      style: styled({ fg: theme.colors.muted }),
    });
    return commands;
  }

  const mem = memoryKeys.get(selectedSpawnId);
  if (!mem || mem.size === 0) {
    const msg = '(empty)';
    commands.push({
      type: 'text',
      x: bounds.x + Math.floor((bounds.width - msg.length) / 2),
      y: bounds.y + Math.floor(bounds.height / 2),
      text: msg,
      style: styled({ fg: theme.colors.muted }),
    });
    return commands;
  }

  const entries = [...mem.entries()];
  const maxRows = bounds.height;
  const keyWidth = Math.min(16, Math.floor(bounds.width * 0.4));

  for (let i = 0; i < Math.min(entries.length, maxRows); i++) {
    const [key, value] = entries[i];
    const y = bounds.y + i;
    const isAlt = i % 2 === 1;

    if (isAlt) {
      commands.push({
        type: 'fill',
        bounds: { x: bounds.x, y, width: bounds.width, height: 1 },
        style: { bg: theme.colors.surfaceAlt },
      });
    }

    const shortKey = key.length > keyWidth ? key.slice(0, keyWidth - 1) + '…' : key;
    commands.push({
      type: 'text',
      x: bounds.x + 1,
      y,
      text: shortKey.padEnd(keyWidth + 1),
      style: styled({ fg: theme.colors.info, bg: isAlt ? theme.colors.surfaceAlt : undefined }),
    });

    let valStr = value === null ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    const valMaxLen = bounds.width - keyWidth - 4;
    if (valStr.length > valMaxLen) {
      valStr = valStr.slice(0, valMaxLen - 1) + '…';
    }

    commands.push({
      type: 'text',
      x: bounds.x + keyWidth + 2,
      y,
      text: valStr,
      style: styled({ fg: theme.colors.foreground, bg: isAlt ? theme.colors.surfaceAlt : undefined }),
    });
  }

  return commands;
}
