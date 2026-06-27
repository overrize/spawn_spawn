/**
 * Unit tests for LogContextBuilder — shadowDiff cause classification.
 *
 * Covers the four miss kinds and all MissCause values without touching the
 * filesystem or the real bus (buildLogContextFromMemory is tested via its pure inputs).
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert/strict";

import { SpawnBus } from "../../bus/Bus.js";

// SpawnBus ring size is set at module load via LOG_RING_SIZE (env BUS_LOG_SIZE).
// For the gap test we need overflow — publish more than LOG_RING_SIZE events.
// We use a large-enough count (3000) that works with any reasonable default.
const OVERFLOW_COUNT = 3000;
import {
  buildLogContextFromMemory,
  shadowDiff,
  logShadowDiff,
} from "../../context/LogContextBuilder.js";
import type { AgentMemory } from "../../memory/types.js";
import type { ShadowMiss } from "../../context/LogContextBuilder.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<AgentMemory["working_set"]> = {}, tombstone: Partial<AgentMemory["tombstone"]> = {}): AgentMemory {
  return {
    schema_version: 1,
    agent_id: "test-agent",
    agent_type: "WORKER",
    parent_chain: [],
    depth: 2,
    created_at: Date.now(),
    updated_at: Date.now(),
    identity: { role_name: "Worker", skills: [], model: "claude-sonnet-4-6" },
    dispatch: { background: "", constraints: [], acceptance_criteria: [], stop_conditions: [] },
    working_set: {
      facts: [],
      decisions: [],
      open_questions: [],
      ...overrides,
    },
    child_handles: [],
    tombstone: {
      compact_summary: null,
      final_status: null,
      final_artifacts: [],
      resume_hint: null,
      ...tombstone,
    },
  };
}

type Msg = { role: "user" | "assistant"; content: string };
function u(content: string): Msg { return { role: "user", content }; }
function a(content: string): Msg { return { role: "assistant", content }; }

function missKinds(misses: ShadowMiss[]) { return misses.map((m) => m.kind); }
function missCauses(misses: ShadowMiss[]) { return misses.map((m) => m.cause); }

// ── Override globalBus to a fresh bus per test suite ─────────────────────────
// LogContextBuilder imports globalBus from Bus.js — we monkey-patch the module
// by setting the bus epoch to something predictable so cursor checks work.

describe("buildLogContextFromMemory", () => {
  it("returns empty messages when no facts/decisions/todos/events", () => {
    const bus = new SpawnBus();
    const mem = makeMemory();
    // Align cursor epoch so it's treated as same-process
    mem.tombstone.log_cursor = bus.getHeadOffset();
    mem.tombstone.log_cursor_epoch = bus.getEpoch();

    const ctx = buildLogContextFromMemory("test-agent", mem, bus);
    assert.equal(ctx.messages.length, 0);
    assert.equal(ctx.hasGap, false);
    assert.equal(ctx.stats.factCount, 0);
  });

  it("includes facts block when memory has facts", () => {
    const bus = new SpawnBus();
    const mem = makeMemory({
      facts: [{ id: "f1", text: "TypeScript project", src: "tool:Read", ts: Date.now(), weight: 3 }],
    });
    mem.tombstone.log_cursor = bus.getHeadOffset();
    mem.tombstone.log_cursor_epoch = bus.getEpoch();

    const ctx = buildLogContextFromMemory("test-agent", mem, bus);
    assert.equal(ctx.messages.length, 1);
    assert.ok(ctx.messages[0]!.content.includes("TypeScript project"));
    assert.equal(ctx.stats.factCount, 1);
  });

  it("includes active todos from tombstone.last_todo", () => {
    const bus = new SpawnBus();
    const mem = makeMemory({}, {
      last_todo: JSON.stringify([
        { state: "run", text: "implement feature X" },
        { state: "done", text: "write tests" },
      ]),
    });
    mem.tombstone.log_cursor = bus.getHeadOffset();
    mem.tombstone.log_cursor_epoch = bus.getEpoch();

    const ctx = buildLogContextFromMemory("test-agent", mem, bus);
    assert.ok(ctx.messages[0]!.content.includes("implement feature X"), "active todo included");
    assert.ok(!ctx.messages[0]!.content.includes("write tests"), "done todo excluded");
  });

  it("hasGap=true when cursor is behind oldest ring entry", () => {
    const bus = new SpawnBus();
    // Fill past the default ring size (2000) so the oldest offset is evicted
    for (let i = 0; i < OVERFLOW_COUNT; i++) {
      bus.publish({ v: 1, type: "agent.state", agent: "other", state: "run", sub: "" });
    }
    const mem = makeMemory();
    mem.tombstone.log_cursor = 0; // cursor before ring start
    mem.tombstone.log_cursor_epoch = bus.getEpoch();

    const ctx = buildLogContextFromMemory("test-agent", mem, bus);
    assert.equal(ctx.hasGap, true);
    assert.ok(ctx.messages[0]!.content.startsWith("[GAP WARNING]"));
  });

  it("discards cursor when epoch mismatches (cross-restart scenario)", () => {
    const bus = new SpawnBus();
    bus.publish({ v: 1, type: "agent.state", agent: "test-agent", state: "run", sub: "" });

    const mem = makeMemory();
    mem.tombstone.log_cursor = 0;
    mem.tombstone.log_cursor_epoch = "dead-epoch-from-previous-process";

    // epoch mismatch → cursor reset to headOffset → zero delta events
    const ctx = buildLogContextFromMemory("test-agent", mem, bus);
    assert.equal(ctx.stats.deltaEventCount, 0, "stale cursor discarded");
    assert.equal(ctx.hasGap, false);
  });
});

// ── shadowDiff ────────────────────────────────────────────────────────────────

describe("shadowDiff — gap", () => {
  it("emits gap/ring-overflow when newCtx.hasGap is true", () => {
    const newCtx = {
      messages: [],
      hasGap: true,
      stats: { factCount: 0, decisionCount: 0, deltaEventCount: 0, fromOffset: 3, headOffset: 15 },
    };
    const misses = shadowDiff([], newCtx);
    assert.ok(missKinds(misses).includes("gap"));
    assert.ok(missCauses(misses).includes("ring-overflow"));
  });
});

describe("shadowDiff — recent-user-msg cause classification", () => {
  const emptyCtx = {
    messages: [],
    hasGap: false,
    stats: { factCount: 0, decisionCount: 0, deltaEventCount: 0, fromOffset: 0, headOffset: 0 },
  };

  it("classifies slash command as slash-command", () => {
    const misses = shadowDiff([u("/resume abc123")], emptyCtx);
    const msg = misses.find((m) => m.kind === "recent-user-msg");
    assert.equal(msg?.cause, "slash-command");
  });

  it("classifies short imperative as nudge", () => {
    const misses = shadowDiff([u("继续，把测试补完")], emptyCtx);
    const msg = misses.find((m) => m.kind === "recent-user-msg");
    assert.equal(msg?.cause, "nudge");
  });

  it("classifies structured multi-line task as task-injection", () => {
    const task = "## 任务\ngoal: 修复 Feishu 连接问题\n- 步骤1\n- 步骤2";
    const misses = shadowDiff([u(task)], emptyCtx);
    const msg = misses.find((m) => m.kind === "recent-user-msg");
    assert.equal(msg?.cause, "task-injection");
  });

  it("classifies message with tool_result header as tool-result-text", () => {
    const content = "[tool_result id=t1 ok=true]\n{\"output\": \"done\"}\nSome human-readable follow-up text that is long enough to matter here.";
    const misses = shadowDiff([u(content)], emptyCtx);
    const msg = misses.find((m) => m.kind === "recent-user-msg");
    assert.equal(msg?.cause, "tool-result-text");
  });

  it("skips short/protocol-only user messages", () => {
    const misses = shadowDiff([u("ok")], emptyCtx);
    assert.equal(misses.length, 0);
  });

  it("no miss when newCtx content covers the probe", () => {
    const ctx = {
      messages: [{ role: "user" as const, content: "继续，把测试补完 — this is already in log context" }],
      hasGap: false,
      stats: { factCount: 0, decisionCount: 0, deltaEventCount: 0, fromOffset: 0, headOffset: 0 },
    };
    const misses = shadowDiff([u("继续，把测试补完 — this is already in log context")], ctx);
    assert.equal(misses.filter((m) => m.kind === "recent-user-msg").length, 0);
  });
});

describe("shadowDiff — todo-missing", () => {
  const emptyCtx = {
    messages: [],
    hasGap: false,
    stats: { factCount: 0, decisionCount: 0, deltaEventCount: 0, fromOffset: 0, headOffset: 0 },
  };

  it("tombstone-null when no facts exist (Secretary never saw this agent)", () => {
    const msgs = [a("当前进度: [run] 实现 feature X\n[todo] 写测试")];
    const misses = shadowDiff(msgs, emptyCtx);
    const m = misses.find((x) => x.kind === "todo-missing");
    assert.equal(m?.cause, "tombstone-null");
  });

  it("tombstone-stale when facts exist but todo block missing", () => {
    const ctxWithFacts = {
      messages: [{ role: "user" as const, content: "【已确认事实】\n  [w=2] TypeScript project" }],
      hasGap: false,
      stats: { factCount: 3, decisionCount: 0, deltaEventCount: 0, fromOffset: 0, headOffset: 0 },
    };
    const msgs = [a("当前进度: [run] 实现 feature X")];
    const misses = shadowDiff(msgs, ctxWithFacts);
    const m = misses.find((x) => x.kind === "todo-missing");
    assert.equal(m?.cause, "tombstone-stale");
  });

  it("no miss when todo block present in newCtx", () => {
    const ctxWithTodo = {
      messages: [{ role: "user" as const, content: "【当前 todo】\n  [run] 实现 feature X" }],
      hasGap: false,
      stats: { factCount: 1, decisionCount: 0, deltaEventCount: 0, fromOffset: 0, headOffset: 0 },
    };
    const msgs = [a("[run] 实现 feature X")];
    const misses = shadowDiff(msgs, ctxWithTodo);
    assert.equal(misses.filter((m) => m.kind === "todo-missing").length, 0);
  });
});

describe("shadowDiff — decision-missing", () => {
  const emptyCtx = {
    messages: [],
    hasGap: false,
    stats: { factCount: 0, decisionCount: 0, deltaEventCount: 0, fromOffset: 0, headOffset: 0 },
  };

  it("flags keyword-miss when assistant turn has decision keyword not in newCtx", () => {
    const msgs = [a("我们决定采用 TypeScript 重写这个模块，因为类型安全更重要")];
    const misses = shadowDiff(msgs, emptyCtx);
    const m = misses.find((x) => x.kind === "decision-missing");
    assert.ok(m, "decision-missing miss present");
    assert.equal(m?.cause, "keyword-miss");
  });

  it("no decision-missing when content is covered in newCtx", () => {
    const covered = {
      messages: [{ role: "user" as const, content: "我们决定采用 TypeScript 重写这个模块，因为类型安全更重要" }],
      hasGap: false,
      stats: { factCount: 0, decisionCount: 1, deltaEventCount: 0, fromOffset: 0, headOffset: 0 },
    };
    const msgs = [a("我们决定采用 TypeScript 重写这个模块，因为类型安全更重要")];
    const misses = shadowDiff(msgs, covered);
    assert.equal(misses.filter((m) => m.kind === "decision-missing").length, 0);
  });
});

describe("logShadowDiff output format", () => {
  it("OK no-miss on clean run", () => {
    const lines: string[] = [];
    logShadowDiff("pm-1", 3, {
      messages: [],
      hasGap: false,
      stats: { factCount: 2, decisionCount: 1, deltaEventCount: 5, fromOffset: 0, headOffset: 5 },
    }, [], (l) => lines.push(l));
    assert.ok(lines.some((l) => l.includes("OK no-miss")), "no-miss marker");
    assert.ok(lines.some((l) => l.includes("facts=2")), "stats included");
    assert.ok(lines.some((l) => l.includes("[shadow-ctx]")), "prefix present");
  });

  it("MISS with cause tally and kind/cause format", () => {
    const lines: string[] = [];
    logShadowDiff("pm-1", 4, {
      messages: [],
      hasGap: false,
      stats: { factCount: 0, decisionCount: 0, deltaEventCount: 0, fromOffset: 0, headOffset: 0 },
    }, [
      { kind: "recent-user-msg", cause: "nudge", detail: "继续" },
      { kind: "recent-user-msg", cause: "nudge", detail: "好的" },
      { kind: "todo-missing", cause: "tombstone-stale", detail: "stale" },
    ], (l) => lines.push(l));
    const combined = lines.join("\n");
    assert.ok(combined.includes("nudgex2"), "nudge tally");
    assert.ok(combined.includes("tombstone-stalex1"), "tombstone tally");
    assert.ok(combined.includes("[recent-user-msg/nudge]"), "kind/cause format");
    assert.ok(combined.includes("MISS 3"), "miss count");
  });
});
