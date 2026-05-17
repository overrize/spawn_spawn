import { RGBA, Theme, ThemeColors } from '../engine/types.js';

const colors: ThemeColors = {
  background: RGBA.fromHex("#050910"),
  foreground: RGBA.fromHex("#e6ecf5"),
  accent: RGBA.fromHex("#f0a500"),
  accentDim: RGBA.fromHex("#7a6018"),
  success: RGBA.fromHex("#22c55e"),
  warning: RGBA.fromHex("#eab308"),
  error: RGBA.fromHex("#ef4444"),
  info: RGBA.fromHex("#2dd4bf"),
  muted: RGBA.fromHex("#505b73"),
  border: RGBA.fromInts(255, 255, 255, 28),
  surface: RGBA.fromInts(15, 22, 39),
  surfaceAlt: RGBA.fromInts(21, 29, 48),
  selectionBg: RGBA.fromHex("#f0a500"),
  selectionFg: RGBA.fromHex("#050910"),
};

export const dark: Theme = {
  name: "Spawn Dark",
  dark: true,
  colors,
};

export const defaultTheme = dark;
