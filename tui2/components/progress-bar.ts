import { Bounds, DrawCommand, Theme, TextStyle } from '../engine/types.js';
import { styled } from './text.js';

export function progressBar(
  bounds: Bounds,
  percent: number,
  theme: Theme,
  options?: { showLabel?: boolean; label?: string; barWidth?: number },
): DrawCommand[] {
  const commands: DrawCommand[] = [];
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const barW = options?.barWidth ?? (bounds.width - 8);
  const filled = Math.round((barW * p) / 100);
  const empty = barW - filled;

  const colors: Record<string, TextStyle> = {
    safe: styled({ fg: theme.colors.success }),
    warn: styled({ fg: theme.colors.warning }),
    danger: styled({ fg: theme.colors.error }),
  };

  const style = p < 60 ? colors.safe : p < 85 ? colors.warn : colors.danger;

  let x = bounds.x;

  if (options?.showLabel && options?.label) {
    const label = options.label.length > 8 ? options.label.slice(0, 7) + '…' : options.label;
    commands.push({ type: 'text', x, y: bounds.y, text: label.padEnd(9), style: styled({ fg: theme.colors.muted, dim: true }) });
    x += 9;
  }

  commands.push({ type: 'text', x, y: bounds.y, text: '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']', style });

  const pctStr = ` ${p}%`;
  const pctX = x + barW + 2;
  if (pctX + pctStr.length <= bounds.x + bounds.width) {
    commands.push({ type: 'text', x: pctX, y: bounds.y, text: pctStr, style: styled({ fg: theme.colors.muted, dim: true }) });
  }

  return commands;
}

export function resourceGauge(
  bounds: Bounds,
  used: number,
  max: number,
  theme: Theme,
  label: string,
): DrawCommand[] {
  const commands: DrawCommand[] = [];
  const p = max > 0 ? (used / max) * 100 : 0;

  const shortLabel = label.length > 8 ? label.slice(0, 7) + '…' : label;
  commands.push({
    type: 'text',
    x: bounds.x,
    y: bounds.y,
    text: shortLabel.padEnd(9),
    style: styled({ fg: theme.colors.muted, dim: true }),
  });

  const barStart = bounds.x + 9;
  const barW = Math.max(4, bounds.width - 20);
  const filled = Math.round((barW * Math.min(p, 100)) / 100);

  const colors: Record<string, TextStyle> = {
    safe: styled({ fg: theme.colors.success }),
    warn: styled({ fg: theme.colors.warning }),
    danger: styled({ fg: theme.colors.error }),
  };
  const style = p < 60 ? colors.safe : p < 85 ? colors.warn : colors.danger;

  commands.push({ type: 'text', x: barStart, y: bounds.y, text: '█'.repeat(filled) + '░'.repeat(barW - filled), style });

  const infoStr = `${used}/${max}`;
  commands.push({
    type: 'text',
    x: barStart + barW + 1,
    y: bounds.y,
    text: infoStr,
    style: styled({ fg: theme.colors.foreground, dim: true }),
  });

  return commands;
}

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
