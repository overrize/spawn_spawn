import { RGBA, Theme, ThemeColors } from '../engine/types.js';

const colors: ThemeColors = {
  background: RGBA.fromHex("#1e1e2e"),
  foreground: RGBA.fromHex("#cdd6f4"),
  accent: RGBA.fromHex("#cba6f7"),
  accentDim: RGBA.fromHex("#65537b"),
  success: RGBA.fromHex("#a6e3a1"),
  warning: RGBA.fromHex("#f9e2af"),
  error: RGBA.fromHex("#f38ba8"),
  info: RGBA.fromHex("#89dceb"),
  muted: RGBA.fromHex("#6c7086"),
  border: RGBA.fromInts(255, 255, 255, 26),
  surface: RGBA.fromHex("#181825"),
  surfaceAlt: RGBA.fromHex("#313244"),
  selectionBg: RGBA.fromHex("#cba6f7"),
  selectionFg: RGBA.fromHex("#1e1e2e"),
};

export const catppuccin: Theme = {
  name: "Catppuccin",
  dark: true,
  colors,
};
