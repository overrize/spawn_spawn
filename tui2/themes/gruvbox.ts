import { RGBA, Theme, ThemeColors } from '../engine/types.js';

const colors: ThemeColors = {
  background: RGBA.fromHex("#282828"),
  foreground: RGBA.fromHex("#ebdbb2"),
  accent: RGBA.fromHex("#fabd2f"),
  accentDim: RGBA.fromHex("#7d5e18"),
  success: RGBA.fromHex("#b8bb26"),
  warning: RGBA.fromHex("#fabd2f"),
  error: RGBA.fromHex("#fb4934"),
  info: RGBA.fromHex("#83a598"),
  muted: RGBA.fromHex("#665c54"),
  border: RGBA.fromInts(255, 255, 255, 26),
  surface: RGBA.fromHex("#3c3836"),
  surfaceAlt: RGBA.fromHex("#504945"),
  selectionBg: RGBA.fromHex("#fabd2f"),
  selectionFg: RGBA.fromHex("#282828"),
};

export const gruvbox: Theme = {
  name: "Gruvbox",
  dark: true,
  colors,
};
