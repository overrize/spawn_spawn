import type { Theme } from '../engine/types.js';
import { defaultTheme } from './default.js';
import { dracula } from './dracula.js';
import { nord } from './nord.js';
import { tokyoNight } from './tokyo-night.js';
import { gruvbox } from './gruvbox.js';
import { catppuccin } from './catppuccin.js';
import { paperTheme } from './paper.js';

export const themes: Theme[] = [paperTheme, defaultTheme, dracula, nord, tokyoNight, gruvbox, catppuccin];

export function getTheme(name: string): Theme {
  return themes.find(t => t.name.toLowerCase() === name.toLowerCase()) ?? defaultTheme;
}

export function cycleTheme(current: Theme): Theme {
  const idx = themes.indexOf(current);
  return themes[(idx + 1) % themes.length];
}
