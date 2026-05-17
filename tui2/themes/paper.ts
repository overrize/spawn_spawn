import { RGBA, Theme, ThemeColors } from '../engine/types.js';

const colors: ThemeColors = {
  background:  RGBA.fromHex('#1a1813'),
  foreground:  RGBA.fromHex('#e8dfc8'),
  accent:      RGBA.fromHex('#c49a3c'),
  accentDim:   RGBA.fromHex('#7a6020'),
  success:     RGBA.fromHex('#5a9e5a'),
  warning:     RGBA.fromHex('#c49a3c'),
  error:       RGBA.fromHex('#c05050'),
  info:        RGBA.fromHex('#5a8e9e'),
  muted:       RGBA.fromHex('#7a7060'),
  border:      RGBA.fromHex('#3a3428'),
  surface:     RGBA.fromHex('#222018'),
  surfaceAlt:  RGBA.fromHex('#282520'),
  selectionBg: RGBA.fromHex('#3a2e10'),
  selectionFg: RGBA.fromHex('#e8dfc8'),
};

export const paperTheme: Theme = { name: 'Paper', dark: true, colors };
