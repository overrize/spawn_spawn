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

  it("FIXED (M1-4): question containing a topic word is no longer captured", () => {
    // "方案" appears but this is a question — fallback now requires a decision VERB
    // and excludes questions, so it is NOT logged.
    sec.observe({ v: 1, type: "message", agent: "tl-1", to: "pm", text: "这个方案你看过了吗？" } as TuiEvent);
    assert.equal(decisionsOf(sec).length, 0, "tightened fallback no longer over-captures");
  });

  it("FALSE NEGATIVE: a real decision without a keyword is missed", () => {
    sec.observe({ v: 1, type: "message", agent: "tl-1", to: "pm", text: "配置拆成两层，角色只引用模型键。" } as TuiEvent);
    assert.equal(decisionsOf(sec).length, 0, "current regex under-captures — real decision has no keyword");
  });

  it("FIXED (M1-4): decision.record JSON now emits an event (added to VALID_TYPES)", () => {
    const out: TuiEvent[] = [];
    parseAgentOutput(`{"type":"decision.record","decision":"采用方案 B","reason":"改动面小"}`, "tl-1", (ev) => out.push(ev));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.type, "decision.record");
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

describe("M1-4·target: explicit decision.record primary (implemented)", () => {
  let sec: SecretaryProxy;
  beforeEach(() => { sec = newSecretary("tl-2"); });

  it("SecretaryProxy records decision.record with rationale=reason", () => {
    sec.observe({ v: 1, type: "decision.record", agent: "tl-2", decision: "配置拆两层", reason: "改动面小" } as TuiEvent);
    const d = sec.getMemory().working_set.decisions;
    assert.equal(d.length, 1);
    assert.equal(d[0]!.text, "配置拆两层");
    assert.equal(d[0]!.rationale, "改动面小");
  });

  it("end-to-end: decision.record JSON → parse → Secretary records it (rationale preserved)", () => {
    parseAgentOutput(
      `{"type":"decision.record","decision":"采用 provider catalog","reason":"解耦 model/baseUrl"}`,
      "tl-2",
      (ev) => sec.observe(ev),
    );
    const d = sec.getMemory().working_set.decisions;
    assert.equal(d.some((x) => x.text.includes("provider catalog") && x.rationale.includes("解耦")), true);
  });

  it("regex is fallback: a keyword-free real decision is still missed by regex (needs decision.record)", () => {
    // The false-negative case — regex can't catch it; decision.record is how it gets recorded.
    sec.observe({ v: 1, type: "message", agent: "tl-2", to: "pm", text: "配置拆成两层，角色只引用模型键。" } as TuiEvent);
    assert.equal(sec.getMemory().working_set.decisions.length, 0);
  });

  it("fallback still captures an explicit verb decision (真决定 via message)", () => {
    sec.observe({ v: 1, type: "message", agent: "tl-2", to: "pm", text: "我们决定采用方案 B" } as TuiEvent);
    assert.equal(sec.getMemory().working_set.decisions.length, 1);
  });
});
