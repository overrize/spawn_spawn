import { ANSI, BorderStyle, Bounds, Cell, CellBuffer, ColorDepth, DrawCommand, RGBA, TextStyle } from "./types.js";

function rgbaEqual(a?: RGBA, b?: RGBA): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

function cellsDiffer(a: Cell, b: Cell): boolean {
  if (a.char !== b.char) return true;
  if (a.bold !== b.bold) return true;
  if (a.dim !== b.dim) return true;
  if (a.italic !== b.italic) return true;
  if (a.underline !== b.underline) return true;
  if (a.inverse !== b.inverse) return true;
  if (!rgbaEqual(a.fg, b.fg)) return true;
  if (!rgbaEqual(a.bg, b.bg)) return true;
  return false;
}

export class Renderer {
  private width: number;
  private height: number;
  private colorDepth: ColorDepth;
  private backBuffer: CellBuffer;
  private frontBuffer: CellBuffer;
  private ansiCache = new Map<string, string>();
  private ansiBgCache = new Map<string, string>();

  constructor(width: number, height: number, colorDepth?: ColorDepth) {
    this.width = width;
    this.height = height;
    this.colorDepth = colorDepth ?? this.detectColorDepth();
    this.backBuffer = new CellBuffer(width, height);
    this.frontBuffer = new CellBuffer(width, height);
  }

  detectColorDepth(): ColorDepth {
    const ct = process.env.COLORTERM;
    if (ct === "truecolor" || ct === "24bit") return "truecolor";
    const tp = process.env.TERM_PROGRAM;
    if (tp === "iTerm.app" || tp === "Apple_Terminal" || tp === "Hyper" || tp === "WezTerm" || tp === "vscode") {
      return "truecolor";
    }
    return 256;
  }

  getColorDepth(): ColorDepth {
    return this.colorDepth;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.backBuffer = new CellBuffer(width, height);
    this.frontBuffer = new CellBuffer(width, height);
  }

  clear(): void {
    this.backBuffer = new CellBuffer(this.width, this.height);
  }

  draw(cmd: DrawCommand): void {
    switch (cmd.type) {
      case "text":
        this.backBuffer.writeString(cmd.x, cmd.y, cmd.text, cmd.style);
        break;
      case "box":
        this.drawBox(cmd);
        break;
      case "fill":
        this.backBuffer.fill(cmd.bounds.x, cmd.bounds.y, cmd.bounds.width, cmd.bounds.height, this.styleToCell(cmd.style));
        break;
      case "hline":
        this.drawHLine(cmd);
        break;
      case "vline":
        this.drawVLine(cmd);
        break;
    }
  }

  flush(): void {
    const back = this.backBuffer;
    const front = this.frontBuffer;
    const total = back.width * back.height;
    let changedCount = 0;

    for (let y = 0; y < back.height; y++) {
      for (let x = 0; x < back.width; x++) {
        if (cellsDiffer(back.get(x, y), front.get(x, y))) {
          changedCount++;
        }
      }
    }

    let output = "";

    if (changedCount > total * 0.5) {
      output += ANSI.CLEAR_SCREEN + ANSI.CURSOR_HOME;
      for (let y = 0; y < back.height; y++) {
        output += ANSI.cursorTo(0, y);
        output += ANSI.RESET;
        let currentSGR = "";
        for (let x = 0; x < back.width; x++) {
          const cell = back.get(x, y);
          const sgr = this.buildSGR(cell);
          if (sgr !== currentSGR) {
            if (currentSGR !== "") output += ANSI.RESET;
            output += sgr;
            currentSGR = sgr;
          }
          output += cell.char || " ";
        }
      }
    } else {
      for (let y = 0; y < back.height; y++) {
        let runActive = false;
        let currentSGR = "";
        for (let x = 0; x < back.width; x++) {
          const b = back.get(x, y);
          const f = front.get(x, y);
          if (!cellsDiffer(b, f)) {
            runActive = false;
            currentSGR = "";
            continue;
          }
          if (!runActive) {
            output += ANSI.cursorTo(x, y);
            output += ANSI.RESET;
            currentSGR = "";
            runActive = true;
          }
          const sgr = this.buildSGR(b);
          if (sgr !== currentSGR) {
            if (currentSGR !== "") output += ANSI.RESET;
            output += sgr;
            currentSGR = sgr;
          }
          output += b.char || " ";
        }
      }
    }

    output += ANSI.cursorTo(0, 0);
    process.stdout.write(output);

    this.frontBuffer = back;
    this.backBuffer = new CellBuffer(this.width, this.height);
  }

  flushToString(): string {
    const back = this.backBuffer;
    let output = ANSI.CLEAR_SCREEN + ANSI.CURSOR_HOME;
    for (let y = 0; y < back.height; y++) {
      output += ANSI.cursorTo(0, y);
      output += ANSI.RESET;
      let currentSGR = '';
      for (let x = 0; x < back.width; x++) {
        const cell = back.get(x, y);
        const sgr = this.buildSGR(cell);
        if (sgr !== currentSGR) {
          if (currentSGR !== '') output += ANSI.RESET;
          output += sgr;
          currentSGR = sgr;
        }
        output += cell.char || ' ';
      }
    }
    output += ANSI.RESET;
    return output;
  }

  private buildSGR(cell: Cell): string {
    const parts: string[] = [];
    if (cell.bold) parts.push("1");
    if (cell.dim) parts.push("2");
    if (cell.italic) parts.push("3");
    if (cell.underline) parts.push("4");
    if (cell.inverse) parts.push("7");

    if (cell.fg && cell.fg.a > 0) {
      parts.push(this.getAnsi(cell.fg).slice(2, -1));
    }
    if (cell.bg && cell.bg.a > 0) {
      parts.push(this.getAnsiBg(cell.bg).slice(2, -1));
    }

    if (parts.length === 0) return "";
    return `\x1b[${parts.join(";")}m`;
  }

  private getAnsi(color: RGBA): string {
    const key = `${this.colorDepth}:${color.r},${color.g},${color.b},${color.a}`;
    let cached = this.ansiCache.get(key);
    if (!cached) {
      cached = RGBA.toANSI(color, this.colorDepth);
      this.ansiCache.set(key, cached);
    }
    return cached;
  }

  private getAnsiBg(color: RGBA): string {
    const key = `${this.colorDepth}:${color.r},${color.g},${color.b},${color.a}`;
    let cached = this.ansiBgCache.get(key);
    if (!cached) {
      cached = RGBA.toANSI_BG(color, this.colorDepth);
      this.ansiBgCache.set(key, cached);
    }
    return cached;
  }

  private styleToCell(style?: TextStyle): Partial<Cell> {
    if (!style) return {};
    return {
      fg: style.fg,
      bg: style.bg,
      bold: style.bold,
      dim: style.dim,
      italic: style.italic,
      underline: style.underline,
      inverse: style.inverse,
    };
  }

  private drawBox(cmd: { type: "box"; bounds: Bounds; border?: BorderStyle; title?: string; titleStyle?: TextStyle }): void {
    const b = cmd.bounds;
    const s = cmd.border || {};
    const tl = s.topLeft ?? "┌";
    const t = s.top ?? "─";
    const tr = s.topRight ?? "┐";
    const r = s.right ?? "│";
    const br = s.bottomRight ?? "┘";
    const bot = s.bottom ?? "─";
    const bl = s.bottomLeft ?? "└";
    const l = s.left ?? "│";

    const borderStyle = this.styleToCell(cmd.titleStyle);

    for (let x = 0; x < b.width; x++) {
      let char = t;
      if (x === 0) char = tl;
      else if (x === b.width - 1) char = tr;
      this.backBuffer.set(b.x + x, b.y, { char, ...borderStyle });
    }

    if (cmd.title && b.width > 2) {
      const title = " " + cmd.title + " ";
      const startX = b.x + 2;
      for (let i = 0; i < title.length && startX + i < b.x + b.width - 1; i++) {
        this.backBuffer.set(startX + i, b.y, { char: title[i], ...this.styleToCell(cmd.titleStyle) });
      }
    }

    for (let x = 0; x < b.width; x++) {
      let char = bot;
      if (x === 0) char = bl;
      else if (x === b.width - 1) char = br;
      this.backBuffer.set(b.x + x, b.y + b.height - 1, { char, ...borderStyle });
    }

    for (let y = 1; y < b.height - 1; y++) {
      this.backBuffer.set(b.x, b.y + y, { char: l, ...borderStyle });
      this.backBuffer.set(b.x + b.width - 1, b.y + y, { char: r, ...borderStyle });
    }
  }

  private drawHLine(cmd: { type: "hline"; x: number; y: number; width: number; char?: string; style?: TextStyle }): void {
    const char = cmd.char ?? "─";
    const style = this.styleToCell(cmd.style);
    for (let i = 0; i < cmd.width; i++) {
      this.backBuffer.set(cmd.x + i, cmd.y, { char, ...style });
    }
  }

  private drawVLine(cmd: { type: "vline"; x: number; y: number; height: number; char?: string; style?: TextStyle }): void {
    const char = cmd.char ?? "│";
    const style = this.styleToCell(cmd.style);
    for (let i = 0; i < cmd.height; i++) {
      this.backBuffer.set(cmd.x, cmd.y + i, { char, ...style });
    }
  }
}
