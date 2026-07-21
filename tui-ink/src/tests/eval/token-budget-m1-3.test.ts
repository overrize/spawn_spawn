/**
 * M1-3 · Token-budget acceptance (QA test-first, per 协作节奏 #1).
 *
 * QA delivers this BEFORE the executor implements, so the token-budget
 * refactor is measured against a fixed target rather than the test being
 * bent to fit whatever gets built.
 *
 * Two halves:
 *  A. Characterization — pins CURRENT char-based compactHistory behavior.
 *     The executor's refactor MUST consciously update these (they encode
 *     the deficiency, not the desired end state).
 *  B. Target contract — the token-budget behavior the executor implements,
 *     expressed as it.todo specs + a documented estimateTokens contract.
 *
 * Why this matters (the bug in one line): a *char* budget means a different
 * number of *tokens* per language. 100 CJK chars ≈ 100+ tokens; 100 ASCII
 * chars ≈ 25 tokens. So a 60K-char resume budget lets a Chinese history
 * carry ~4× the tokens an English one does — same knob, different real cost.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HttpConvAgent } from "../../adapters/httpAgent.js";

type Msg = { role: "user" | "assistant"; content: string };

function msg(role: "user" | "assistant", content: string): Msg {
  return { role, content };
}

/** Fixed-length filler of a given script. */
function ascii(n: number): string { return "a".repeat(n); }
function han(n: number): string { return "中".repeat(n); }

// ── A. Characterization: current char-based compactHistory ────────────────────

describe("M1-3·characterization: compactHistory is char-based (current)", () => {
  it("keeps index 0 + last 4, drops middle by CHAR length until under maxChars", () => {
    const msgs: Msg[] = [
      msg("user", ascii(100)),      // 0 — always kept (initial context)
      msg("assistant", ascii(100)), // 1 — droppable middle
      msg("user", ascii(100)),      // 2 ┐
      msg("assistant", ascii(100)), // 3 │ last 4 — always kept
      msg("user", ascii(100)),      // 4 │
      msg("assistant", ascii(100)), // 5 ┘
    ];
    const out = HttpConvAgent.compactHistory(msgs, 450);
    // 600 > 450 → drops index 1 only (can't touch index 0 or last 4)
    assert.equal(out.length, 5);
    assert.deepEqual(out.map((m) => m.content.length), [100, 100, 100, 100, 100]);
    // index 1 (the 2nd message) is the one removed
    assert.equal(out[1]!.role, "user"); // was index 2
  });

  it("under budget → returned unchanged (minus empty messages)", () => {
    const msgs: Msg[] = [msg("user", ascii(10)), msg("assistant", "  "), msg("user", ascii(10))];
    const out = HttpConvAgent.compactHistory(msgs, 1000);
    assert.deepEqual(out.map((m) => m.content), [ascii(10), ascii(10)]); // blank dropped
  });

  it("BUG: char budget is language-blind — equal CHARS truncate identically regardless of token cost", () => {
    // Same char shape, different scripts. compactHistory can't tell them apart,
    // even though 中×100 costs ~4× the tokens of a×100.
    const shape = (filler: (n: number) => string): Msg[] => [
      msg("user", filler(100)),
      msg("assistant", filler(100)),
      msg("user", filler(100)),
      msg("assistant", filler(100)),
      msg("user", filler(100)),
      msg("assistant", filler(100)),
    ];
    const en = HttpConvAgent.compactHistory(shape(ascii), 450);
    const cn = HttpConvAgent.compactHistory(shape(han), 450);
    // Identical structural outcome — the char budget ignores that `cn` carries
    // far more tokens. This is exactly what M1-3 must fix.
    assert.equal(en.length, cn.length);
    assert.deepEqual(en.map((m) => m.content.length), cn.map((m) => m.content.length));
  });
});

// ── B. Target contract for the executor (token-based) ─────────────────────────
//
// estimateTokens(s: string): number — heuristic, no network. Acceptance:
//   • ASCII/Latin run: ≈ ceil(chars / 4)
//   • CJK codepoint: ≈ 1 token each (Han/Hiragana/Katakana/Hangul)
//   • Monotonic: appending text never lowers the estimate
//   • estimateTokens(han(100)) ≥ 3 × estimateTokens(ascii(100))   (the core divergence)
//
// compactHistoryByTokens(msgs, maxTokens) — same keep-rule (index 0 + last 4),
// but budget measured via estimateTokens. Resume/trim budgets re-expressed in
// tokens (resume ≈ 15K tokens, trim ≈ 20K tokens) instead of 60K/80K chars.

describe("M1-3·target: token-budget behavior (executor implements to green)", () => {
  it.todo("estimateTokens: ascii(100)≈25, han(100)≥75 (CJK ≥3× ascii per char)");
  it.todo("compactHistoryByTokens keeps index 0 + last 4, drops middle by TOKEN cost");
  it.todo("equal-TOKEN EN and CN histories truncate to the same message count (language-fair)");
  it.todo("resume budget re-expressed as ~15K tokens; CN history no longer overflows the token ceiling");
  it.todo("degrade path: if estimateTokens unavailable, fall back to char budget (no crash)");
});
