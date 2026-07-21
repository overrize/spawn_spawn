/**
 * M2-2 · Dual-rail equivalence acceptance (QA test-first, per 协作节奏 #1).
 *
 * The core acceptance for the native-tool-calling rail (PLAN WS1): the SAME
 * agent intent, expressed on the text rail (current) OR the native rail
 * (executor builds), must produce an EQUIVALENT TuiEvent sequence. This file
 * fixes "equivalent" precisely BEFORE the native rail exists, so the rail is
 * built to a target rather than the test bent to the build.
 *
 * Structure:
 *  A. canonicalize() — the equivalence relation (order-preserving signature of
 *     semantically-meaningful fields; ids/timestamps/whitespace ignored).
 *  B. Text-rail golden — pins the canonical signature the native rail must match
 *     for a representative intent set (incl. the hard case: multi-action turn).
 *  C. it.todo — the native-rail side the executor implements to green.
 *
 * Reference for the executor:
 *   • native rail maps Anthropic tool_use / OpenAI tool_calls → TuiEvent.
 *   • a turn with multiple actions (message + spawn) is carried by ONE
 *     `emit_events` tool call whose payload is the event array — it must
 *     canonicalize identically to the text rail's two JSON lines.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseAgentOutput } from "../../protocol/normalizer.js";
import type { TuiEvent } from "../../protocol.js";

// ── A. The equivalence relation ───────────────────────────────────────────────
// Canonical signature: type + semantic fields only. Ignores agent id assignment,
// tool-call ids, timestamps, and the _fallback marker (rail-specific noise).
function canonicalize(events: TuiEvent[]): string[] {
  return events.map((ev) => {
    switch (ev.type) {
      case "message":  return `message:to=${ev.to}:${ev.text.trim()}`;
      case "spawn":    return `spawn:${ev.role}:${ev.goal}`;
      case "tool.call":return `tool.call:${ev.name}:${JSON.stringify(ev.args)}`;
      case "todo.set": return `todo.set:${ev.items.map((i) => `${i.state}/${i.text}`).join(",")}`;
      case "step":     return `step:${ev.text.trim()}`;
      case "agent.done":return `agent.done:${ev.success}`;
      case "unit.handup":return `unit.handup:${ev.facts_to_promote?.length ?? 0}`;
      default:         return ev.type;
    }
  });
}

function textRail(raw: string, agentId = "pm"): string[] {
  const out: TuiEvent[] = [];
  parseAgentOutput(raw, agentId, (ev) => out.push(ev));
  return canonicalize(out);
}

const DISPATCH = `{"background":"b","constraints":[],"acceptance_criteria":["a"],"stop_conditions":["s"]}`;

// ── B. Text-rail golden signatures (the target the native rail must match) ─────

describe("M2-2·text-rail golden: canonical signatures per intent", () => {
  it("INTENT single-message", () => {
    assert.deepEqual(
      textRail(`{"type":"message","to":"user","text":"开始处理"}`),
      ["message:to=user:开始处理"],
    );
  });

  it("INTENT single tool.call", () => {
    assert.deepEqual(
      textRail(`{"type":"tool.call","id":"t1","name":"Read","args":{"path":"a.ts"}}`),
      [`tool.call:Read:{"path":"a.ts"}`],
    );
  });

  it("INTENT single spawn", () => {
    assert.deepEqual(
      textRail(`{"type":"spawn","parent":"pm","child":"tl-1","role":"Leader","goal":"实现X","dispatch":${DISPATCH}}`),
      ["spawn:Leader:实现X"],
    );
  });

  it("INTENT HARD — multi-action turn (message + spawn) → two canonical entries in order", () => {
    // Native rail must carry both via one emit_events tool call and canonicalize identically.
    assert.deepEqual(
      textRail(`{"type":"message","to":"user","text":"安排 TL"}\n\n{"type":"spawn","parent":"pm","child":"tl-1","role":"Leader","goal":"实现X","dispatch":${DISPATCH}}`),
      ["message:to=user:安排 TL", "spawn:Leader:实现X"],
    );
  });

  it("INTENT plan-then-act (todo.set + tool.call)", () => {
    assert.deepEqual(
      textRail(`{"type":"todo.set","items":[{"id":"1","text":"读","state":"run"}]}\n\n{"type":"tool.call","id":"t1","name":"Read","args":{"path":"a.ts"}}`),
      ["todo.set:run/读", `tool.call:Read:{"path":"a.ts"}`],
    );
  });

  it("INTENT done", () => {
    assert.deepEqual(
      textRail(`{"type":"agent.done","success":true,"reason":"完成"}`, "tl-1"),
      ["agent.done:true"],
    );
  });
});

// ── C. Native-rail side (executor implements to green) ────────────────────────
//
// nativeRail(toolCalls) — adapt Anthropic tool_use / OpenAI tool_calls into
// TuiEvents, then canonicalize. Acceptance: for each INTENT above, the native
// signature deep-equals the text-rail golden.

describe("M2-2·target: native rail canonicalizes identically (executor)", () => {
  it.todo("native single-message ≡ text golden");
  it.todo("native single tool.call ≡ text golden (tool_use → tool.call)");
  it.todo("native single spawn ≡ text golden");
  it.todo("native multi-action turn via emit_events ≡ text golden (order preserved)");
  it.todo("native plan-then-act ≡ text golden");
  it.todo("native done ≡ text golden");
  it.todo("equivalence over the full M3-2 scenario intent set — no rail-specific divergence");
});
