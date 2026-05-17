import { RGBA, Theme, ThemeColors } from '../engine/types.js';

const colors: ThemeColors = {
  background: RGBA.fromHex("#2e3440"),
  foreground: RGBA.fromHex("#d8dee9"),
  accent: RGBA.fromHex("#88c0d0"),
  accentDim: RGBA.fromHex("#446068"),
  success: RGBA.fromHex("#a3be8c"),
  warning: RGBA.fromHex("#ebcb8b"),
  error: RGBA.fromHex("#bf616a"),
  info: RGBA.fromHex("#81a1c1"),
  muted: RGBA.fromHex("#4c566a"),
  border: RGBA.fromInts(255, 255, 255, 26),
  surface: RGBA.fromHex("#3b4252"),
  surfaceAlt: RGBA.fromHex("#434c5e"),
  selectionBg: RGBA.fromHex("#88c0d0"),
  selectionFg: RGBA.fromHex("#2e3440"),
};

export const nord: Theme = {
  name: "Nord",
  dark: true,
  colors,
};
