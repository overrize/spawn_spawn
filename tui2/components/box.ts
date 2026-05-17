import { Bounds, DrawCommand, Theme } from "../engine/types.js";

export function box(
  bounds: Bounds,
  theme: Theme,
  options?: {
    title?: string;
    border?: import("../engine/types.js").BorderStyle;
    padding?: number;
    titleAccent?: boolean;
  },
): DrawCommand[] {
  const { x, y, width, height } = bounds;
  if (width < 2 || height < 2) return [];

  const cmds: DrawCommand[] = [];
  const borderFg = theme.colors.border;
  const titleFg = options?.titleAccent ? theme.colors.accent : theme.colors.border;
  const b = options?.border ?? {};

  const tl = b.topLeft ?? "┌";
  const tr = b.topRight ?? "┐";
  const bl = b.bottomLeft ?? "└";
  const br = b.bottomRight ?? "┘";
  const h = b.top ?? "─";
  const v = b.left ?? "│";
  const rightChar = b.right ?? "│";
  const bottomChar = b.bottom ?? "─";

  const title = options?.title;
  if (title && width > title.length + 4) {
    const prefix = tl + " " + title + " ";
    const suffixLen = width - prefix.length - 1;
    const suffix = h.repeat(Math.max(0, suffixLen)) + tr;
    cmds.push({ type: "text", x, y, text: prefix, style: { fg: titleFg } });
    cmds.push({ type: "text", x: x + prefix.length, y, text: suffix, style: { fg: borderFg } });
  } else {
    const top = tl + h.repeat(Math.max(0, width - 2)) + tr;
    cmds.push({ type: "text", x, y, text: top, style: { fg: borderFg } });
  }

  for (let row = 1; row < height - 1; row++) {
    cmds.push({ type: "text", x, y: y + row, text: v, style: { fg: borderFg } });
    cmds.push({ type: "text", x: x + width - 1, y: y + row, text: rightChar, style: { fg: borderFg } });
  }

  const bottom = bl + bottomChar.repeat(Math.max(0, width - 2)) + br;
  cmds.push({ type: "text", x, y: y + height - 1, text: bottom, style: { fg: borderFg } });

  return cmds;
}
