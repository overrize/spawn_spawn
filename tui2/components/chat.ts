import { Bounds, DrawCommand, Theme } from '../engine/types.js';
import { styled } from './text.js';

export interface ChatMessage {
  role: 'user' | 'system' | 'error' | 'task';
  content: string;
  timestamp: number;
}

export function chatView(
  bounds: Bounds,
  messages: ChatMessage[],
  inputValue: string,
  inputCursor: number,
  theme: Theme,
): DrawCommand[] {
  const commands: DrawCommand[] = [];

  const maxVisible = bounds.height - 2;
  const visibleMessages = messages.slice(-maxVisible);

  let y = bounds.y;
  for (const msg of visibleMessages) {
    if (y >= bounds.y + bounds.height) break;

    const prefix = msg.role === 'user' ? '> ' : msg.role === 'error' ? '✕ ' : msg.role === 'task' ? '● ' : '  ';
    const prefixStyle = msg.role === 'user'
      ? styled({ fg: theme.colors.accent, bold: true })
      : msg.role === 'error'
      ? styled({ fg: theme.colors.error })
      : msg.role === 'task'
      ? styled({ fg: theme.colors.info })
      : styled({ fg: theme.colors.muted });

    const contentStyle = msg.role === 'user'
      ? styled({ fg: theme.colors.accent })
      : msg.role === 'error'
      ? styled({ fg: theme.colors.error, dim: true })
      : msg.role === 'task'
      ? styled({ fg: theme.colors.info, dim: true })
      : styled({ fg: theme.colors.foreground });

    const maxContentWidth = bounds.width - prefix.length - 2;
    const lines = wrapText(msg.content, maxContentWidth);

    commands.push({ type: 'text', x: bounds.x, y, text: prefix, style: prefixStyle });

    for (let i = 0; i < lines.length; i++) {
      if (y >= bounds.y + bounds.height) break;
      if (i === 0) {
        commands.push({ type: 'text', x: bounds.x + prefix.length, y, text: lines[i], style: contentStyle });
      } else {
        commands.push({ type: 'text', x: bounds.x + 2, y, text: lines[i], style: contentStyle });
      }
      y++;
    }
  }

  const inputY = bounds.y + bounds.height - 1;
  if (inputY > bounds.y) {
    commands.push({
      type: 'fill',
      bounds: { x: bounds.x, y: inputY, width: bounds.width, height: 1 },
      style: { bg: theme.colors.surface },
    });

    const display = `> ${inputValue}`;
    const maxLen = bounds.width - 4;
    const shown = display.length > maxLen
      ? display.slice(display.length - maxLen)
      : display;

    commands.push({
      type: 'text', x: bounds.x + 1, y: inputY,
      text: shown,
      style: styled({ fg: theme.colors.foreground }),
    });

    if (inputValue.length > 0) {
      const cursorX = bounds.x + 3 + Math.min(inputCursor, maxLen - 3);
      const cursorChar = inputValue[inputCursor] || ' ';
      commands.push({
        type: 'text', x: cursorX, y: inputY,
        text: cursorChar,
        style: styled({ fg: theme.colors.selectionFg, bg: theme.colors.selectionBg }),
      });
    }
  }

  return commands;
}

function wrapText(text: string, maxWidth: number): string[] {
  if (text.length <= maxWidth) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > maxWidth) {
    lines.push(remaining.slice(0, maxWidth));
    remaining = remaining.slice(maxWidth);
  }
  if (remaining.length > 0) lines.push(remaining);
  return lines;
}
