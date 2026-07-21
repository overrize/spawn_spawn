/**
 * M1-4 · Decision extraction acceptance (QA test-first, per 协作节奏 #1).
 *
 * Current: SecretaryProxy logs a decision whenever a message matches the
 * DECISION_KEYWORDS regex (应该|决定|选择|采用|方案|确认|...|should|use|will).
 * That is both leaky (any message containing "方案"/"use" is logged) and
 * lossy (a real decision phrased without a keyword is missed).
 *
 * Target: an explicit `decision.record` protocol event is the primary source
 * (carries decision + rationale), regex demoted to a fallback. NOTE the gap
 * the executor must close: `decision.record` is NOT in the normalizer's
 * VALID_TYPES today — a model emitting it would be dropped as unknown.
 *
 * A = characterization (pins current regex behavior, incl. its failure modes).
 * B = target contract (it.todo the executor turns green).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SecretaryProxy } from "../../memory/SecretaryProxy.js";
import { createMemory } from "../../memory/MemoryStore.js";
import { parseAgentOutput } from "../../protocol/normalizer.js";
import type { TuiEvent } from "../../protocol.js";

let tmpDir: string;
let origCwd: string;
before(() => {
  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-m14-"));
  process.chdir(tmpDir);
});
after(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function newSecretary(id = "tl-1"): SecretaryProxy {
  return new SecretaryProxy(createMemory({
    agentId: id, agentType: "LEADER", parentChain: [], depth: 1, model: "test", roleName: "Leader",
  }));
}

function decisionsOf(sec: SecretaryProxy): string[] {
  return sec.getMemory().working_set.decisions.map((d) => d.text);
}

// ── A. Characterization: current keyword-regex extraction ─────────────────────

describe("M1-4·characterization: decision = keyword regex (current)", () => {
  let sec: SecretaryProxy;
  beforeEach(() => { sec = newSecretary(); });

  it("records a message that hits a keyword (真决定)", () => {
    sec.observe({ v: 1, type: "message", agent: "tl-1", to: "pm", text: "我们决定采用方案 B" } as TuiEvent);
    assert.deepEqual(decisionsOf(sec), ["我们决定采用方案 B"]);
  });

  it("FALSE POSITIVE: non-decision containing a keyword is logged anyway", () => {
    // "方案" appears but this is a question, not a decision.
    sec.observe({ v: 1, type: "message", agent: "tl-1", to: "pm", text: "这个方案你看过了吗？" } as TuiEvent);
    assert.equal(decisionsOf(sec).length, 1, "current regex over-captures — logged despite not being a decision");
  });

  it("FALSE NEGATIVE: a real decision without a keyword is missed", () => {
    sec.observe({ v: 1, type: "message", agent: "tl-1", to: "pm", text: "配置拆成两层，角色只引用模型键。" } as TuiEvent);
    assert.equal(decisionsOf(sec).length, 0, "current regex under-captures — real decision has no keyword");
  });

  it("GAP: decision.record JSON is dropped by normalizer today (not in VALID_TYPES)", () => {
    const out: TuiEvent[] = [];
    parseAgentOutput(`{"type":"decision.record","decision":"采用方案 B","reason":"改动面小"}`, "tl-1", (ev) => out.push(ev));
    // Unknown type → dropped. The executor must add decision.record to VALID_TYPES.
    assert.deepEqual(out, [], "decision.record currently produces no event");
  });
});

// ── B. Target contract for the executor ───────────────────────────────────────
//
// 1. normalizer VALID_TYPES gains "decision.record"; parseAgentOutput emits it.
// 2. SecretaryProxy records decision.record → { text: decision, rationale: reason }.
// 3. Keyword regex demoted to fallback: only fires when NO decision.record in the
//    same turn (or behind a flag), reducing false positives.
// 4. Precision/recall on a labeled CN+EN decision set beats the current regex
//    baseline (regex baseline captured by the characterization above).

describe("M1-4·target: explicit decision.record primary (executor implements)", () => {
  it.todo("normalizer emits decision.record event (added to VALID_TYPES)");
  it.todo("SecretaryProxy records decision.record with rationale=reason");
  it.todo("keyword regex demoted to fallback — false-positive case above no longer logged");
  it.todo("labeled CN+EN decision set: precision & recall both improve vs regex baseline");
});
