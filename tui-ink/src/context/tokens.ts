/**
 * Token estimation — heuristic, no network, no tokenizer dependency.
 *
 * Why: budgets were measured in CHARS, which means a different token count per
 * language. 100 CJK chars ≈ 100 tokens; 100 ASCII chars ≈ 25 tokens. A char
 * budget therefore lets a Chinese history carry ~4× the tokens an English one
 * does — same knob, different real cost / overflow risk. estimateTokens makes
 * the budget mean the same thing regardless of script. (spawn-1.0 M1-3)
 *
 * Contract (pinned by token-budget-m1-3.test.ts):
 *   • ASCII/Latin run ≈ ceil(chars / 4)
 *   • CJK codepoint ≈ 1 token each (Han / Hiragana / Katakana / Hangul / fullwidth)
 *   • monotonic: appending text never lowers the estimate
 *   • estimateTokens(han(100)) ≥ 3 × estimateTokens(ascii(100))
 */

function isCjkCodepoint(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x303f) ||  // CJK symbols & punctuation
    (cp >= 0x3040 && cp <= 0x30ff) ||  // Hiragana + Katakana
    (cp >= 0x3400 && cp <= 0x4dbf) ||  // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) ||  // CJK unified
    (cp >= 0xac00 && cp <= 0xd7af) ||  // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||  // CJK compat ideographs
    (cp >= 0xff00 && cp <= 0xffef) ||  // Fullwidth forms
    (cp >= 0x20000 && cp <= 0x2fa1f)   // CJK ext B+ (supplementary)
  );
}

/** Estimate the token count of a string (heuristic). See contract above. */
export function estimateTokens(s: string): number {
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (isCjkCodepoint(cp)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

/** Total estimated tokens across a message array. */
export function totalTokens(messages: Array<{ content: string }>): number {
  return messages.reduce((s, m) => s + estimateTokens(m.content), 0);
}
