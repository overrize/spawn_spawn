/**
 * CJK-safe display-width primitives — the canonical home for the new TUI.
 *
 * The old 3-pane layout misaligned dividers because widths were computed with
 * `.length` (JS code units) while the terminal renders CJK/emoji as 2 columns.
 * Every render path in src/tui/ MUST route through these so borders align
 * regardless of script. (spawn-1.0 M3-7b-view)
 */

/** Terminal columns a single codepoint occupies (0 for control, 2 for wide). */
export function charWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals + Kangxi
    (cp >= 0x3040 && cp <= 0x33ff) || // Kana, Bopomofo, CJK compat
    (cp >= 0x3400 && cp <= 0x9fff) || // CJK Ext-A + Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe10 && cp <= 0xfe6f) || // Vertical/CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Latin/punctuation
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth Signs
    (cp >= 0x1f300 && cp <= 0x1faff)  // Emoji block
  ) return 2;
  return cp >= 0x20 ? 1 : 0;
}

/** Total display width of a string. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/** Truncate to at most `cols` display columns, adding … if cut. Never exceeds cols. */
export function truncateToWidth(s: string, cols: number): string {
  if (cols <= 0) return "";
  if (displayWidth(s) <= cols) return s;
  const ell = "…"; // width 1
  const budget = cols - 1;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + ell;
}

/** Pad (or truncate) to EXACTLY `cols` display columns. Right-pad with spaces. */
export function padToWidth(s: string, cols: number): string {
  const truncated = truncateToWidth(s, cols);
  const gap = cols - displayWidth(truncated);
  return truncated + (gap > 0 ? " ".repeat(gap) : "");
}

/** Hard-wrap to `cols` display columns, breaking mid-word if needed. */
export function wrapToWidth(s: string, cols: number): string[] {
  if (cols <= 0) return [s];
  if (s === "") return [""];
  const out: string[] = [];
  let line = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > cols) {
      out.push(line);
      line = ch;
      w = cw;
    } else {
      line += ch;
      w += cw;
    }
  }
  out.push(line);
  return out;
}
