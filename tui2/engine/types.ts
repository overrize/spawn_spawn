/**
 * SpawnTUI — Core Types
 *
 * Zero-dependency TUI framework for the spawn/fork agent orchestration tool.
 * All rendering primitives, color support, and component interfaces.
 */

// ─── Color System ────────────────────────────────────────────

/** RGBA color with float channels (0–1), matching OpenCode's OpenTUI convention */
export interface RGBA {
  r: number; // 0–1
  g: number; // 0–1
  b: number; // 0–1
  a: number; // 0–1 (0 = transparent)
}

/** Terminal color capability tier */
export type ColorDepth = 16 | 256 | "truecolor";

export namespace RGBA {
  export function fromInts(r: number, g: number, b: number, a = 255): RGBA {
    return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
  }
  export function fromHex(hex: string): RGBA {
    const h = hex.replace("#", "");
    if (h.length === 3) {
      return fromInts(
        parseInt(h[0] + h[0], 16),
        parseInt(h[1] + h[1], 16),
        parseInt(h[2] + h[2], 16),
      );
    }
    if (h.length === 6) {
      return fromInts(
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
      );
    }
    if (h.length === 8) {
      return fromInts(
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
        parseInt(h.slice(6, 8), 16),
      );
    }
    // fallback: white
    return fromInts(255, 255, 255);
  }
  export function toANSI(color: RGBA, depth: ColorDepth): string {
    if (color.a === 0) return "";
    const ri = Math.round(color.r * 255);
    const gi = Math.round(color.g * 255);
    const bi = Math.round(color.b * 255);
    if (depth === "truecolor") {
      return `\x1b[38;2;${ri};${gi};${bi}m`;
    }
    if (depth === 256) {
      // 6×6×6 cube: map each channel to 0-5
      const cr = ri > 0 ? Math.min(5, Math.round((ri / 255) * 5)) : 0;
      const cg = gi > 0 ? Math.min(5, Math.round((gi / 255) * 5)) : 0;
      const cb = bi > 0 ? Math.min(5, Math.round((bi / 255) * 5)) : 0;
      const code = 16 + 36 * cr + 6 * cg + cb;
      return `\x1b[38;5;${code}m`;
    }
    // 16-color: find closest ANSI color
    const ansi = closest16(ri, gi, bi);
    return `\x1b[${ansi}m`;
  }
  export function toANSI_BG(color: RGBA, depth: ColorDepth): string {
    if (color.a === 0) return "";
    const ri = Math.round(color.r * 255);
    const gi = Math.round(color.g * 255);
    const bi = Math.round(color.b * 255);
    if (depth === "truecolor") {
      return `\x1b[48;2;${ri};${gi};${bi}m`;
    }
    if (depth === 256) {
      const cr = ri > 0 ? Math.min(5, Math.round((ri / 255) * 5)) : 0;
      const cg = gi > 0 ? Math.min(5, Math.round((gi / 255) * 5)) : 0;
      const cb = bi > 0 ? Math.min(5, Math.round((bi / 255) * 5)) : 0;
      const code = 16 + 36 * cr + 6 * cg + cb;
      return `\x1b[48;5;${code}m`;
    }
    const ansi = closest16(ri, gi, bi);
    return `\x1b[${ansi + 10}m`; // BG variants are +10
  }

  function closest16(r: number, g: number, b: number): number {
    // ANSI 16-color palette: 0-7 dark, 8-15 bright
    const colors: [number, number, number][] = [
      [0, 0, 0],       // 30 black
      [205, 0, 0],     // 31 red
      [0, 205, 0],     // 32 green
      [205, 205, 0],   // 33 yellow
      [0, 0, 238],     // 34 blue
      [205, 0, 205],   // 35 magenta
      [0, 205, 205],   // 36 cyan
      [229, 229, 229], // 37 white
      [127, 127, 127], // 90 bright black
      [255, 0, 0],     // 91 bright red
      [0, 255, 0],     // 92 bright green
      [255, 255, 0],   // 93 bright yellow
      [92, 92, 255],   // 94 bright blue
      [255, 0, 255],   // 95 bright magenta
      [0, 255, 255],   // 96 bright cyan
      [255, 255, 255], // 97 bright white
    ];
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < colors.length; i++) {
      const dr = r - colors[i][0];
      const dg = g - colors[i][1];
      const db = b - colors[i][2];
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        best = i < 8 ? 30 + i : 90 + (i - 8);
      }
    }
    return best;
  }
}

// ─── Cell & Buffer ───────────────────────────────────────────

/** Text style modifiers */
export interface TextStyle {
  fg?: RGBA;
  bg?: RGBA;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

/** A single terminal cell in the render buffer */
export interface Cell {
  char: string;       // Single character, or '' for empty
  fg?: RGBA;
  bg?: RGBA;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

/** 2D cell buffer — the rendered output surface */
export class CellBuffer {
  readonly width: number;
  readonly height: number;
  private cells: Cell[][];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = [];
    for (let y = 0; y < height; y++) {
      const row: Cell[] = [];
      for (let x = 0; x < width; x++) {
        row.push(emptyCell());
      }
      this.cells.push(row);
    }
  }

  get(x: number, y: number): Cell {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return emptyCell();
    return this.cells[y][x];
  }

  set(x: number, y: number, cell: Partial<Cell>): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const existing = this.cells[y][x];
    this.cells[y][x] = {
      char: cell.char ?? existing.char,
      fg: cell.fg !== undefined ? cell.fg : existing.fg,
      bg: cell.bg !== undefined ? cell.bg : existing.bg,
      bold: cell.bold ?? existing.bold,
      dim: cell.dim ?? existing.dim,
      italic: cell.italic ?? existing.italic,
      underline: cell.underline ?? existing.underline,
      inverse: cell.inverse ?? existing.inverse,
    };
  }

  /** Write a string at position with style */
  writeString(x: number, y: number, str: string, style?: TextStyle): void {
    let cx = x;
    for (let i = 0; i < str.length; i++) {
      if (cx >= this.width) break;
      if (str[i] === "\n") continue;
      if (str[i] === "\x1b") {
        // Skip ANSI escape sequences in raw strings
        let j = i + 1;
        while (j < str.length && str[j] !== "m") j++;
        i = j;
        continue;
      }
      this.set(cx, y, { char: str[i], ...style });
      cx++;
    }
  }

  /** Fill a rectangle with a cell template */
  fill(x: number, y: number, w: number, h: number, cell: Partial<Cell>): void {
    for (let cy = y; cy < y + h && cy < this.height; cy++) {
      for (let cx = x; cx < x + w && cx < this.width; cx++) {
        this.set(cx, cy, cell);
      }
    }
  }

  /** Resize the buffer (re-allocates) */
  resize(width: number, height: number): CellBuffer {
    const buf = new CellBuffer(width, height);
    for (let y = 0; y < Math.min(this.height, height); y++) {
      for (let x = 0; x < Math.min(this.width, width); x++) {
        buf.cells[y][x] = { ...this.cells[y][x] };
      }
    }
    return buf;
  }

  /** Clone the entire buffer */
  clone(): CellBuffer {
    const buf = new CellBuffer(this.width, this.height);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        buf.cells[y][x] = { ...this.cells[y][x] };
      }
    }
    return buf;
  }

  get rows(): Cell[][] {
    return this.cells;
  }
}

function emptyCell(): Cell {
  return { char: " ", fg: undefined, bg: undefined, bold: false, dim: false, italic: false, underline: false, inverse: false };
}

// ─── Layout ───────────────────────────────────────────────────

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export namespace Bounds {
  export function shrink(b: Bounds, top: number, right: number, bottom: number, left: number): Bounds {
    return {
      x: b.x + left,
      y: b.y + top,
      width: Math.max(0, b.width - left - right),
      height: Math.max(0, b.height - top - bottom),
    };
  }
}

// ─── Draw Commands ────────────────────────────────────────────

export type DrawCommand =
  | { type: "text"; x: number; y: number; text: string; style?: TextStyle }
  | { type: "box"; bounds: Bounds; border?: BorderStyle; title?: string; titleStyle?: TextStyle }
  | { type: "fill"; bounds: Bounds; style: TextStyle }
  | { type: "hline"; x: number; y: number; width: number; char?: string; style?: TextStyle }
  | { type: "vline"; x: number; y: number; height: number; char?: string; style?: TextStyle };

export interface BorderStyle {
  topLeft?: string;
  top?: string;
  topRight?: string;
  right?: string;
  bottomRight?: string;
  bottom?: string;
  bottomLeft?: string;
  left?: string;
}

// ─── Key Input ────────────────────────────────────────────────

export interface ParsedKey {
  name: string;          // "a", "enter", "escape", "up", etc.
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  sequence: string;      // Raw byte sequence
}

export type KeyAction = string;

export interface Keybinding {
  key: string;           // "ctrl+k", "escape", "g g"
  action: KeyAction;
  description: string;
}

// ─── Theme ────────────────────────────────────────────────────

export interface ThemeColors {
  background: RGBA;
  foreground: RGBA;
  accent: RGBA;          // primary highlight (gold/amber)
  accentDim: RGBA;
  success: RGBA;         // green (RUNNING)
  warning: RGBA;         // yellow (PAUSED)
  error: RGBA;           // red (ERROR/TERMINATED)
  info: RGBA;            // cyan (memory keys)
  muted: RGBA;           // dim gray (inactive text)
  border: RGBA;          // panel borders
  surface: RGBA;         // panel backgrounds
  surfaceAlt: RGBA;      // alternating rows
  selectionBg: RGBA;     // selected item background
  selectionFg: RGBA;     // selected item foreground
}

export interface Theme {
  name: string;
  dark: boolean;
  colors: ThemeColors;
}

// ─── ANSI Constants ───────────────────────────────────────────

export const ANSI = {
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  ITALIC: "\x1b[3m",
  UNDERLINE: "\x1b[4m",
  INVERSE: "\x1b[7m",
  HIDE_CURSOR: "\x1b[?25l",
  SHOW_CURSOR: "\x1b[?25h",
  ALT_SCREEN: "\x1b[?1049h",
  NORMAL_SCREEN: "\x1b[?1049l",
  CLEAR_SCREEN: "\x1b[2J",
  CLEAR_LINE: "\x1b[2K",
  CURSOR_HOME: "\x1b[H",
  ENABLE_MOUSE: "\x1b[?1000h\x1b[?1002h\x1b[?1015h\x1b[?1006h",
  DISABLE_MOUSE: "\x1b[?1000l\x1b[?1002l\x1b[?1015l\x1b[?1006l",
  ENABLE_KITTY: "\x1b[>1u",
  DISABLE_KITTY: "\x1b[<u",
  cursorTo(x: number, y: number): string {
    return `\x1b[${y + 1};${x + 1}H`;
  },
} as const;
