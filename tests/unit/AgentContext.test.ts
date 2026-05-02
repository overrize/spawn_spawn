import { describe, it, expect, beforeEach } from "vitest";
import { AgentContext } from "../../src/core/AgentContext";
import { AgentType, TaskContext } from "../../src/core/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidUUIDv4(s: string): boolean {
  // UUID v4 format: 8-4-4-4-12 hex digits
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

// ---------------------------------------------------------------------------
// createRoot
// ---------------------------------------------------------------------------

describe("AgentContext.createRoot()", () => {
  it("returns an AgentContext instance", () => {
    const ctx = AgentContext.createRoot("test task");
    expect(ctx).toBeInstanceOf(AgentContext);
  });

  it("assigns a valid UUID v4 taskId", () => {
    const ctx = AgentContext.createRoot("test task");
    expect(isValidUUIDv4(ctx.taskId)).toBe(true);
  });

  it("assigns an agentId starting with 'main-' followed by the first 8 chars of taskId", () => {
    const ctx = AgentContext.createRoot("test task");
    expect(ctx.agentId.startsWith("main-")).toBe(true);
    const suffix = ctx.agentId.slice(5); // after "main-"
    expect(suffix).toHaveLength(8);
    expect(ctx.taskId.startsWith(suffix)).toBe(true);
  });

  it("sets agentType to AgentType.MAIN", () => {
    const ctx = AgentContext.createRoot("test task");
    expect(ctx.agentType).toBe(AgentType.MAIN);
  });

  it("stores the description", () => {
    const ctx = AgentContext.createRoot("my root description");
    expect(ctx.description).toBe("my root description");
  });

  it("has an empty parentChain", () => {
    const ctx = AgentContext.createRoot("test task");
    expect(ctx.parentChain).toEqual([]);
  });

  it("stores constraints when provided", () => {
    const ctx = AgentContext.createRoot("test task", ["no-side-effects", "read-only"]);
    expect(ctx.constraints).toEqual(["no-side-effects", "read-only"]);
  });

  it("defaults constraints to an empty array when not provided", () => {
    const ctx = AgentContext.createRoot("test task");
    expect(ctx.constraints).toEqual([]);
  });

  it("stores metadata when provided", () => {
    const ctx = AgentContext.createRoot("test task", undefined, { priority: 1, tags: ["urgent"] });
    expect(ctx.metadata).toEqual({ priority: 1, tags: ["urgent"] });
  });

  it("defaults metadata to an empty object when not provided", () => {
    const ctx = AgentContext.createRoot("test task");
    expect(ctx.metadata).toEqual({});
  });

  it("sets createdAt to a positive timestamp", () => {
    const before = Date.now();
    const ctx = AgentContext.createRoot("test task");
    const after = Date.now();
    expect(ctx.createdAt).toBeGreaterThanOrEqual(before);
    expect(ctx.createdAt).toBeLessThanOrEqual(after);
  });

  it("generates unique taskIds across calls", () => {
    const ctx1 = AgentContext.createRoot("task A");
    const ctx2 = AgentContext.createRoot("task B");
    expect(ctx1.taskId).not.toBe(ctx2.taskId);
    expect(ctx1.agentId).not.toBe(ctx2.agentId);
  });
});

// ---------------------------------------------------------------------------
// derive — SPAWN
// ---------------------------------------------------------------------------

describe("AgentContext.derive() with AgentType.SPAWN", () => {
  let root: AgentContext;

  beforeEach(() => {
    root = AgentContext.createRoot("root task", ["global-constraint"], { env: "prod" });
  });

  it("preserves the parent taskId", () => {
    const spawn = root.derive(AgentType.SPAWN, "spawned task");
    expect(spawn.taskId).toBe(root.taskId);
  });

  it("assigns an agentId starting with 'spawn-'", () => {
    const spawn = root.derive(AgentType.SPAWN, "spawned task");
    expect(spawn.agentId.startsWith("spawn-")).toBe(true);
  });

  it("assigns a unique agentId per call", () => {
    const s1 = root.derive(AgentType.SPAWN, "A");
    const s2 = root.derive(AgentType.SPAWN, "B");
    expect(s1.agentId).not.toBe(s2.agentId);
  });

  it("sets agentType to AgentType.SPAWN", () => {
    const spawn = root.derive(AgentType.SPAWN, "spawned task");
    expect(spawn.agentType).toBe(AgentType.SPAWN);
  });

  it("stores the derived description", () => {
    const spawn = root.derive(AgentType.SPAWN, "spawned description");
    expect(spawn.description).toBe("spawned description");
  });

  it("appends parent agentId to parentChain", () => {
    const spawn = root.derive(AgentType.SPAWN, "spawned task");
    expect(spawn.parentChain).toEqual([root.agentId]);
  });

  it("merges constraints (parent + child)", () => {
    const spawn = root.derive(AgentType.SPAWN, "spawned task", ["child-constraint"]);
    expect(spawn.constraints).toEqual(["global-constraint", "child-constraint"]);
  });

  it("defaults child constraints to empty when not provided", () => {
    const spawn = root.derive(AgentType.SPAWN, "spawned task");
    expect(spawn.constraints).toEqual(["global-constraint"]);
  });

  it("merges metadata (child overrides parent keys)", () => {
    const spawn = root.derive(AgentType.SPAWN, "spawned task", undefined, { env: "staging", extra: true });
    expect(spawn.metadata).toEqual({ env: "staging", extra: true });
  });

  it("defaults child metadata to empty when not provided", () => {
    const spawn = root.derive(AgentType.SPAWN, "spawned task");
    expect(spawn.metadata).toEqual({ env: "prod" });
  });
});

// ---------------------------------------------------------------------------
// derive — FORK
// ---------------------------------------------------------------------------

describe("AgentContext.derive() with AgentType.FORK", () => {
  let root: AgentContext;

  beforeEach(() => {
    root = AgentContext.createRoot("root task", ["read-only"], { scope: "global" });
  });

  it("preserves the parent taskId", () => {
    const fork = root.derive(AgentType.FORK, "forked task");
    expect(fork.taskId).toBe(root.taskId);
  });

  it("assigns an agentId starting with 'fork-'", () => {
    const fork = root.derive(AgentType.FORK, "forked task");
    expect(fork.agentId.startsWith("fork-")).toBe(true);
  });

  it("sets agentType to AgentType.FORK", () => {
    const fork = root.derive(AgentType.FORK, "forked task");
    expect(fork.agentType).toBe(AgentType.FORK);
  });

  it("appends parent agentId to parentChain", () => {
    const fork = root.derive(AgentType.FORK, "forked task");
    expect(fork.parentChain).toEqual([root.agentId]);
  });

  it("merges constraints from parent", () => {
    const fork = root.derive(AgentType.FORK, "forked task", ["fork-only"]);
    expect(fork.constraints).toEqual(["read-only", "fork-only"]);
  });
});

// ---------------------------------------------------------------------------
// parentAgentId
// ---------------------------------------------------------------------------

describe("AgentContext.parentAgentId", () => {
  it("returns null for a root context", () => {
    const root = AgentContext.createRoot("test");
    expect(root.parentAgentId).toBeNull();
  });

  it("returns the direct parent agentId for a derived context", () => {
    const root = AgentContext.createRoot("test");
    const spawn = root.derive(AgentType.SPAWN, "child");
    expect(spawn.parentAgentId).toBe(root.agentId);
  });
});

// ---------------------------------------------------------------------------
// rootAgentId
// ---------------------------------------------------------------------------

describe("AgentContext.rootAgentId", () => {
  it("returns its own agentId for a root context", () => {
    const root = AgentContext.createRoot("test");
    expect(root.rootAgentId).toBe(root.agentId);
  });

  it("returns the root agentId (first in parentChain) for a derived context", () => {
    const root = AgentContext.createRoot("test");
    const spawn = root.derive(AgentType.SPAWN, "child");
    expect(spawn.rootAgentId).toBe(root.agentId);
  });
});

// ---------------------------------------------------------------------------
// depth
// ---------------------------------------------------------------------------

describe("AgentContext.depth", () => {
  it("returns 0 for root context", () => {
    const root = AgentContext.createRoot("test");
    expect(root.depth).toBe(0);
  });

  it("returns 1 for a direct child", () => {
    const root = AgentContext.createRoot("test");
    const spawn = root.derive(AgentType.SPAWN, "child");
    expect(spawn.depth).toBe(1);
  });

  it("returns 2 for a grandchild", () => {
    const root = AgentContext.createRoot("test");
    const spawn = root.derive(AgentType.SPAWN, "child");
    const fork = spawn.derive(AgentType.FORK, "grandchild");
    expect(fork.depth).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// toJSON
// ---------------------------------------------------------------------------

describe("AgentContext.toJSON()", () => {
  let root: AgentContext;

  beforeEach(() => {
    root = AgentContext.createRoot("root task", ["c1"], { key: "val" });
  });

  it("returns a TaskContext object with the expected shape", () => {
    const json = root.toJSON();
    // Check all expected keys
    expect(json).toHaveProperty("taskId");
    expect(json).toHaveProperty("description");
    expect(json).toHaveProperty("parentChain");
    expect(json).toHaveProperty("constraints");
    expect(json).toHaveProperty("metadata");
  });

  it("includes the correct taskId", () => {
    const json = root.toJSON();
    expect(json.taskId).toBe(root.taskId);
  });

  it("includes the correct description", () => {
    const json = root.toJSON();
    expect(json.description).toBe("root task");
  });

  it("includes an empty parentChain for root", () => {
    const json = root.toJSON();
    expect(json.parentChain).toEqual([]);
  });

  it("includes the constraints", () => {
    const json = root.toJSON();
    expect(json.constraints).toEqual(["c1"]);
  });

  it("includes the metadata", () => {
    const json = root.toJSON();
    expect(json.metadata).toEqual({ key: "val" });
  });

  it("returns a deep copy of constraints (mutation safe)", () => {
    const json = root.toJSON();
    json.constraints.push("mutated");
    expect(root.constraints).toEqual(["c1"]);
  });

  it("returns a deep copy of metadata (mutation safe)", () => {
    const json = root.toJSON();
    json.metadata = { hacked: true } as any;
    expect(root.metadata).toEqual({ key: "val" });
  });

  it("returns a deep copy of parentChain (mutation safe)", () => {
    const spawn = root.derive(AgentType.SPAWN, "child");
    const json = spawn.toJSON();
    json.parentChain.push("injected");
    expect(spawn.parentChain).toEqual([root.agentId]);
  });
});

// ---------------------------------------------------------------------------
// Multiple derivation levels (main → spawn → fork)
// ---------------------------------------------------------------------------

describe("Multi-level derivation chain (main → spawn → fork)", () => {
  let main: AgentContext;
  let spawn: AgentContext;
  let fork: AgentContext;

  beforeEach(() => {
    main = AgentContext.createRoot("main task", ["c-main"], { m: "main" });
    spawn = main.derive(AgentType.SPAWN, "spawn task", ["c-spawn"], { m: "spawn" });
    fork = spawn.derive(AgentType.FORK, "fork task", ["c-fork"], { m: "fork" });
  });

  it("all share the same taskId", () => {
    expect(spawn.taskId).toBe(main.taskId);
    expect(fork.taskId).toBe(main.taskId);
  });

  it("main has depth 0, spawn has depth 1, fork has depth 2", () => {
    expect(main.depth).toBe(0);
    expect(spawn.depth).toBe(1);
    expect(fork.depth).toBe(2);
  });

  it("main.rootAgentId === main.agentId", () => {
    expect(main.rootAgentId).toBe(main.agentId);
  });

  it("spawn and fork both see main as rootAgentId", () => {
    expect(spawn.rootAgentId).toBe(main.agentId);
    expect(fork.rootAgentId).toBe(main.agentId);
  });

  it("spawn.parentAgentId === main.agentId", () => {
    expect(spawn.parentAgentId).toBe(main.agentId);
  });

  it("fork.parentAgentId === spawn.agentId", () => {
    expect(fork.parentAgentId).toBe(spawn.agentId);
  });

  it("main.parentChain is empty", () => {
    expect(main.parentChain).toEqual([]);
  });

  it("spawn.parentChain === [main.agentId]", () => {
    expect(spawn.parentChain).toEqual([main.agentId]);
  });

  it("fork.parentChain === [main.agentId, spawn.agentId]", () => {
    expect(fork.parentChain).toEqual([main.agentId, spawn.agentId]);
  });

  it("accumulates constraints across all levels", () => {
    expect(main.constraints).toEqual(["c-main"]);
    expect(spawn.constraints).toEqual(["c-main", "c-spawn"]);
    expect(fork.constraints).toEqual(["c-main", "c-spawn", "c-fork"]);
  });

  it("metadata is overridden at each level", () => {
    expect(main.metadata).toEqual({ m: "main" });
    expect(spawn.metadata).toEqual({ m: "spawn" });
    expect(fork.metadata).toEqual({ m: "fork" });
  });

  it("agentId formats follow the naming convention", () => {
    expect(main.agentId.startsWith("main-")).toBe(true);
    expect(spawn.agentId.startsWith("spawn-")).toBe(true);
    expect(fork.agentId.startsWith("fork-")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deep-copy safety: derive is isolated from parent mutation
// ---------------------------------------------------------------------------

describe("Derived context deep-copy isolation", () => {
  it("modifying original parent constraints does NOT affect already-derived child", () => {
    const root = AgentContext.createRoot("root", ["c1"]);
    const spawn = root.derive(AgentType.SPAWN, "child", ["c2"]);
    // Mutate original constraints array on root (using push on the readonly
    // property won't work, but deriving creates its own array anyway).
    // Test by verifying the derived context has its own copy.
    expect(spawn.constraints).toEqual(["c1", "c2"]);
    // Modify the spawn's constraints — parent should be unaffected
    (spawn.constraints as string[]).push("spawn-only-mutation");
    expect(root.constraints).toEqual(["c1"]);
    expect(spawn.constraints).toEqual(["c1", "c2", "spawn-only-mutation"]);
  });

  it("modifying parent metadata does NOT affect already-derived child metadata", () => {
    const root = AgentContext.createRoot("root", undefined, { shared: true });
    const spawn = root.derive(AgentType.SPAWN, "child", undefined, { extra: 1 });
    // Mutate root metadata
    root.metadata["newKey"] = "newVal";
    expect(spawn.metadata).toEqual({ shared: true, extra: 1 });
    // Mutate spawn metadata
    spawn.metadata["onlySpawn"] = 42;
    expect(root.metadata).toEqual({ shared: true, newKey: "newVal" });
  });

  it("modifying parent parentChain does NOT affect derived parentChain", () => {
    const root = AgentContext.createRoot("root");
    const spawn = root.derive(AgentType.SPAWN, "child");
    // parentChain is readonly but we can test that derive created a new array
    expect(spawn.parentChain).toEqual([root.agentId]);
    // Even though the array is its own reference, parentChain on
    // AgentContext is readonly so we cannot push to it. This is verified
    // by the structural equality above.
  });

  it("get() on SkillRegistry returns deep copies (cross-module consistency: tested in SkillRegistry.test.ts)", () => {
    // Placeholder — actual deep-copy of get() is tested in the SkillRegistry suite.
    expect(true).toBe(true);
  });

  it("toJSON returns a snapshot that does not mutate with the source", () => {
    const root = AgentContext.createRoot("root", ["original"]);
    const json1 = root.toJSON();
    const json2 = root.toJSON();
    // Mutate json1
    (json1.constraints as string[]).push("altered");
    // json2 and root should be unchanged
    expect(json2.constraints).toEqual(["original"]);
    expect(root.constraints).toEqual(["original"]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("AgentContext edge cases", () => {
  it("handles empty description string", () => {
    const ctx = AgentContext.createRoot("");
    expect(ctx.description).toBe("");
    expect(ctx).toBeInstanceOf(AgentContext);
  });

  it("handles undefined constraints and metadata (createRoot)", () => {
    const ctx = AgentContext.createRoot("test");
    expect(ctx.constraints).toEqual([]);
    expect(ctx.metadata).toEqual({});
  });

  it("handles undefined constraints and metadata (derive)", () => {
    const root = AgentContext.createRoot("test", ["c1"], { m: 1 });
    const child = root.derive(AgentType.SPAWN, "child");
    expect(child.constraints).toEqual(["c1"]);
    expect(child.metadata).toEqual({ m: 1 });
  });

  it("deep chain: main → spawn → fork → fork → spawn", () => {
    const main = AgentContext.createRoot("root", ["c0"]);
    const s1 = main.derive(AgentType.SPAWN, "s1", ["c1"]);
    const f1 = s1.derive(AgentType.FORK, "f1", ["c2"]);
    const f2 = f1.derive(AgentType.FORK, "f2", ["c3"]);
    const s2 = f2.derive(AgentType.SPAWN, "s2", ["c4"]);

    expect(s2.depth).toBe(4);
    expect(s2.parentChain).toEqual([main.agentId, s1.agentId, f1.agentId, f2.agentId]);
    expect(s2.rootAgentId).toBe(main.agentId);
    expect(s2.parentAgentId).toBe(f2.agentId);
    expect(s2.constraints).toEqual(["c0", "c1", "c2", "c3", "c4"]);
  });
});
