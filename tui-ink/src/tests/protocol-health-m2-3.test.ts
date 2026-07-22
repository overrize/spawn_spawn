/**
 * M2-3 · provider protocol-health scoring from the repair-pipeline metrics.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { protocolHealth, formatProtocolHealth } from "../runtime/protocolHealth.js";
import { makeHealthMetric, type HealthMetric } from "../runtime/HealthMetrics.js";

function m(provider: string, event_type: HealthMetric["event_type"]): HealthMetric {
  return makeHealthMetric({ agent_id: "a", provider, event_type, severity: "warn", reason: "x" });
}

describe("M2-3 protocolHealth", () => {
  it("clean provider scores 1.0; noisy provider scores lower", () => {
    const metrics = [
      m("api.openai.com", "protocol_repaired"),          // mild
      m("kimi", "protocol_parse_failed"),                // worst
      m("kimi", "fallback_message_emitted"),
      m("kimi", "fallback_message_emitted"),
    ];
    const rows = protocolHealth(metrics);
    const kimi = rows.find((r) => r.provider === "kimi")!;
    const openai = rows.find((r) => r.provider === "api.openai.com")!;
    assert.ok(kimi.score < openai.score, `kimi=${kimi.score} openai=${openai.score}`);
    assert.equal(kimi.parseFailed, 1);
    assert.equal(kimi.fallback, 2);
    assert.equal(rows[0]!.provider, "kimi", "worst provider sorted first");
  });

  it("parse-fail penalizes harder than repair (same count)", () => {
    const a = protocolHealth([m("A", "protocol_parse_failed")])[0]!;
    const b = protocolHealth([m("B", "protocol_repaired")])[0]!;
    assert.ok(a.score < b.score);
    assert.equal(b.score, 0.8); // 1 - 0.2*(1/1)
    assert.equal(a.score, 0);   // 1 - 1.0*(1/1)
  });

  it("ignores non-protocol events; empty → friendly message", () => {
    assert.deepEqual(protocolHealth([makeHealthMetric({ agent_id: "a", provider: "x", event_type: "trace_completed", severity: "info", reason: "" })]), []);
    assert.match(formatProtocolHealth([]), /no protocol events/);
  });

  it("report flags providers below threshold", () => {
    const out = formatProtocolHealth([m("kimi", "protocol_parse_failed"), m("kimi", "fallback_message_emitted")], 0.8);
    assert.match(out, /kimi/);
    assert.match(out, /native rail/);
  });
});
