// M0 exit acceptance — run a realistic multi-agent task through REAL components
// as a plain tsx process (NOT node:test), so recordHealthMetric writes to the
// real default store (.spawn/metrics under cwd). Verifies G7 end-to-end:
// guard/degrade/converge events land in the JSONL stream and /metrics
// (formatMetricsReport) renders them.
//
// Usage: npx tsx tmp/m0-exit-check.mts   (from tui-ink/)
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "m0-exit-"));
process.chdir(workDir);

const { parseAgentOutput } = await import("../src/protocol/normalizer.js");
const { applyEvent, ensureAgent, getState } = await import("../src/store.js");
const { ProcessManager } = await import("../src/pm/ProcessManager.js");
const { SecretaryProxy } = await import("../src/memory/SecretaryProxy.js");
const { createMemory } = await import("../src/memory/MemoryStore.js");
const { getHealthMetricsStore, formatMetricsReport } = await import("../src/runtime/HealthMetrics.js");
type TuiEvent = import("../src/protocol.js").TuiEvent;

const pm = new ProcessManager();
pm.on("event", (ev: TuiEvent) => { if (ev.type === "pm.alert") applyEvent(ev); });

ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });
const tlSec = new SecretaryProxy(createMemory({
  agentId: "tl-1", agentType: "LEADER", parentChain: [], depth: 1, model: "m", roleName: "Leader",
}));

const route = (ev: TuiEvent) => {
  if (ev.type === "spawn") {
    const check = pm.preCheckSpawn(ev, getState().agents.get(ev.parent)?.role);
    if (!check.ok) return;
  }
  applyEvent(ev);
  pm.observe(ev);
  tlSec.observe(ev);
};
const feed = (agentId: string, raw: string) => parseAgentOutput(raw, agentId, route);

const DISPATCH = JSON.stringify({
  background: "m0 exit task", constraints: [],
  acceptance_criteria: ["done"], stop_conditions: ["done"],
});

// ── Realistic task: spawn chain + tool work + degradations + convergence ─────
feed("pm", `{"type":"spawn","parent":"pm","child":"tl-1","role":"Leader","goal":"出口验收任务","dispatch":${DISPATCH}}`);
route({ v: 1, type: "agent.state", agent: "tl-1", state: "run" } as TuiEvent);
feed("tl-1", `{"type":"spawn","parent":"tl-1","child":"w-1","role":"Worker","goal":"执行","dispatch":${DISPATCH}}`);
route({ v: 1, type: "agent.state", agent: "w-1", state: "run" } as TuiEvent);

// protocol_repaired: unescaped newline inside JSON string
feed("w-1", `{"type":"message","to":"tl-1","text":"第一行\n第二行"}`);
// protocol_parse_failed: unrecoverable JSON
feed("w-1", `{"type":"message","text":`);
// fallback_message_emitted: bare prose
feed("w-1", `裸文本回复一句`);
// memory_fact_merged: two similar facts through the TL secretary
route({ v: 1, type: "tool.result", agent: "tl-1", id: "t1", ok: true, output: "the registry exposes twelve tools for agents" } as TuiEvent);
route({ v: 1, type: "tool.result", agent: "tl-1", id: "t2", ok: true, output: "the registry exposes twelve tools for agents today" } as TuiEvent);
// tool_call_repeated: 10 calls on the same path
for (let i = 0; i < 10; i++) {
  route({ v: 1, type: "tool.call", agent: "w-1", id: `r${i}`, name: "Read", args: { path: "src/a.ts" } } as TuiEvent);
}
// convergence: worker fails once (trace_failed), TL completes (trace_completed)
route({ v: 1, type: "agent.done", agent: "w-1", success: false, reason: "验收失败示例" } as TuiEvent);
route({ v: 1, type: "agent.done", agent: "tl-1", success: true, reason: "任务完成" } as TuiEvent);

await new Promise((r) => setTimeout(r, 100)); // let async saves settle

// ── Verify ───────────────────────────────────────────────────────────────────
const store = getHealthMetricsStore();
console.log(`metrics dir: ${store.dir}`);
const metrics = store.readMetrics();
const types = new Set(metrics.map((m) => m.event_type));
const expected = [
  "protocol_repaired", "protocol_parse_failed", "fallback_message_emitted",
  "memory_fact_merged", "tool_call_repeated", "trace_failed", "trace_completed",
];
const missing = expected.filter((t) => !types.has(t as any));
console.log(`total metrics: ${metrics.length}; types: ${[...types].join(", ")}`);
if (missing.length) {
  console.error(`MISSING event types: ${missing.join(", ")}`);
  process.exit(1);
}
if (!store.dir.includes(".spawn")) {
  console.error(`FAIL: default store not under cwd .spawn (got ${store.dir}) — test-isolation misfired for a non-test process`);
  process.exit(1);
}
console.log("\n── /metrics 输出（formatMetricsReport over real store）──");
console.log(formatMetricsReport(metrics));
console.log("\nM0 EXIT CHECK: PASS");
pm.destroy();
tlSec.destroy();
process.exit(0);
