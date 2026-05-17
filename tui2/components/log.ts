import { Bounds, DrawCommand, Theme } from '../engine/types.js';
import { styled, text } from './text.js';

interface LogEvent {
  timestamp: number;
  type: string;
  key?: string;
  value?: unknown;
  agentId?: string;
}

export function eventLog(
  bounds: Bounds,
  events: LogEvent[],
  theme: Theme,
): DrawCommand[] {
  const commands: DrawCommand[] = [];
  if (events.length === 0) {
    const msg = '(no events)';
    commands.push({
      type: 'text',
      x: bounds.x + Math.floor((bounds.width - msg.length) / 2),
      y: bounds.y + Math.floor(bounds.height / 2),
      text: msg,
      style: styled({ fg: theme.colors.muted }),
    });
    return commands;
  }

  const maxEntries = bounds.height;
  const displayEvents = events.slice(0, maxEntries);

  for (let i = 0; i < displayEvents.length; i++) {
    const evt = displayEvents[i];
    const y = bounds.y + i;
    const time = new Date(evt.timestamp).toLocaleTimeString('en-US', { hour12: false });
    const typeColor =
      evt.type === 'memory:set' ? theme.colors.success :
      evt.type === 'memory:delete' ? theme.colors.error :
      evt.type === 'memory:clear' ? theme.colors.warning :
      theme.colors.info;

    const typeLabel = evt.type.replace('memory:', '').toUpperCase();
    let line = `${time} ${typeLabel}`;

    if (evt.key) {
      const shortKey = evt.key.length > 20 ? evt.key.slice(0, 18) + '..' : evt.key;
      line += ` ${shortKey}`;
    }

    if (evt.value !== undefined) {
      let valStr = typeof evt.value === 'object' ? JSON.stringify(evt.value) : String(evt.value);
      if (valStr.length > 20) valStr = valStr.slice(0, 18) + '..';
      line += ` → ${valStr}`;
    }

    if (line.length > bounds.width) {
      line = line.slice(0, bounds.width - 1) + '…';
    }

    commands.push({
      type: 'text',
      x: bounds.x,
      y,
      text: line,
      style: styled({ fg: i % 2 === 0 ? theme.colors.foreground : theme.colors.muted }),
    });
  }

  return commands;
}
