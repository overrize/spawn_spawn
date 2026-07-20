import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  formatMetricsReport,
  getHealthMetricsStore,
  HealthMetricsStore,
  inferRole,
  makeHealthMetric,
  recordHealthMetric,
  setHealthMetricsStoreForTests,
} from "../../runtime/HealthMetrics.js";
import { parseAgentOutput, resetFallbackCount } from "../../protocol/normalizer.js";
import type { TuiEvent } from "../../protocol.js";

function tempStore(): HealthMetricsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-health-metrics-"));
  const store = new HealthMetricsStore(dir);
  setHealthMetricsStoreForTests(store);
  return store;
}

describe("HealthMetricsStore", () => {
  it("appends and reads health metrics from JSONL", () => {
    const store = tempStore();

    const metric = makeHealthMetric({
      agent_id: "pm",
      event_type: "trace_completed",
      severity: "info",
      reason: "done",
      ts: 123,
    });
    store.appendMetric(metric);

    const metrics = store.readMetrics();
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]!.event_type, "trace_completed");
    assert.equal(metrics[0]!.role, "PM");
    assert.equal(metrics[0]!.trace_id, "trace-pm");
  });

  it("skips corrupt JSONL lines when reading", () => {
    const store = tempStore();
    fs.mkdirSync(path.dirname(store.metricsPath), { recursive: true });
    fs.writeFileSync(
      store.metricsPath,
      [
        JSON.stringify(makeHealthMetric({
          agent_id: "worker-1",
          event_type: "trace_failed",
          severity: "error",
          reason: "failed",
          ts: 1,
        })),
        "{bad json",
        JSON.stringify(makeHealthMetric({
          agent_id: "tl-1",
          event_type: "trace_completed",
          severity: "info",
          reason: "done",
          ts: 2,
        })),
      ].join("\n"),
      "utf8",
    );

    const metrics = store.readMetrics();
    assert.equal(metrics.length, 2);
    assert.deepEqual(metrics.map((m) => m.agent_id), ["worker-1", "tl-1"]);
  });

  it("infers roles from common agent ids", () => {
    assert.equal(inferRole("pm"), "PM");
    assert.equal(inferRole("tl-01"), "Leader");
    assert.equal(inferRole("leader-01"), "Leader");
    assert.equal(inferRole("secretary-01"), "Secretary");
    assert.equal(inferRole("worker-01"), "Worker");
  });

  it("uses a temp default store under node:test instead of .spawn/metrics", () => {
    setHealthMetricsStoreForTests(null);
    const metric = recordHealthMetric({
      agent_id: "test-agent",
      event_type: "trace_completed",
      severity: "info",
      reason: "test isolation",
      ts: 1,
    });

    assert.ok(metric);
    const dir = path.resolve(getHealthMetricsStore().dir);
    const realMetricsDir = path.resolve(process.cwd(), ".spawn", "metrics");
    assert.equal(dir.startsWith(realMetricsDir), false);
    assert.match(dir, /spawn-health-metrics-test-/);
  });
});

describe("formatMetricsReport", () => {
  const metrics = [
    makeHealthMetric({
      agent_id: "pm",
      event_type: "trace_completed",
      severity: "info",
      reason: "root done",
      ts: Date.UTC(2026, 6, 20, 1, 2, 3),
    }),
    makeHealthMetric({
      agent_id: "worker-1",
      event_type: "protocol_parse_failed",
      severity: "error",
      reason: "bad\njson",
      ts: Date.UTC(2026, 6, 20, 1, 3, 4),
    }),
    makeHealthMetric({
      agent_id: "worker-1",
      event_type: "trace_failed",
      severity: "error",
      reason: "tool failed",
      ts: Date.UTC(2026, 6, 20, 1, 4, 5),
    }),
  ];

  it("formats a deterministic recent metrics report", () => {
    assert.equal(formatMetricsReport(metrics), [
      "── metrics: 3 total ──",
      "summary: protocol_parse_failed:1  trace_completed:1  trace_failed:1",
      "",
      "[2026-07-20T01:04:05.000Z] error trace_failed @worker-1 - tool failed",
      "[2026-07-20T01:03:04.000Z] error protocol_parse_failed @worker-1 - bad json",
      "[2026-07-20T01:02:03.000Z] info trace_completed @pm - root done",
    ].join("\n"));
  });

  it("filters by event type or agent id", () => {
    assert.equal(formatMetricsReport(metrics, "trace_failed"), [
      "── metrics (trace_failed): 1 total ──",
      "summary: trace_failed:1",
      "",
      "[2026-07-20T01:04:05.000Z] error trace_failed @worker-1 - tool failed",
    ].join("\n"));

    assert.equal(formatMetricsReport(metrics, "worker-1"), [
      "── metrics (worker-1): 2 total ──",
      "summary: protocol_parse_failed:1  trace_failed:1",
      "",
      "[2026-07-20T01:04:05.000Z] error trace_failed @worker-1 - tool failed",
      "[2026-07-20T01:03:04.000Z] error protocol_parse_failed @worker-1 - bad json",
    ].join("\n"));
  });

  it("formats empty states", () => {
    assert.equal(formatMetricsReport([]), "暂无 HealthMetric");
    assert.equal(formatMetricsReport(metrics, "missing"), "暂无匹配 HealthMetric: missing");
  });
});

describe("normalizer health metrics", () => {
  it("records fallback_message_emitted for plain text fallback", () => {
    const store = tempStore();
    resetFallbackCount();
    const events: TuiEvent[] = [];

    parseAgentOutput("普通文本回复", "pm", (ev) => events.push(ev));

    const metrics = store.readMetrics();
    assert.equal(events[0]!.type, "message");
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]!.event_type, "fallback_message_emitted");
    assert.equal(metrics[0]!.agent_id, "pm");
  });

  it("records protocol_repaired when JSON literals are repaired", () => {
    const store = tempStore();
    const events: TuiEvent[] = [];

    parseAgentOutput('{"type":"message","to":"user","text":"a\tb"}', "tl-01", (ev) => events.push(ev));

    const metrics = store.readMetrics();
    assert.equal(events[0]!.type, "message");
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]!.event_type, "protocol_repaired");
    assert.equal(metrics[0]!.reason, "json_literal_repaired");
  });

  it("records protocol_parse_failed for unrecoverable JSON", () => {
    const store = tempStore();
    const events: TuiEvent[] = [];

    parseAgentOutput('{"type":"message","text":', "worker-01", (ev) => events.push(ev));

    const metrics = store.readMetrics();
    assert.equal(events.length, 0);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]!.event_type, "protocol_parse_failed");
    assert.equal(metrics[0]!.severity, "error");
  });

  it("recordHealthMetric returns null instead of throwing when append fails", () => {
    setHealthMetricsStoreForTests(new HealthMetricsStore("\0bad"));
    const metric = recordHealthMetric({
      agent_id: "pm",
      event_type: "trace_failed",
      severity: "error",
      reason: "bad path",
    });

    assert.equal(metric, null);
  });
});
