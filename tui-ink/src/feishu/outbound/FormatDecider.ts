/**
 * FormatDecider — determines whether a reply should go as a text bubble or a
 * rich document card.
 *
 * Code rules override PM's hint; PM's hint is treated as a lower-bound.
 * Add new format-detection rules here — don't scatter them across index.tsx.
 */

/** LaTeX math markers common in engineering/academic content. */
const LATEX_RE =
  /\\\(|\\\)|\$\$|\\\[|\\\]|\\frac\b|\\sum\b|\\int\b|\\begin\{|\\text\{|\\cdot\b|\\times\b|\\sqrt\b|\\alpha\b|\\beta\b|\\theta\b|\\omega\b|\\sigma\b|\\mu\b|\\tau\b/;

/** Markdown table — a separator row with at least two cells. */
const TABLE_RE = /\|[-: ]+\|[-: |]+/;

/** Code fence opening line. */
const CODE_FENCE_RE = /^```/gm;

/** Markdown heading. */
const HEADING_RE = /^#{1,6}\s/gm;

/**
 * Decide the delivery format for a reply.
 *
 * @param text    The full text content (may be a complete document or a short message).
 * @param hint    Optional format tag from the PM's message event.
 * @returns "document" or "text".
 */
export function decideFormat(
  text: string,
  hint?: "text" | "document",
): "text" | "document" {
  // PM explicitly requested document — trust it (it's a lower bound, not overrideable down).
  if (hint === "document") return "document";

  // Hard rules that override "text" hint:
  if (text.length > 800) return "document";
  if (LATEX_RE.test(text)) return "document";
  if (TABLE_RE.test(text)) return "document";

  const headings = text.match(HEADING_RE);
  if (headings && headings.length >= 2) return "document";

  const fences = text.match(CODE_FENCE_RE);
  if (fences && fences.length >= 2) return "document"; // at least one open+close pair

  return hint ?? "text";
}
