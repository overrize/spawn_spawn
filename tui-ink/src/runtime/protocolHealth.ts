/**
 * M2-3 · Provider protocol-health scoring.
 *
 * Turns the M0 repair-pipeline metrics (protocol_parse_failed / protocol_repaired
 * / fallback_message_emitted) into a per-provider health score, so we can tell
 * which text-rail providers are struggling to emit clean protocol JSON — the
 * evidence for when to switch a provider onto the native rail (M2-2).
 */

import type { HealthMetric } from "./HealthMetrics.js";

export interface ProtocolHealth {
  provider: string;
  total: number;        // total protocol-relevant turns observed
  parseFailed: number;
  repaired: number;
  fallback: number;
  /** 0..1, 1 = perfectly clean; penalizes parse-fail hardest, then fallback, then repair. */
  score: number;
}

const PROTO_EVENTS = new Set(["protocol_parse_failed", "protocol_repaired", "fallback_message_emitted"]);

/** Aggregate protocol health per provider from the metric stream. */
export function protocolHealth(metrics: HealthMetric[]): ProtocolHealth[] {
  const by = new Map<string, ProtocolHealth>();
  const get = (provider: string): ProtocolHealth => {
    let h = by.get(provider);
    if (!h) { h = { provider, total: 0, parseFailed: 0, repaired: 0, fallback: 0, score: 1 }; by.set(provider, h); }
    return h;
  };
  for (const m of metrics) {
    if (!PROTO_EVENTS.has(m.event_type)) continue;
    const h = get(m.provider ?? "unknown");
    h.total++;
    if (m.event_type === "protocol_parse_failed") h.parseFailed++;
    else if (m.event_type === "protocol_repaired") h.repaired++;
    else h.fallback++;
  }
  for (const h of by.values()) {
    // Weighted penalty: parse-fail is worst (content lost), fallback next
    // (protocol not followed), repair mildest (recovered). Normalized by total.
    const penalty = h.total === 0 ? 0
      : (1.0 * h.parseFailed + 0.6 * h.fallback + 0.2 * h.repaired) / h.total;
    h.score = Math.max(0, Math.min(1, 1 - penalty));
  }
  return [...by.values()].sort((a, b) => a.score - b.score); // worst first
}

/** One-line-per-provider report; flags providers below `threshold` as native-rail candidates. */
export function formatProtocolHealth(metrics: HealthMetric[], threshold = 0.8): string {
  const rows = protocolHealth(metrics);
  if (rows.length === 0) return "protocol health: (no protocol events yet)";
  return [
    "── protocol health (worst first) ──",
    ...rows.map((h) => {
      const pct = Math.round(h.score * 100);
      const flag = h.score < threshold ? "  ⚠ consider native rail" : "";
      return `${h.provider.padEnd(20)} ${String(pct).padStart(3)}%  (parse✗${h.parseFailed} fallback${h.fallback} repair${h.repaired} / ${h.total})${flag}`;
    }),
  ].join("\n");
}
