import { RGBA, Theme, ThemeColors } from '../engine/types.js';

const colors: ThemeColors = {
  background: RGBA.fromHex("#1a1b26"),
  foreground: RGBA.fromHex("#c0caf5"),
  accent: RGBA.fromHex("#7aa2f7"),
  accentDim: RGBA.fromHex("#3d517b"),
  success: RGBA.fromHex("#9ece6a"),
  warning: RGBA.fromHex("#e0af68"),
  error: RGBA.fromHex("#f7768e"),
  info: RGBA.fromHex("#7dcfff"),
  muted: RGBA.fromHex("#565f89"),
  border: RGBA.fromInts(255, 255, 255, 26),
  surface: RGBA.fromHex("#16161e"),
  surfaceAlt: RGBA.fromHex("#1f2131"),
  selectionBg: RGBA.fromHex("#7aa2f7"),
  selectionFg: RGBA.fromHex("#1a1b26"),
};

export const tokyoNight: Theme = {
  name: "Tokyo Night",
  dark: true,
  colors,
};
