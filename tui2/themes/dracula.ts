import { RGBA, Theme, ThemeColors } from '../engine/types.js';

const colors: ThemeColors = {
  background: RGBA.fromHex("#282a36"),
  foreground: RGBA.fromHex("#f8f8f2"),
  accent: RGBA.fromHex("#bd93f9"),
  accentDim: RGBA.fromHex("#5e4a7c"),
  success: RGBA.fromHex("#50fa7b"),
  warning: RGBA.fromHex("#f1fa8c"),
  error: RGBA.fromHex("#ff5555"),
  info: RGBA.fromHex("#8be9fd"),
  muted: RGBA.fromHex("#6272a4"),
  border: RGBA.fromInts(255, 255, 255, 26),
  surface: RGBA.fromHex("#1e1f29"),
  surfaceAlt: RGBA.fromHex("#2c2e3a"),
  selectionBg: RGBA.fromHex("#bd93f9"),
  selectionFg: RGBA.fromHex("#282a36"),
};

export const dracula: Theme = {
  name: "Dracula",
  dark: true,
  colors,
};
