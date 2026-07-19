/**
 * M1-5 · Orchestration golden baseline (spawn-1.0 WORKPLAN).
 *
 * Characterization tests for the REAL orchestration chain:
 *
 *   raw LLM text → parseAgentOutput → [spawn gate: ProcessManager.preCheckSpawn]
 *                → store.applyEvent → ProcessManager.observe (alerts)
 *                → SecretaryProxy.observe (memory)
 *
 * The wiring below mirrors how src/index.tsx routes events today. These
 * timelines freeze CURRENT behavior, not ideal behavior. During the M1-6
 * index.tsx split (AgentRuntime / OrchestratorRuntime / ToolRuntime /
 * MemoryRuntime / ObservabilityRuntime), every step must keep these
 * snapshots byte-identical. A diff means either an unintended regression
 * or an explicit behavior change that must be recorded in
 * docs/spawn-1.0/ (PLAN §WS5) before the snapshot is updated.
 *
 * No HTTP, no TUI process, no LLM. Cross-platform (runs in `npm test` / CI).
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseAgentOutput } from "../../protocol/normalizer.js";
import { applyEvent, approve, reject, ensureAgent, getState, _resetForTest } from "../../store.js";
import { ProcessManager } from "../../pm/ProcessManager.js";
import { SecretaryProxy } from "../../memory/SecretaryProxy.js";
import { createMemory, loadMemory } from "../../memory/MemoryStore.js";
import type { TuiEvent, DispatchSpec } from "../../protocol.js";

// ── Isolated cwd: SecretaryProxy / journal bridge write under .spawn/ ────────

let tmpDir: string;
let origCwd: string;

before(() => {
  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-golden-"));
  process.chdir(tmpDir);
});

after(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Timeline recorder wiring real components like index.tsx does ─────────────

function fmt(ev: TuiEvent): string {
  switch (ev.type) {
    case "todo.set":
      return `todo.set ${ev.agent} [${ev.items.map((i) => `${i.state}:${i.text}`).join("|")}]`;
    case "step":
      return `step ${ev.agent} "${ev.text}"`;
    case "tool.call":
      return `tool.call ${ev.agent} ${ev.name}#${ev.id}${ev.needs_approval ? " needs_approval" : ""}`;
    case "tool.result":
      return `tool.result ${ev.agent} #${ev.id} ${ev.ok ? "ok" : "fail"}`;
    case "message":
      return `message ${ev.agent}→${ev.to} "${ev.text.slice(0, 48)}"${(ev as any)._fallback ? " (fallback)" : ""}`;
    case "spawn":
      return `spawn ${ev.parent}→${ev.child} ${ev.role} goal="${ev.goal}"`;
    case "agent.done":
      return `agent.done ${ev.agent} ${ev.success ? "success" : "fail"}`;
    case "agent.error":
      return `agent.error ${ev.agent} ${ev.code}`;
    case "agent.state":
      return `agent.state ${ev.agent} ${ev.state}`;
    case "unit.handup":
      return `unit.handup ${ev.agent}→${ev.parent} facts=${ev.facts_to_promote?.length ?? 0}`;
    case "pm.alert":
      return `alert ${ev.severity} ${ev.code} ${ev.agent}`;
    case "memory.snapshot":
      return `memory.snapshot ${ev.agent}`;
    default:
      return ev.type;
  }
}

class Timeline {
  readonly entries: string[] = [];
  readonly pm = new ProcessManager();
  private readonly secretaries: SecretaryProxy[] = [];

  constructor() {
    // index.tsx subscribes ProcessManager "event" and applies pm.alert to the store.
    this.pm.on("event", (ev: TuiEvent) => {
      if (ev.type === "pm.alert") {
        this.entries.push(fmt(ev));
        applyEvent(ev);
      }
    });
  }

  /** Boot the permanent PM agent, as index.tsx does at startup. */
  boot(): void {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });
  }

  /** Attach a real SecretaryProxy for an agent (writes under tmp cwd). */
  attachSecretary(agentId: string, agentType: "PM" | "LEADER" | "WORKER", depth: number): SecretaryProxy {
    const sec = new SecretaryProxy(
      createMemory({
        agentId, agentType,
        parentChain: [], depth, model: "test", roleName: agentType,
      }),
    );
    this.secretaries.push(sec);
    return sec;
  }

  /** Feed raw LLM output text through the real parser, routing like index.tsx. */
  feed(agentId: string, raw: string): void {
    parseAgentOutput(raw, agentId, (ev) => this.route(ev));
  }

  /** Route a single event: spawn gate → store → PM observe → secretaries. */
  route(ev: TuiEvent): void {
    this.entries.push(fmt(ev));
    if (ev.type === "spawn") {
      const parentRole = getState().agents.get(ev.parent)?.role;
      const check = this.pm.preCheckSpawn(ev, parentRole);
      if (!check.ok) {
        this.entries.push(`gate✗ ${check.code}`);
        return; // index.tsx drops rejected spawns; alert already recorded
      }
      this.entries.push(`gate✓ ${ev.child}`);
    }
    applyEvent(ev);
    this.pm.observe(ev);
    for (const sec of this.secretaries) sec.observe(ev);
  }

  destroy(): void {
    this.pm.destroy();
    for (const sec of this.secretaries) sec.destroy();
  }
}

const DISPATCH: DispatchSpec = {
  background: "golden baseline task",
  constraints: [],
  acceptance_criteria: ["assertions pass"],
  stop_conditions: ["done"],
};

const dispatchJson = JSON.stringify(DISPATCH);

// ── T1 · PM→TL→Worker happy path ─────────────────────────────────────────────

describe("golden: hierarchy happy path", () => {
  let t: Timeline;
  beforeEach(() => { _resetForTest(); t = new Timeline(); t.boot(); });
  afterEach(() => t.destroy());

  it("records spawn → work → handup → done event sequence and final store state", () => {
    // PM turn: reply to user + spawn TL
    t.feed("pm", [
      `{"type":"message","to":"user","text":"收到，安排 TL 处理"}`,
      ``,
      `{"type":"spawn","parent":"pm","child":"tl-1","role":"Leader","goal":"实现功能 X","dispatch":${dispatchJson}}`,
    ].join("\n"));

    // TL lifecycle: starts running, spawns worker
    t.route({ v: 1, type: "agent.state", agent: "tl-1", state: "run", sub: "thinking…" });
    t.feed("tl-1", [
      `{"type":"todo.set","items":[{"text":"拆解任务","state":"done"},{"text":"派发 worker","state":"doing"}]}`,
      ``,
      `{"type":"spawn","parent":"tl-1","child":"w-1","role":"Worker","goal":"写实现","dispatch":${dispatchJson}}`,
    ].join("\n"));

    // Worker lifecycle: run → tool call → result → handup → done
    t.route({ v: 1, type: "agent.state", agent: "w-1", state: "run", sub: "thinking…" });
    t.feed("w-1", [
      `{"type":"tool.call","id":"t1","name":"Read","args":{"path":"src/a.ts"}}`,
      ``,
      `{"type":"tool.result","id":"t1","ok":true,"output":"file contents"}`,
      ``,
      `{"type":"unit.handup","parent":"tl-1","summary":"实现完成","artifacts":["src/a.ts"],"facts_to_promote":["模块 A 用单例模式"],"decisions":[],"failed_acceptance":[]}`,
      ``,
      `{"type":"agent.done","success":true,"reason":"实现并验证完成"}`,
    ].join("\n"));

    // TL wraps up
    t.feed("tl-1", [
      `{"type":"message","to":"user","text":"功能 X 已完成"}`,
      ``,
      `{"type":"agent.done","success":true,"reason":"worker 交付通过验收"}`,
    ].join("\n"));

    assert.deepEqual(t.entries, [
      `message pm→user "收到，安排 TL 处理"`,
      `spawn pm→tl-1 Leader goal="实现功能 X"`,
      `gate✓ tl-1`,
      `agent.state tl-1 run`,
      `todo.set tl-1 [done:拆解任务|doing:派发 worker]`,
      `spawn tl-1→w-1 Worker goal="写实现"`,
      `gate✓ w-1`,
      `agent.state w-1 run`,
      `tool.call w-1 Read#t1`,
      `tool.result w-1 #t1 ok`,
      `unit.handup w-1→tl-1 facts=1`,
      `agent.done w-1 success`,
      `message tl-1→user "功能 X 已完成"`,
      `agent.done tl-1 success`,
    ]);

    // Final store state
    const s = getState();
    assert.equal(s.agents.get("pm")?.state, "run");
    assert.equal(s.agents.get("tl-1")?.state, "done");
    assert.equal(s.agents.get("w-1")?.state, "done");
    assert.equal(s.agents.get("tl-1")?.parent, "pm");
    assert.equal(s.agents.get("w-1")?.parent, "tl-1");
    assert.equal(s.agents.get("w-1")?.goal, "写实现");
    assert.equal(s.pendingApprovals.length, 0);
  });
});

// ── T2 · Spawn governance gates ──────────────────────────────────────────────

describe("golden: spawn governance", () => {
  let t: Timeline;
  beforeEach(() => { _resetForTest(); t = new Timeline(); t.boot(); });
  afterEach(() => t.destroy());

  it("PM cannot spawn Worker directly", () => {
    t.route({ v: 1, type: "spawn", parent: "pm", child: "w-x", role: "Worker", goal: "direct", dispatch: DISPATCH });
    assert.deepEqual(t.entries, [
      `spawn pm→w-x Worker goal="direct"`,
      `alert error pm_cannot_spawn_worker pm`,
      `gate✗ pm_cannot_spawn_worker`,
    ]);
    assert.equal(getState().agents.has("w-x"), false);
  });

  it("Worker cannot spawn anyone", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    ensureAgent({ id: "w-1", name: "w-1", role: "Worker", state: "run", parent: "tl-1" });
    t.route({ v: 1, type: "spawn", parent: "w-1", child: "w-2", role: "Worker", goal: "sub", dispatch: DISPATCH });
    assert.deepEqual(t.entries, [
      `spawn w-1→w-2 Worker goal="sub"`,
      `alert error worker_cannot_spawn w-1`,
      `gate✗ worker_cannot_spawn`,
    ]);
  });

  it("spawn without dispatch is rejected", () => {
    t.route({ v: 1, type: "spawn", parent: "pm", child: "tl-x", role: "Leader", goal: "no dispatch" });
    assert.deepEqual(t.entries, [
      `spawn pm→tl-x Leader goal="no dispatch"`,
      `alert error dispatch_missing pm`,
      `gate✗ dispatch_missing`,
    ]);
  });

  it("spawn with empty acceptance_criteria is rejected", () => {
    t.route({
      v: 1, type: "spawn", parent: "pm", child: "tl-x", role: "Leader", goal: "bad dispatch",
      dispatch: { ...DISPATCH, acceptance_criteria: [] },
    });
    assert.deepEqual(t.entries, [
      `spawn pm→tl-x Leader goal="bad dispatch"`,
      `alert error dispatch_missing_acceptance pm`,
      `gate✗ dispatch_missing_acceptance`,
    ]);
  });

  it("duplicate goal under same parent is rejected (whitespace/case-insensitive)", () => {
    t.route({ v: 1, type: "spawn", parent: "pm", child: "tl-a", role: "Leader", goal: "Fix  Bug", dispatch: DISPATCH });
    t.route({ v: 1, type: "spawn", parent: "pm", child: "tl-b", role: "Leader", goal: "fix bug", dispatch: DISPATCH });
    assert.deepEqual(t.entries, [
      `spawn pm→tl-a Leader goal="Fix  Bug"`,
      `gate✓ tl-a`,
      `spawn pm→tl-b Leader goal="fix bug"`,
      `alert error duplicate_goal pm`,
      `gate✗ duplicate_goal`,
    ]);
  });

  it("fanout limit blocks spawn beyond maxFanout running children", () => {
    t.pm.setFanout(2);
    t.route({ v: 1, type: "spawn", parent: "pm", child: "tl-a", role: "Leader", goal: "goal a", dispatch: DISPATCH });
    t.route({ v: 1, type: "agent.state", agent: "tl-a", state: "run" });
    t.route({ v: 1, type: "spawn", parent: "pm", child: "tl-b", role: "Leader", goal: "goal b", dispatch: DISPATCH });
    t.route({ v: 1, type: "agent.state", agent: "tl-b", state: "run" });
    t.route({ v: 1, type: "spawn", parent: "pm", child: "tl-c", role: "Leader", goal: "goal c", dispatch: DISPATCH });
    assert.deepEqual(t.entries, [
      `spawn pm→tl-a Leader goal="goal a"`,
      `gate✓ tl-a`,
      `agent.state tl-a run`,
      `spawn pm→tl-b Leader goal="goal b"`,
      `gate✓ tl-b`,
      `agent.state tl-b run`,
      `spawn pm→tl-c Leader goal="goal c"`,
      `alert error fanout_exceeded pm`,
      `gate✗ fanout_exceeded`,
    ]);
  });

  it("depth ≥ 2 agent cannot spawn Leader", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    ensureAgent({ id: "mid-2", name: "mid-2", role: "Leader", state: "run", parent: "tl-1" });
    t.route({ v: 1, type: "spawn", parent: "mid-2", child: "tl-deep", role: "Leader", goal: "deep", dispatch: DISPATCH });
    assert.deepEqual(t.entries, [
      `spawn mid-2→tl-deep Leader goal="deep"`,
      `alert error depth_role_violation mid-2`,
      `gate✗ depth_role_violation`,
    ]);
  });
});

// ── T3 · Tool approval flow (store-level) ────────────────────────────────────

describe("golden: tool approval flow", () => {
  let t: Timeline;
  beforeEach(() => { _resetForTest(); t = new Timeline(); t.boot(); });
  afterEach(() => t.destroy());

  it("needs_approval queues; approve clears and marks; reject clears without marking", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    ensureAgent({ id: "w-1", name: "w-1", role: "Worker", state: "run", parent: "tl-1" });

    // Destructive bash → routed to approval
    t.route({ v: 1, type: "tool.call", agent: "w-1", id: "b1", name: "Bash",
              args: { command: "rm -rf build" }, needs_approval: true });
    let s = getState();
    assert.equal(s.pendingApprovals.length, 1);
    assert.equal(s.pendingApprovals[0]!.tool_id, "b1");
    assert.equal(s.pendingApprovals[0]!.approved, false);
    assert.equal(s.pendingApprovals[0]!.level, "warn");

    approve("b1");
    s = getState();
    assert.equal(s.pendingApprovals.length, 0);
    const msgs1 = s.messagesByAgent.get("w-1")!;
    assert.equal(msgs1.find((m) => m.tool_id === "b1")?.approved, true);

    // Second call rejected
    t.route({ v: 1, type: "tool.call", agent: "w-1", id: "b2", name: "Bash",
              args: { command: "git push --force" }, needs_approval: true });
    assert.equal(getState().pendingApprovals.length, 1);
    reject("b2");
    s = getState();
    assert.equal(s.pendingApprovals.length, 0);
    assert.equal(s.messagesByAgent.get("w-1")!.find((m) => m.tool_id === "b2")?.approved, false);

    // Non-destructive call never queues
    t.route({ v: 1, type: "tool.call", agent: "w-1", id: "r1", name: "Read",
              args: { path: "a.ts" }, needs_approval: false });
    assert.equal(getState().pendingApprovals.length, 0);

    assert.deepEqual(t.entries, [
      `tool.call w-1 Bash#b1 needs_approval`,
      `tool.call w-1 Bash#b2 needs_approval`,
      `tool.call w-1 Read#r1`,
    ]);
  });
});

// ── T4 · Communication matrix ────────────────────────────────────────────────

describe("golden: communication matrix", () => {
  let t: Timeline;
  beforeEach(() => { _resetForTest(); t = new Timeline(); t.boot(); });
  afterEach(() => t.destroy());

  it("worker→user and worker→worker are flagged; leader→leader passes silently", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    ensureAgent({ id: "w-1", name: "w-1", role: "Worker", state: "run", parent: "tl-1" });
    ensureAgent({ id: "w-2", name: "w-2", role: "Worker", state: "run", parent: "tl-1" });

    t.route({ v: 1, type: "message", agent: "w-1", to: "user", text: "直接汇报给用户" });
    t.route({ v: 1, type: "message", agent: "w-1", to: "w-2", text: "worker 私聊" });
    t.route({ v: 1, type: "message", agent: "tl-1", to: "pm", text: "leader 上报" });

    assert.deepEqual(t.entries, [
      `message w-1→user "直接汇报给用户"`,
      `alert warn illegal_message w-1`,
      `message w-1→w-2 "worker 私聊"`,
      `alert warn illegal_message w-1`,
      `message tl-1→pm "leader 上报"`,
    ]);

    // Store mirrors non-user messages into both sender and recipient panes
    const w2msgs = getState().messagesByAgent.get("w-2")!;
    assert.equal(w2msgs.some((m) => m.text.includes("← @w-1")), true);
    const pmMsgs = getState().messagesByAgent.get("pm")!;
    assert.equal(pmMsgs.some((m) => m.text.includes("← @tl-1")), true);
  });
});

// ── T5 · Protocol parsing golden (real normalizer, no store) ─────────────────

describe("golden: protocol parsing", () => {
  function parse(raw: string, agentId = "a1"): string[] {
    const out: string[] = [];
    parseAgentOutput(raw, agentId, (ev) => out.push(fmt(ev)));
    return out;
  }

  it("prose line followed by protocol JSON", () => {
    assert.deepEqual(
      parse(`好的，我来处理。\n{"type":"message","to":"user","text":"开始"}`),
      [`message a1→user "好的，我来处理。" (fallback)`, `message a1→user "开始"`],
    );
  });

  it("inline JSON after prose on the same line", () => {
    assert.deepEqual(
      parse(`收到 {"type":"step","text":"分析中"}`),
      [`message a1→user "收到" (fallback)`, `step a1 "分析中"`],
    );
  });

  it("markdown fences are stripped", () => {
    assert.deepEqual(
      parse('```json\n{"type":"step","text":"walk"}\n```'),
      [`step a1 "walk"`],
    );
  });

  it("<thinking> blocks collapse to a single thinking step", () => {
    assert.deepEqual(
      parse(`<thinking>\n内部推理第一行\n第二行\n</thinking>\n{"type":"message","to":"user","text":"结论"}`),
      [`step a1 "thinking…"`, `message a1→user "结论"`],
    );
  });

  it("unescaped newline inside JSON string is repaired", () => {
    assert.deepEqual(
      parse(`{"type":"message","to":"user","text":"第一行\n第二行"}`),
      [`message a1→user "第一行\n第二行"`],
    );
  });

  it("missing closing brace is repaired", () => {
    assert.deepEqual(
      parse(`{"type":"step","text":"未闭合"`),
      [`step a1 "未闭合"`],
    );
  });

  it("plain-text agent.done is synthesized into a real event", () => {
    assert.deepEqual(
      parse(`任务完成了，agent.done`),
      [`agent.done a1 success`],
    );
  });

  it("unknown event type is dropped silently", () => {
    assert.deepEqual(parse(`{"type":"planning","text":"内部计划"}`), []);
  });

  it("broken JSON-like output is dropped, not shown as fallback", () => {
    assert.deepEqual(parse(`{"type": planning oops`), []);
  });

  it("bare prose falls back to message-to-user with fallback marker", () => {
    assert.deepEqual(
      parse(`这只是一句普通的话`),
      [`message a1→user "这只是一句普通的话" (fallback)`],
    );
  });

  it("think events become 💭 steps", () => {
    assert.deepEqual(
      parse(`{"type":"think","thought":"先看 registry"}`),
      [`step a1 "💭 先看 registry"`],
    );
  });
});

// ── T6 · Terminal state protection ───────────────────────────────────────────

describe("golden: terminal state does not regress", () => {
  let t: Timeline;
  beforeEach(() => { _resetForTest(); t = new Timeline(); t.boot(); });
  afterEach(() => t.destroy());

  it("agent.state:idle after agent.done keeps state=done", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    t.route({ v: 1, type: "agent.done", agent: "tl-1", success: true, reason: "done" });
    // HttpConvAgent emits idle as the stream closes — must not resurrect the agent
    t.route({ v: 1, type: "agent.state", agent: "tl-1", state: "idle" });
    assert.equal(getState().agents.get("tl-1")?.state, "done");
  });

  it("agent.state:idle after agent.error keeps state=err", () => {
    ensureAgent({ id: "w-1", name: "w-1", role: "Worker", state: "run", parent: "pm" });
    t.route({ v: 1, type: "agent.error", agent: "w-1", code: "http_error", detail: "boom" });
    t.route({ v: 1, type: "agent.state", agent: "w-1", state: "idle" });
    assert.equal(getState().agents.get("w-1")?.state, "err");
  });
});

// ── T7 · Secretary memory sequence ───────────────────────────────────────────

describe("golden: secretary memory accumulation", () => {
  let t: Timeline;
  beforeEach(() => { _resetForTest(); t = new Timeline(); t.boot(); });
  afterEach(() => t.destroy());

  it("tool results, decisions, todos, spawns and done land in memory deterministically", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    const sec = t.attachSecretary("tl-1", "LEADER", 1);

    t.route({ v: 1, type: "tool.result", agent: "tl-1", id: "t1", ok: true, output: "registry has 12 tools" });
    t.route({ v: 1, type: "message", agent: "tl-1", to: "pm", text: "决定采用方案 B，因为改动面小" });
    t.route({ v: 1, type: "todo.set", agent: "tl-1", items: [
      { id: "1", text: "评审方案", state: "done" },
      { id: "2", text: "实现", state: "run" },
    ] });
    t.route({ v: 1, type: "spawn", parent: "tl-1", child: "w-1", role: "Worker", goal: "写实现", dispatch: DISPATCH });
    t.route({ v: 1, type: "agent.done", agent: "w-1", success: true, reason: "done" });
    t.route({ v: 1, type: "agent.done", agent: "tl-1", success: true, reason: "全部完成" });

    const mem = sec.getMemory();
    assert.deepEqual(
      mem.working_set.facts.map((f) => ({ text: f.text, src: f.src })),
      [{ text: "registry has 12 tools", src: "tool:t1" }],
    );
    assert.deepEqual(
      mem.working_set.decisions.map((d) => d.text),
      ["决定采用方案 B，因为改动面小", "已完成: 评审方案"],
    );
    assert.deepEqual(
      mem.child_handles.map((h) => ({ agent_id: h.agent_id, status: h.status, goal: h.goal })),
      [{ agent_id: "w-1", status: "done", goal: "写实现" }],
    );
    assert.equal(mem.tombstone.final_status, "done");
    assert.equal(mem.tombstone.compact_summary?.startsWith("全部完成"), true);

    // Persisted file reflects the same state (MemoryStore round-trip)
    const loaded = loadMemory("tl-1");
    assert.equal(loaded?.tombstone.final_status, "done");
    assert.equal(loaded?.working_set.facts.length, 1);
  });

  it("btw message from user is recorded as a fact", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    const sec = t.attachSecretary("tl-1", "LEADER", 1);
    t.route({ v: 1, type: "message", agent: "pm", to: "tl-1", text: "btw: 部署窗口是周五" });
    assert.deepEqual(
      sec.getMemory().working_set.facts.map((f) => ({ text: f.text, src: f.src })),
      [{ text: "[btw] 部署窗口是周五", src: "btw:user" }],
    );
  });
});
