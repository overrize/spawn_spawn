import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type HealthMetricRole = "PM" | "Leader" | "Worker" | "Secretary" | "System";
export type HealthMetricSeverity = "info" | "warn" | "error" | "critical";

export type HealthMetricEventType =
  | "protocol_parse_failed"
  | "protocol_repaired"
  | "fallback_message_emitted"
  | "tool_arg_schema_failed"
  | "tool_call_repeated"
  | "no_progress_nudge"
  | "hard_circuit_fired"
  | "resume_context_missing"
  | "memory_fact_merged"
  | "memory_fact_dropped"
  | "agent_done_blocked_by_guard"
  | "test_failed_but_claimed_done"
  | "trace_completed"
  | "trace_failed"
  | "dispatch_timeout";

export interface HealthMetric {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  task_id?: string;
  agent_id: string;
  role: HealthMetricRole;
  event_type: HealthMetricEventType;
  severity: HealthMetricSeverity;
  reason: string;
  model?: string;
  provider?: string;
  prompt_version?: string;
  config_version?: string;
  tool_name?: string;
  latency_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  refs?: string[];
  ts: number;
  meta?: Record<string, unknown>;
}

export interface TraceEvent {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  agent_id: string;
  role: HealthMetricRole;
  event_type: "span_start" | "span_end" | "span_error" | "event";
  name: string;
  ts: number;
  duration_ms?: number;
  meta?: Record<string, unknown>;
}

export interface EvalResult {
  id: string;
  trace_id?: string;
  suite: string;
  case_id: string;
  status: "pass" | "fail" | "skip" | "error";
  score?: number;
  reason?: string;
  metrics?: Record<string, number>;
  refs?: string[];
  ts: number;
}

export type HealthMetricInput = Partial<
  Pick<
    HealthMetric,
    | "trace_id"
    | "span_id"
    | "parent_span_id"
    | "task_id"
    | "role"
    | "model"
    | "provider"
    | "prompt_version"
    | "config_version"
    | "tool_name"
    | "latency_ms"
    | "tokens_in"
    | "tokens_out"
    | "refs"
    | "meta"
    | "ts"
  >
> & {
  agent_id: string;
  event_type: HealthMetricEventType;
  severity: HealthMetricSeverity;
  reason: string;
};

export class HealthMetricsStore {
  readonly dir: string;
  readonly metricsPath: string;
  readonly tracePath: string;
  readonly evalPath: string;

  constructor(dir: string = path.join(process.cwd(), ".spawn", "metrics")) {
    this.dir = dir;
    this.metricsPath = path.join(dir, "health-metrics.jsonl");
    this.tracePath = path.join(dir, "trace-events.jsonl");
    this.evalPath = path.join(dir, "eval-results.jsonl");
  }

  appendMetric(metric: HealthMetric): void {
    appendJsonLine(this.metricsPath, metric);
  }

  appendTrace(event: TraceEvent): void {
    appendJsonLine(this.tracePath, event);
  }

  appendEval(result: EvalResult): void {
    appendJsonLine(this.evalPath, result);
  }

  readMetrics(): HealthMetric[] {
    return readJsonLines<HealthMetric>(this.metricsPath);
  }

  readTraceEvents(): TraceEvent[] {
    return readJsonLines<TraceEvent>(this.tracePath);
  }

  readEvalResults(): EvalResult[] {
    return readJsonLines<EvalResult>(this.evalPath);
  }
}

let defaultStore: HealthMetricsStore | null = null;

export function getHealthMetricsStore(): HealthMetricsStore {
  defaultStore ??= new HealthMetricsStore(defaultMetricsDir());
  return defaultStore;
}

export function setHealthMetricsStoreForTests(store: HealthMetricsStore | null): void {
  defaultStore = store;
}

export function recordHealthMetric(input: HealthMetricInput): HealthMetric | null {
  const metric = makeHealthMetric(input);
  try {
    getHealthMetricsStore().appendMetric(metric);
    return metric;
  } catch (err) {
    process.stderr.write(`[HealthMetrics] append failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
}

export function formatMetricsReport(metrics: HealthMetric[], filter?: string): string {
  const normalizedFilter = filter?.trim();
  const filtered = normalizedFilter
    ? metrics.filter((metric) => metric.event_type === normalizedFilter || metric.agent_id === normalizedFilter)
    : metrics;
  const recent = filtered.slice(-20).reverse();
  if (recent.length === 0) {
    return normalizedFilter ? `暂无匹配 HealthMetric: ${normalizedFilter}` : "暂无 HealthMetric";
  }

  const counts = new Map<string, number>();
  for (const metric of filtered) {
    counts.set(metric.event_type, (counts.get(metric.event_type) ?? 0) + 1);
  }
  const summary = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([type, count]) => `${type}:${count}`)
    .join("  ");
  const lines = [
    `── metrics${normalizedFilter ? ` (${normalizedFilter})` : ""}: ${filtered.length} total ──`,
    summary ? `summary: ${summary}` : "summary: (empty)",
    "",
    ...recent.map((metric) => {
      const when = new Date(metric.ts).toISOString();
      const reason = metric.reason.replace(/\s+/g, " ").slice(0, 120);
      return `[${when}] ${metric.severity} ${metric.event_type} @${metric.agent_id} - ${reason}`;
    }),
  ];
  return lines.join("\n");
}

function defaultMetricsDir(): string | undefined {
  if (!isNodeTestProcess()) return undefined;
  return path.join(os.tmpdir(), `spawn-health-metrics-test-${process.pid}`);
}

function isNodeTestProcess(): boolean {
  return Boolean(process.env.NODE_TEST_CONTEXT) ||
    process.argv.some((arg) =>
      arg === "--test" ||
      arg.includes("src/tests/") ||
      arg.includes("src\\tests\\"),
    );
}

export function makeHealthMetric(input: HealthMetricInput): HealthMetric {
  const ts = input.ts ?? Date.now();
  const role = input.role ?? inferRole(input.agent_id);
  return {
    trace_id: input.trace_id ?? `trace-${input.agent_id}`,
    span_id: input.span_id ?? `${input.event_type}-${ts.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ...(input.parent_span_id ? { parent_span_id: input.parent_span_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    agent_id: input.agent_id,
    role,
    event_type: input.event_type,
    severity: input.severity,
    reason: input.reason,
    ...(input.model ? { model: input.model } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.prompt_version ? { prompt_version: input.prompt_version } : {}),
    ...(input.config_version ? { config_version: input.config_version } : {}),
    ...(input.tool_name ? { tool_name: input.tool_name } : {}),
    ...(typeof input.latency_ms === "number" ? { latency_ms: input.latency_ms } : {}),
    ...(typeof input.tokens_in === "number" ? { tokens_in: input.tokens_in } : {}),
    ...(typeof input.tokens_out === "number" ? { tokens_out: input.tokens_out } : {}),
    ...(input.refs ? { refs: input.refs } : {}),
    ts,
    ...(input.meta ? { meta: input.meta } : {}),
  };
}

export function inferRole(agentId: string): HealthMetricRole {
  const id = agentId.toLowerCase();
  if (id === "pm" || id.startsWith("pm-") || id.includes("-pm")) return "PM";
  if (id.includes("secretary")) return "Secretary";
  if (id.startsWith("tl") || id.startsWith("leader") || id.includes("-tl-") || id.includes("lead")) return "Leader";
  if (id === "system") return "System";
  return "Worker";
}

function appendJsonLine(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function readJsonLines<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const out: T[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Metrics are append-only diagnostics; one corrupt line must not hide the rest.
    }
  }
  return out;
}
