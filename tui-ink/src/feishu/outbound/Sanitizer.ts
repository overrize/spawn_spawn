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
  // Always unescape literal escape sequences that JSON-outputting LLMs sometimes emit.
  // BUT: Windows paths (E:\spawn-work\tui-ink\...) contain \t / \n as *real path
  // separators* — blindly unescaping turns "\tui-ink" into a TAB and corrupts the path
  // (which also broke image auto-send). So protect Windows-path segments first.
  // 路径 = 盘符 + 若干 "\段"。段必须是路径样式（字母数字/._- 等，且长度≥2 或非 n/t/r），
  // 这样 "\tui-ink" 被当路径段保留，而结尾孤立的 "\n"/"\t"（后面不接路径字符）仍会被还原。
  const WIN_PATH_RE = /[A-Za-z]:(?:\\(?:[ntr][\w.\-]+|[^\sntr\\"'`<>|][\w.\-]*))+/g;
  const guarded: string[] = [];
  let out = text.replace(WIN_PATH_RE, (m) => {
    guarded.push(m);
    return `\u0000WINPATH${guarded.length - 1}\u0000`;
  });
  out = out.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  out = out.replace(/\u0000WINPATH(\d+)\u0000/g, (_, i) => guarded[Number(i)]!);

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
