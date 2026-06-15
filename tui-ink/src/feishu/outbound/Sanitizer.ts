/**
 * Sanitizer — cleans reply text before delivery.
 *
 * Rules:
 *  - Always: unescape literal \\n / \\t produced by JSON-outputting LLMs.
 *  - text format: strip markdown syntax that Feishu plain-text bubbles don't render.
 *  - document format: keep markdown as-is for card rendering.
 *
 * Add new cleaning rules here — one place, not scattered across the codebase.
 */

export function sanitize(text: string, format: "text" | "document"): string {
  // Always unescape literal escape sequences that JSON-outputting LLMs sometimes emit
  let out = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");

  if (format === "text") {
    // Feishu plain-text bubble does not render markdown — strip presentational markup.
    out = out
      .replace(/```[\s\S]*?```/g, "[代码]")       // fenced code block → placeholder
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")         // **bold** → bold
      .replace(/\*([^*\n]+)\*/g, "$1")             // *italic* → italic
      .replace(/^#{1,6}\s+(.+)$/gm, "$1")          // ## heading → heading
      .replace(/`([^`\n]+)`/g, "$1")               // `code` → code
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");    // [text](url) → text
  }
  // document: keep markdown intact for Feishu card rendering

  return out;
}
