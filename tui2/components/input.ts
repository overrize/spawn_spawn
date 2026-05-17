import { Bounds, DrawCommand, Theme } from '../engine/types.js';
import { styled } from './text.js';

export interface InputState {
  visible: boolean;
  prompt: string;
  value: string;
  cursor: number;
}

export function footerBar(bounds: Bounds, state: InputState, theme: Theme): DrawCommand[] {
  const commands: DrawCommand[] = [];

  commands.push({ type: 'fill', bounds, style: { bg: theme.colors.surface } });

  if (state.visible) {
    const display = `${state.prompt} ${state.value}`;
    const maxLen = bounds.width - 4;
    const shown = display.length > maxLen
      ? display.slice(display.length - maxLen)
      : display;

    commands.push({
      type: 'text', x: bounds.x + 1, y: bounds.y,
      text: shown,
      style: styled({ fg: theme.colors.foreground }),
    });

    if (state.value.length > 0) {
      const cursorX = bounds.x + state.prompt.length + 2 + Math.min(state.cursor, maxLen - state.prompt.length - 2);
      const cursorChar = state.value[state.cursor] || ' ';
      commands.push({
        type: 'text', x: cursorX, y: bounds.y,
        text: cursorChar,
        style: styled({ fg: theme.colors.selectionFg, bg: theme.colors.selectionBg }),
      });
    }
  } else {
    const hints = [
      { key: 's', desc: 'spawn', color: theme.colors.accent },
      { key: 'f', desc: 'fork', color: theme.colors.info },
      { key: 'p', desc: 'pause', color: theme.colors.warning },
      { key: 'r', desc: 'resume', color: theme.colors.success },
      { key: 't', desc: 'term', color: theme.colors.error },
      { key: 'v', desc: 'view', color: theme.colors.muted },
      { key: '/', desc: 'cmds', color: theme.colors.accent },
      { key: 'q', desc: 'quit', color: theme.colors.muted },
    ];

    let x = bounds.x + 1;
    for (const h of hints) {
      const segment = ` ${h.key}:`;
      commands.push({ type: 'text', x, y: bounds.y, text: segment, style: styled({ fg: h.color, bold: true }) });
      x += segment.length;
      commands.push({ type: 'text', x, y: bounds.y, text: h.desc, style: styled({ fg: theme.colors.muted, dim: true }) });
      x += h.desc.length;
    }
  }

  return commands;
}

export function commandInput(bounds: Bounds, state: InputState, theme: Theme): DrawCommand[] {
  return footerBar(bounds, state, theme);
}

export interface PaletteItem {
  key: string;
  label: string;
  description: string;
  action: string;
}

export function commandPalette(
  bounds: Bounds,
  items: PaletteItem[],
  query: string,
  selectedIdx: number,
  theme: Theme,
): DrawCommand[] {
  const commands: DrawCommand[] = [];

  const filtered = query
    ? items.filter(i =>
        i.label.toLowerCase().includes(query.toLowerCase()) ||
        i.description.toLowerCase().includes(query.toLowerCase()))
    : items;

  const dialogW = Math.min(50, bounds.width - 6);
  const maxItems = Math.min(filtered.length, bounds.height - 4);
  const dialogH = maxItems + 4;
  const dx = bounds.x + Math.floor((bounds.width - dialogW) / 2);
  const dy = bounds.y + Math.floor((bounds.height - dialogH) / 2);

  commands.push({
    type: 'fill',
    bounds: { x: 0, y: 0, width: bounds.width, height: bounds.height },
    style: { bg: { r: 0, g: 0, b: 0, a: 0.5 } },
  });

  commands.push({
    type: 'box',
    bounds: { x: dx, y: dy, width: dialogW, height: dialogH },
    border: { topLeft: '┌', top: '─', topRight: '┐', right: '│', bottomRight: '┘', bottom: '─', bottomLeft: '└', left: '│' },
    title: ' Commands ',
    titleStyle: { fg: theme.colors.accent },
  });

  commands.push({
    type: 'text', x: dx + 2, y: dy + 1,
    text: `> ${query}`,
    style: styled({ fg: theme.colors.accent }),
  });

  for (let i = 0; i < maxItems; i++) {
    const item = filtered[i];
    const isSel = i === selectedIdx;
    const y = dy + 2 + i;

    if (isSel) {
      commands.push({
        type: 'fill',
        bounds: { x: dx + 1, y, width: dialogW - 2, height: 1 },
        style: { bg: theme.colors.selectionBg },
      });
    }

    commands.push({
      type: 'text', x: dx + 2, y,
      text: ` ${item.key.padEnd(6)} ${item.label.padEnd(18)} ${item.description}`,
      style: styled({
        fg: isSel ? theme.colors.selectionFg : theme.colors.foreground,
        bg: isSel ? theme.colors.selectionBg : undefined,
        dim: !isSel,
      }),
    });
  }

  return commands;
}

export function promptDialog(
  bounds: Bounds,
  title: string,
  value: string,
  cursor: number,
  theme: Theme,
): DrawCommand[] {
  const commands: DrawCommand[] = [];
  const dialogW = Math.min(60, bounds.width - 4);
  const dialogH = 5;
  const dx = bounds.x + Math.floor((bounds.width - dialogW) / 2);
  const dy = bounds.y + Math.floor((bounds.height - dialogH) / 2);

  commands.push({
    type: 'box',
    bounds: { x: dx, y: dy, width: dialogW, height: dialogH },
    border: { topLeft: '┌', top: '─', topRight: '┐', right: '│', bottomRight: '┘', bottom: '─', bottomLeft: '└', left: '│' },
    title,
    titleStyle: { fg: theme.colors.accent },
  });

  commands.push({
    type: 'fill',
    bounds: { x: dx + 1, y: dy + 2, width: dialogW - 2, height: 1 },
    style: { bg: theme.colors.surfaceAlt },
  });

  const displayVal = value.length > dialogW - 4
    ? value.slice(value.length - (dialogW - 4))
    : value;
  commands.push({
    type: 'text', x: dx + 2, y: dy + 2,
    text: displayVal,
    style: styled({ fg: theme.colors.foreground }),
  });

  const cursorX = dx + 2 + Math.min(cursor, dialogW - 5);
  const cursorChar = value[cursor] || ' ';
  commands.push({
    type: 'text', x: cursorX, y: dy + 2,
    text: cursorChar,
    style: styled({ fg: theme.colors.selectionFg, bg: theme.colors.selectionBg }),
  });

  return commands;
}
