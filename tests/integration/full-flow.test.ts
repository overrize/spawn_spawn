/**
 * Full Flow Integration Tests
 *
 * Exercises the complete MainAgent → SpawnAgent → ForkAgent workflow,
 * verifying all architectural properties: lifecycle management, memory sharing,
 * context propagation, event emission, error handling, and cascading termination.
 *
 * Uses only vitest. No external libraries. Self-contained, no setup file.
 */

import { describe, it, expect, vi } from "vitest";
import {
  MainAgent,
  SpawnAgent,
  ForkAgent,
  AgentContext,
  AgentStatus,
  AgentType,
  InvalidTransitionError,
} from "../../src/";
import type { MemoryEventPayload, MemorySnapshot } from "../../src/";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create and init a MainAgent with optional root constraints/metadata */
async function createMain(
  description = "integration test",
  constraints?: string[],
  metadata?: Record<string, unknown>,
): Promise<MainAgent> {
  const ctx = AgentContext.createRoot(description, constraints, metadata as any);
  const main = new MainAgent(ctx);
  await main.init();
  return main;
}

/** Spawn and init a child via Main */
async function createSpawn(
  main: MainAgent,
  description: string,
  constraints?: string[],
  metadata?: Record<string, unknown>,
): Promise<SpawnAgent> {
  const spawn = main.spawn({
    taskDescription: description,
    constraints,
    metadata: metadata as any,
  });
  await spawn.init();
  return spawn;
}

/** Fork and init from a SpawnAgent via Main */
async function createFork(
  main: MainAgent,
  spawnId: string,
  description: string,
  constraints?: string[],
  metadata?: Record<string, unknown>,
): Promise<ForkAgent> {
  const fork = main.fork(spawnId, {
    taskDescription: description,
    constraints,
    metadata: metadata as any,
  });
  await fork.init();
  return fork;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 1: Full lifecycle (main→spawn→fork)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario 1: Full lifecycle (main→spawn→fork)", () => {
  it("should exercise the complete lifecycle with correct state management, independence, and cascading termination", async () => {
    // ── Phase 1: Create MainAgent, init it ──────────────────────────────────
    const main = await createMain("full-lifecycle task", ["root-constraint"]);

    // ── Phase 2: Register 2 skills on Main ──────────────────────────────────
    main.registerSkill("skill-alpha", "Alpha skill", "1.0.0");
    main.registerSkill("skill-beta", "Beta skill", "2.0.0");
    expect(main.skills.size).toBe(2);
    expect(main.skills.has("skill-alpha")).toBe(true);
    expect(main.skills.has("skill-beta")).toBe(true);

    // ── Phase 3: Spawn 2 SpawnAgents from Main, init both ───────────────────
    const spawn1 = await createSpawn(main, "spawn task 1", ["c-spawn-1"]);
    const spawn2 = await createSpawn(main, "spawn task 2");
    expect(spawn1.status).toBe(AgentStatus.RUNNING);
    expect(spawn2.status).toBe(AgentStatus.RUNNING);
    expect(main.childCount).toBe(2);

    // ── Phase 4: Fork 2 ForkAgents from SpawnAgent-1, init both ─────────────
    const forkA = await createFork(main, spawn1.id, "fork task A");
    const forkB = await createFork(main, spawn1.id, "fork task B");
    expect(forkA.status).toBe(AgentStatus.RUNNING);
    expect(forkB.status).toBe(AgentStatus.RUNNING);
    expect(spawn1.forkCount).toBe(2);

    // ── Phase 5: Verify all agents are RUNNING ──────────────────────────────
    expect(main.status).toBe(AgentStatus.RUNNING);
    expect(spawn1.status).toBe(AgentStatus.RUNNING);
    expect(spawn2.status).toBe(AgentStatus.RUNNING);
    expect(forkA.status).toBe(AgentStatus.RUNNING);
    expect(forkB.status).toBe(AgentStatus.RUNNING);

    // ── Phase 6: Verify ForkAgents share Spawn-1's memory ───────────────────
    forkA.memorySet("shared-key", "hello-from-forkA");
    expect(forkB.memoryGet("shared-key")).toBe("hello-from-forkA");
    expect(spawn1.memoryGet("shared-key")).toBe("hello-from-forkA");

    // ── Phase 7: Verify ForkAgents inherit correct context ──────────────────
    // Same taskId as Main
    expect(forkA.context.taskId).toBe(main.context.taskId);
    expect(forkB.context.taskId).toBe(main.context.taskId);
    // parentChain = [mainId, spawnId] → depth = 2
    expect(forkA.context.parentChain).toEqual([main.id, spawn1.id]);
    expect(forkA.context.depth).toBe(2);
    expect(forkB.context.parentChain).toEqual([main.id, spawn1.id]);
    expect(forkB.context.depth).toBe(2);

    // ── Phase 8: Verify SpawnAgents share Main's skills ─────────────────────
    expect(spawn1.skills.has("skill-alpha")).toBe(true);
    expect(spawn1.skills.has("skill-beta")).toBe(true);
    expect(spawn2.skills.has("skill-alpha")).toBe(true);
    expect(spawn2.skills.has("skill-beta")).toBe(true);
    // ForkAgents access skills via spawnParent
    expect(forkA.hasSkill("skill-alpha")).toBe(true);
    expect(forkB.hasSkill("skill-beta")).toBe(true);

    // ── Phase 9: Pause Fork-A ──────────────────────────────────────────────
    await forkA.pause();
    expect(forkA.status).toBe(AgentStatus.PAUSED);
    // Spawn-1 still RUNNING (independent management)
    expect(spawn1.status).toBe(AgentStatus.RUNNING);
    // Fork-B still RUNNING (independent management)
    expect(forkB.status).toBe(AgentStatus.RUNNING);

    // ── Phase 10: Resume Fork-A ────────────────────────────────────────────
    await forkA.resume();
    expect(forkA.status).toBe(AgentStatus.RUNNING);

    // ── Phase 11: Terminate Fork-A ─────────────────────────────────────────
    await spawn1.terminateFork(forkA.id);
    expect(forkA.status).toBe(AgentStatus.TERMINATED);
    // Fork-B still RUNNING
    expect(forkB.status).toBe(AgentStatus.RUNNING);
    // Spawn-1 still RUNNING
    expect(spawn1.status).toBe(AgentStatus.RUNNING);
    expect(spawn1.forkCount).toBe(1); // only forkB remains

    // ── Phase 12: Terminate Spawn-1 (cascades to remaining Forks) ──────────
    await main.terminateChild(spawn1.id);
    expect(spawn1.status).toBe(AgentStatus.TERMINATED);
    // Fork-B also terminated via cascade
    expect(forkB.status).toBe(AgentStatus.TERMINATED);
    expect(main.childCount).toBe(1); // only spawn2 remains

    // ── Phase 13: Terminate Main → everything terminated ────────────────────
    await main.terminate();
    expect(main.status).toBe(AgentStatus.TERMINATED);
    // spawn2 also terminated via cascade
    expect(spawn2.status).toBe(AgentStatus.TERMINATED);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 2: Memory sharing & serialization
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario 2: Memory sharing & serialization", () => {
  it("should share memory across forks, emit events on changes, support serialization round-trip, and clear correctly", async () => {
    const main = await createMain("memory-test");

    // Spawn a SpawnAgent, init it
    const spawn = await createSpawn(main, "memory spawn");

    // Fork 3 ForkAgents, init all
    const forkA = await createFork(main, spawn.id, "fork A");
    const forkB = await createFork(main, spawn.id, "fork B");
    const forkC = await createFork(main, spawn.id, "fork C");

    // ── Step 1: Fork-A writes → Fork-B and Fork-C can read ─────────────────
    forkA.memorySet("data-key", "original-value");
    expect(forkB.memoryGet("data-key")).toBe("original-value");
    expect(forkC.memoryGet("data-key")).toBe("original-value");
    expect(spawn.memoryGet("data-key")).toBe("original-value");

    // ── Step 2: Fork-B writes (overwrite) → Fork-A sees new value ──────────
    forkB.memorySet("data-key", "overwritten-by-B");
    expect(forkA.memoryGet("data-key")).toBe("overwritten-by-B");
    expect(forkC.memoryGet("data-key")).toBe("overwritten-by-B");

    // ── Step 3: Subscribe on Fork-C → verify events fire on write ──────────
    const capturedEvents: MemoryEventPayload[] = [];
    const unsubscribe = forkC.onMemoryChange((payload) => {
      capturedEvents.push(payload);
    });

    forkA.memorySet("event-key", "event-value");
    expect(capturedEvents.length).toBe(1);
    expect(capturedEvents[0].type).toBe("memory:set");
    expect(capturedEvents[0].key).toBe("event-key");
    expect(capturedEvents[0].value).toBe("event-value");
    expect(capturedEvents[0].agentId).toBe(forkA.id);
    expect(typeof capturedEvents[0].timestamp).toBe("number");

    // Verify DELETE events also captured
    forkA.memoryDelete("event-key");
    expect(capturedEvents.length).toBe(2);
    expect(capturedEvents[1].type).toBe("memory:delete");
    expect(capturedEvents[1].key).toBe("event-key");

    unsubscribe();

    // ── Step 4: Delete key → verify all Forks see deletion ─────────────────
    expect(forkA.memoryGet("data-key")).toBe("overwritten-by-B");
    forkA.memoryDelete("data-key");
    expect(forkA.memoryGet("data-key")).toBeUndefined();
    expect(forkB.memoryGet("data-key")).toBeUndefined();
    expect(forkC.memoryGet("data-key")).toBeUndefined();
    expect(spawn.memoryGet("data-key")).toBeUndefined();

    // ── Step 5: Serialize → deserialize into new Spawn → verify data ───────
    forkA.memorySet("persist-str", "hello");
    forkA.memorySet("persist-num", 42);
    forkA.memorySet("persist-bool", true);

    const snapshot: MemorySnapshot = spawn.serializeMemory();
    expect(snapshot.entries).toBeDefined();
    expect(snapshot.createdBy).toBe(spawn.id);
    expect(typeof snapshot.createdAt).toBe("number");

    // Create a new spawn and deserialize
    const spawn2 = await createSpawn(main, "spawn 2 for deserialize");
    spawn2.deserializeMemory(snapshot);
    expect(spawn2.memoryGet("persist-str")).toBe("hello");
    expect(spawn2.memoryGet("persist-num")).toBe(42);
    expect(spawn2.memoryGet("persist-bool")).toBe(true);

    // Verify a fork of spawn2 also sees the restored data
    const forkD = await createFork(main, spawn2.id, "fork D");
    expect(forkD.memoryGet("persist-str")).toBe("hello");
    expect(forkD.memoryGet("persist-num")).toBe(42);
    expect(forkD.memoryGet("persist-bool")).toBe(true);

    // ── Step 6: Clear memory → verify all Forks see empty ──────────────────
    spawn.memoryClear();
    expect(spawn.sharedMemory.size).toBe(0);
    expect(forkA.memoryGet("persist-str")).toBeUndefined();
    expect(forkA.memoryGet("persist-num")).toBeUndefined();
    expect(forkB.memoryGet("persist-str")).toBeUndefined();
    expect(forkC.memoryGet("persist-str")).toBeUndefined();
    // spawn2's memory (separate instance) should be unaffected
    expect(spawn2.memoryGet("persist-str")).toBe("hello");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 3: Error & edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario 3: Error & edge cases", () => {
  // ── Fork from non-existent spawn → throws ─────────────────────────────────
  it("should throw when forking from a non-existent spawn", async () => {
    const main = await createMain("error-test-1");

    expect(() =>
      main.fork("non-existent-spawn-id", { taskDescription: "should fail" }),
    ).toThrow(/not found in children/);
  });

  // ── Fork from terminated spawn → throws ──────────────────────────────────
  it("should throw when forking from a terminated spawn", async () => {
    const main = await createMain("error-test-2");
    const spawn = await createSpawn(main, "temp-spawn");

    // Terminate the spawn directly (remains in main._children but status is TERMINATED)
    await spawn.terminate();
    expect(spawn.status).toBe(AgentStatus.TERMINATED);

    expect(() =>
      main.fork(spawn.id, { taskDescription: "should fail" }),
    ).toThrow(/Cannot fork/);
  });

  // ── Cannot transition ForkAgent from TERMINATED back to RUNNING ───────────
  it("should not allow a terminated ForkAgent to transition back to RUNNING", async () => {
    const main = await createMain("error-test-3");
    const spawn = await createSpawn(main, "temp-spawn");
    const fork = await createFork(main, spawn.id, "temp-fork");

    // Terminate the fork
    await spawn.terminateFork(fork.id);
    expect(fork.status).toBe(AgentStatus.TERMINATED);

    // Direct state transition should throw
    expect(() => fork.state.transition(AgentStatus.RUNNING)).toThrow(
      InvalidTransitionError,
    );

    // Attempting init on a terminated agent should not change state
    await fork.init();
    expect(fork.status).toBe(AgentStatus.TERMINATED);
    // An error should be captured internally
    expect(fork.error).not.toBeNull();
  });

  // ── ForkAgent.execute() when PAUSED → throws ─────────────────────────────
  it("should throw when executing a PAUSED ForkAgent", async () => {
    const main = await createMain("error-test-4");
    const spawn = await createSpawn(main, "temp-spawn");
    const fork = await createFork(main, spawn.id, "temp-fork");

    await fork.pause();
    expect(fork.status).toBe(AgentStatus.PAUSED);

    await expect(fork.execute()).rejects.toThrow(/not RUNNING/);
  });

  // ── Spawn with no forks → terminate → should not throw ───────────────────
  it("should not throw when terminating a spawn with no forks", async () => {
    const main = await createMain("error-test-5");
    const spawn = await createSpawn(main, "lonely-spawn");

    await expect(main.terminateChild(spawn.id)).resolves.not.toThrow();
    expect(spawn.status).toBe(AgentStatus.TERMINATED);
  });

  // ── Terminate Main with no spawns → should not throw ─────────────────────
  it("should not throw when terminating a MainAgent with no spawns", async () => {
    const main = await createMain("error-test-6");

    await expect(main.terminate()).resolves.not.toThrow();
    expect(main.status).toBe(AgentStatus.TERMINATED);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 4: Event propagation
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario 4: Event propagation", () => {
  it("should emit correct events on MainAgent and SpawnAgent with proper payloads", async () => {
    const main = await createMain("event-test");

    // ── Collect MainAgent events ────────────────────────────────────────────
    interface MainEvent {
      type: string;
      parentId?: string;
      childId?: string;
      spawnId?: string;
      forkId?: string;
      timestamp: number;
    }
    const mainEvents: MainEvent[] = [];
    main.events.on("spawn:created", (p) =>
      mainEvents.push({ type: "spawn:created", ...p }),
    );
    main.events.on("fork:created", (p) =>
      mainEvents.push({ type: "fork:created", ...p }),
    );
    main.events.on("spawn:terminated", (p) =>
      mainEvents.push({ type: "spawn:terminated", ...p }),
    );

    // ── Spawn and collect SpawnAgent events ─────────────────────────────────
    const spawn = await createSpawn(main, "event-spawn-task");

    interface SpawnEvent {
      type: string;
      spawnId?: string;
      forkId?: string;
      timestamp: number;
    }
    const spawnEvents: SpawnEvent[] = [];
    spawn.events.on("fork:created", (p) =>
      spawnEvents.push({ type: "fork:created", ...p }),
    );
    spawn.events.on("fork:terminated", (p) =>
      spawnEvents.push({ type: "fork:terminated", ...p }),
    );

    // ── Fork ────────────────────────────────────────────────────────────────
    const fork = await createFork(main, spawn.id, "event-fork-task");

    // ── Terminate fork ──────────────────────────────────────────────────────
    await spawn.terminateFork(fork.id);

    // ── Terminate spawn ─────────────────────────────────────────────────────
    await main.terminateChild(spawn.id);

    // ── Verify MainAgent events ─────────────────────────────────────────────
    // Expected: spawn:created, fork:created, spawn:terminated (3 events)
    expect(mainEvents.length).toBe(3);

    const spawnCreated = mainEvents.find((e) => e.type === "spawn:created");
    expect(spawnCreated).toBeDefined();
    expect(spawnCreated!.parentId).toBe(main.id);
    expect(spawnCreated!.childId).toBe(spawn.id);
    expect(typeof spawnCreated!.timestamp).toBe("number");
    expect(spawnCreated!.timestamp).toBeGreaterThan(0);

    const forkCreated = mainEvents.find((e) => e.type === "fork:created");
    expect(forkCreated).toBeDefined();
    expect(forkCreated!.spawnId).toBe(spawn.id);
    expect(forkCreated!.forkId).toBe(fork.id);
    expect(typeof forkCreated!.timestamp).toBe("number");
    expect(forkCreated!.timestamp).toBeGreaterThan(0);

    const spawnTerminated = mainEvents.find((e) => e.type === "spawn:terminated");
    expect(spawnTerminated).toBeDefined();
    expect(spawnTerminated!.childId).toBe(spawn.id);
    expect(typeof spawnTerminated!.timestamp).toBe("number");
    expect(spawnTerminated!.timestamp).toBeGreaterThan(0);

    // ── Verify SpawnAgent events ────────────────────────────────────────────
    // Expected: fork:created, fork:terminated (2 events)
    expect(spawnEvents.length).toBe(2);

    const spawnForkCreated = spawnEvents.find((e) => e.type === "fork:created");
    expect(spawnForkCreated).toBeDefined();
    expect(spawnForkCreated!.spawnId).toBe(spawn.id);
    expect(spawnForkCreated!.forkId).toBe(fork.id);
    expect(typeof spawnForkCreated!.timestamp).toBe("number");

    const forkTerminated = spawnEvents.find((e) => e.type === "fork:terminated");
    expect(forkTerminated).toBeDefined();
    expect(forkTerminated!.forkId).toBe(fork.id);
    expect(typeof forkTerminated!.timestamp).toBe("number");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Scenario 5: Context integrity
// ═══════════════════════════════════════════════════════════════════════════════

describe("Scenario 5: Context integrity", () => {
  it("should propagate consistent taskId across the entire main→spawn→fork chain", async () => {
    const main = await createMain("context-taskid-test");
    const spawn = await createSpawn(main, "spawn-task");
    const fork = await createFork(main, spawn.id, "fork-task");

    // All share the same taskId
    expect(main.context.taskId).toBeDefined();
    expect(spawn.context.taskId).toBe(main.context.taskId);
    expect(fork.context.taskId).toBe(main.context.taskId);
  });

  it("should maintain correct parentChain ordering [mainId, spawnId]", async () => {
    const main = await createMain("chain-test");
    const spawn = await createSpawn(main, "spawn");
    const fork = await createFork(main, spawn.id, "fork");

    // Main (root): empty parentChain, depth 0
    expect(main.context.parentChain).toEqual([]);
    expect(main.context.depth).toBe(0);

    // Spawn: parentChain = [main.id], depth 1
    expect(spawn.context.parentChain).toEqual([main.id]);
    expect(spawn.context.depth).toBe(1);

    // Fork: parentChain = [main.id, spawn.id], depth 2
    expect(fork.context.parentChain).toEqual([main.id, spawn.id]);
    expect(fork.context.depth).toBe(2);
  });

  it("should merge (not replace) constraints in child contexts", async () => {
    const main = await createMain("constraint-test", ["root-c1", "root-c2"]);
    const spawn = await createSpawn(main, "spawn", ["spawn-c1"]);
    const fork = await createFork(main, spawn.id, "fork", [
      "fork-c1",
      "fork-c2",
    ]);

    // Spawn: root constraints + spawn constraints (merged)
    expect(spawn.context.constraints).toEqual([
      "root-c1",
      "root-c2",
      "spawn-c1",
    ]);

    // Fork: root + spawn + fork constraints (accumulated)
    expect(fork.context.constraints).toEqual([
      "root-c1",
      "root-c2",
      "spawn-c1",
      "fork-c1",
      "fork-c2",
    ]);
  });

  it("should merge metadata with child-level overrides", async () => {
    const main = await createMain("metadata-test", undefined, {
      shared: "root-shared",
      rootOnly: "root-data",
    });
    const spawn = await createSpawn(main, "spawn", undefined, {
      shared: "spawn-override",
      spawnOnly: "spawn-data",
    });
    const fork = await createFork(main, spawn.id, "fork", undefined, {
      forkOnly: "fork-data",
    });

    // Spawn metadata: root merged with spawn (spawn overrides "shared")
    expect(spawn.context.metadata).toEqual({
      shared: "spawn-override",
      rootOnly: "root-data",
      spawnOnly: "spawn-data",
    });

    // Fork metadata: spawn merged with fork (fork adds "forkOnly")
    expect(fork.context.metadata).toEqual({
      shared: "spawn-override",
      rootOnly: "root-data",
      spawnOnly: "spawn-data",
      forkOnly: "fork-data",
    });
  });
});
