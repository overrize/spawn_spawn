import { describe, it, expect, beforeEach, vi } from "vitest";
import { MainAgent } from "../../src/agent/MainAgent";
import { AgentContext } from "../../src/core/AgentContext";
import { AgentStatus, AgentType, MemoryEventType } from "../../src/core/types";

describe("ForkAgent", () => {
  let mainAgent: MainAgent;

  beforeEach(() => {
    mainAgent = new MainAgent(AgentContext.createRoot("test", ["constraint1"]));
  });

  function createFork() {
    const spawn = mainAgent.spawn({ taskDescription: "Spawn task" });
    return { spawn, fork: spawn.fork({ taskDescription: "Fork task" }) };
  }

  // ─── Properties ──────────────────────────────────────────────────

  describe("properties", () => {
    it("should have type FORK", () => {
      const { fork } = createFork();
      expect(fork.type).toBe(AgentType.FORK);
    });

    it("should have a valid id starting with fork-", () => {
      const { fork } = createFork();
      expect(fork.id).toMatch(/^fork-/);
    });

    it("should start with IDLE status", () => {
      const { fork } = createFork();
      expect(fork.status).toBe(AgentStatus.IDLE);
    });

    it("should reference spawnParent", () => {
      const { spawn, fork } = createFork();
      expect(fork.spawnParent).toBe(spawn);
    });

    it("should have spawnParentId set correctly", () => {
      const { spawn, fork } = createFork();
      expect(fork.spawnParentId).toBe(spawn.id);
    });
  });

  // ─── init() independent lifecycle ────────────────────────────────

  describe("init() independent lifecycle", () => {
    it("should transition IDLE → RUNNING", async () => {
      const { fork } = createFork();
      await fork.init();
      expect(fork.status).toBe(AgentStatus.RUNNING);
    });

    it("can init independently of Spawn's state", async () => {
      const { spawn, fork } = createFork();
      // Fork init while Spawn is still IDLE
      await fork.init();
      expect(fork.status).toBe(AgentStatus.RUNNING);
      expect(spawn.status).toBe(AgentStatus.IDLE);
    });

    it("can pause independently of Spawn", async () => {
      const { spawn, fork } = createFork();
      await fork.init();
      await fork.pause();
      expect(fork.status).toBe(AgentStatus.PAUSED);
      expect(spawn.status).toBe(AgentStatus.IDLE);
    });

    it("can resume independently of Spawn", async () => {
      const { fork } = createFork();
      await fork.init();
      await fork.pause();
      await fork.resume();
      expect(fork.status).toBe(AgentStatus.RUNNING);
    });

    it("can terminate independently of Spawn", async () => {
      const { spawn, fork } = createFork();
      await fork.init();
      await fork.terminate();
      expect(fork.status).toBe(AgentStatus.TERMINATED);
      expect(spawn.status).toBe(AgentStatus.IDLE);
    });

    it("should support full lifecycle: init → pause → resume → terminate", async () => {
      const { fork } = createFork();
      await fork.init();
      await fork.pause();
      await fork.resume();
      await fork.terminate();
      expect(fork.status).toBe(AgentStatus.TERMINATED);
    });
  });

  // ─── Memory Operations (shared with Spawn) ───────────────────────

  describe("memory operations", () => {
    it("should set and get via fork, visible to Spawn", () => {
      const { spawn, fork } = createFork();
      fork.memorySet("fork-key", "fork-value");
      expect(fork.memoryGet("fork-key")).toBe("fork-value");
      expect(spawn.memoryGet("fork-key")).toBe("fork-value");
    });

    it("should return undefined for non-existent key", () => {
      const { fork } = createFork();
      expect(fork.memoryGet("missing")).toBeUndefined();
    });

    it("should overwrite values", () => {
      const { spawn, fork } = createFork();
      fork.memorySet("key", "first");
      fork.memorySet("key", "second");
      expect(spawn.memoryGet("key")).toBe("second");
    });

    it("should delete and return true", () => {
      const { spawn, fork } = createFork();
      fork.memorySet("del-me", "value");
      expect(fork.memoryDelete("del-me")).toBe(true);
      expect(spawn.memoryGet("del-me")).toBeUndefined();
    });

    it("should return false when deleting non-existent key", () => {
      const { fork } = createFork();
      expect(fork.memoryDelete("nope")).toBe(false);
    });

    it("should clear all shared memory", () => {
      const { spawn, fork } = createFork();
      spawn.memorySet("a", 1);
      fork.memorySet("b", 2);
      fork.memoryClear();
      expect(spawn.memoryGet("a")).toBeUndefined();
      expect(fork.memoryGet("b")).toBeUndefined();
    });

    it("should support arrays and nested objects", () => {
      const { spawn, fork } = createFork();
      fork.memorySet("arr", [1, { nested: true }]);
      expect(spawn.memoryGet("arr")).toEqual([1, { nested: true }]);
    });

    it("should support null values", () => {
      const { spawn, fork } = createFork();
      fork.memorySet("nullable", null);
      expect(spawn.memoryGet("nullable")).toBeNull();
    });
  });

  // ─── Memory Events ───────────────────────────────────────────────

  describe("memory events", () => {
    it("should fire onMemoryChange on set", () => {
      const { fork } = createFork();
      const callback = vi.fn();
      fork.onMemoryChange(callback);
      fork.memorySet("k", "v");
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].type).toBe(MemoryEventType.SET);
    });

    it("should fire onMemoryChange on delete", () => {
      const { fork } = createFork();
      fork.memorySet("k", "v");
      const callback = vi.fn();
      fork.onMemoryChange(callback);
      fork.memoryDelete("k");
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].type).toBe(MemoryEventType.DELETE);
    });

    it("should fire onMemoryKeyChange for specific key only", () => {
      const { fork } = createFork();
      const callback = vi.fn();
      fork.onMemoryKeyChange("target", callback);
      fork.memorySet("other", "x");
      expect(callback).not.toHaveBeenCalled();
      fork.memorySet("target", "hit");
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("unsubscribe from onMemoryChange should work", () => {
      const { fork } = createFork();
      const callback = vi.fn();
      const unsub = fork.onMemoryChange(callback);
      unsub();
      fork.memorySet("k", "v");
      expect(callback).not.toHaveBeenCalled();
    });

    it("unsubscribe from onMemoryKeyChange should work", () => {
      const { fork } = createFork();
      const callback = vi.fn();
      const unsub = fork.onMemoryKeyChange("k", callback);
      unsub();
      fork.memorySet("k", "v");
      expect(callback).not.toHaveBeenCalled();
    });

    it("onMemoryChange on ForkAgent fires for Spawn writes too", () => {
      const { spawn, fork } = createFork();
      const callback = vi.fn();
      fork.onMemoryChange(callback);
      spawn.memorySet("spawn-key", "spawn-value");
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].key).toBe("spawn-key");
    });
  });

  // ─── Serialize / Deserialize Memory ──────────────────────────────

  describe("serializeMemory / deserializeMemory", () => {
    it("should round-trip serialize/deserialize via fork", () => {
      const { spawn, fork } = createFork();
      fork.memorySet("x", "val");
      fork.memorySet("y", 99);

      const snapshot = fork.serializeMemory();
      fork.memoryClear();
      fork.deserializeMemory(snapshot);

      expect(spawn.memoryGet("x")).toBe("val");
      expect(spawn.memoryGet("y")).toBe(99);
    });
  });

  // ─── hasSkill ────────────────────────────────────────────────────

  describe("hasSkill()", () => {
    it("should return true for registered skills", () => {
      mainAgent.registerSkill("skill-1", "First skill");
      const { fork } = createFork();
      expect(fork.hasSkill("skill-1")).toBe(true);
    });

    it("should return false for unregistered skills", () => {
      const { fork } = createFork();
      expect(fork.hasSkill("nonexistent")).toBe(false);
    });

    it("should reflect newly registered skills", () => {
      const { fork } = createFork();
      expect(fork.hasSkill("new-skill")).toBe(false);
      mainAgent.registerSkill("new-skill", "New skill");
      expect(fork.hasSkill("new-skill")).toBe(true);
    });
  });

  // ─── Context Inheritance ─────────────────────────────────────────

  describe("context inheritance", () => {
    it("should share taskId with Spawn", () => {
      const { spawn, fork } = createFork();
      expect(fork.context.taskId).toBe(spawn.context.taskId);
    });

    it("should share taskId with Main agent", () => {
      const { fork } = createFork();
      expect(fork.context.taskId).toBe(mainAgent.context.taskId);
    });

    it("should have parentChain: Main → Spawn → Fork", () => {
      const { spawn, fork } = createFork();
      const chain = fork.context.parentChain;

      // parentChain should contain Main and Spawn IDs
      expect(chain).toContain(mainAgent.id);
      expect(chain).toContain(spawn.id);
      // Main should be before Spawn in the chain
      expect(chain.indexOf(mainAgent.id)).toBeLessThan(chain.indexOf(spawn.id));
    });

    it("should inherit constraints from parent chain", () => {
      const { spawn, fork } = createFork();
      // Fork should have Main's constraint
      expect(fork.context.constraints).toContain("constraint1");
      // And Spawn's constraint
      expect(fork?.context?.constraints?.length).toBeGreaterThanOrEqual(1);
    });

    it("should have correct agent type in context", () => {
      const { fork } = createFork();
      expect(fork.context.agentType).toBe(AgentType.FORK);
    });
  });

  // ─── Parent Chain Depth ──────────────────────────────────────────

  describe("parent chain depth", () => {
    it("Main should have depth 0", () => {
      expect(mainAgent.context.depth).toBe(0);
    });

    it("Spawn should have depth 1", () => {
      const spawn = mainAgent.spawn({ taskDescription: "T1" });
      expect(spawn.context.depth).toBe(1);
    });

    it("Fork should have depth 2", () => {
      const spawn = mainAgent.spawn({ taskDescription: "T1" });
      const fork = spawn.fork({ taskDescription: "F1" });
      expect(fork.context.depth).toBe(2);
    });
  });

  // ─── execute() ───────────────────────────────────────────────────

  describe("execute()", () => {
    it("should execute when RUNNING", async () => {
      const { fork } = createFork();
      await fork.init();
      await fork.execute(); // should not throw
    });

    it("should throw when not RUNNING", async () => {
      const { fork } = createFork();
      await expect(fork.execute()).rejects.toThrow(/not RUNNING/);
    });

    it("should throw when PAUSED", async () => {
      const { fork } = createFork();
      await fork.init();
      await fork.pause();
      await expect(fork.execute()).rejects.toThrow(/not RUNNING/);
    });
  });

  // ─── ForkAgent cannot fork further ───────────────────────────────

  describe("fork() not available on ForkAgent", () => {
    it("should not have a fork() method", () => {
      const { fork } = createFork();
      expect((fork as any).fork).toBeUndefined();
      expect(typeof (fork as any).fork).toBe("undefined");
    });

    it("should not have a spawn() method", () => {
      const { fork } = createFork();
      expect((fork as any).spawn).toBeUndefined();
    });

    it("verify ForkAgent type is FORK (not SPAWN or MAIN)", () => {
      const { fork } = createFork();
      expect(fork.type).toBe(AgentType.FORK);
      expect(fork.type).not.toBe(AgentType.SPAWN);
      expect(fork.type).not.toBe(AgentType.MAIN);
    });
  });

  // ─── Cascading: Spawn terminate → Fork terminate ─────────────────

  describe("cascading terminate from Spawn", () => {
    it("terminating Spawn should terminate Fork", async () => {
      const { spawn, fork } = createFork();
      await fork.init();
      await spawn.terminate();
      expect(fork.status).toBe(AgentStatus.TERMINATED);
    });

    it("terminating main should cascade through spawn to fork", async () => {
      await mainAgent.init();
      const spawn = mainAgent.spawn({ taskDescription: "S1" });
      await spawn.init();
      const fork = spawn.fork({ taskDescription: "F1" });
      await fork.init();

      await mainAgent.terminate();

      expect(fork.status).toBe(AgentStatus.TERMINATED);
      expect(spawn.status).toBe(AgentStatus.TERMINATED);
      expect(mainAgent.status).toBe(AgentStatus.TERMINATED);
    });
  });

  // ─── ForkAgent events from Spawn writes ──────────────────────────

  describe("cross-agent memory events", () => {
    it("ForkAgent onMemoryChange should fire when another ForkAgent writes", () => {
      const spawn = mainAgent.spawn({ taskDescription: "S" });
      const fork1 = spawn.fork({ taskDescription: "F1" });
      const fork2 = spawn.fork({ taskDescription: "F2" });

      const callback = vi.fn();
      fork1.onMemoryChange(callback);

      fork2.memorySet("cross-fork-key", "from fork2");
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].agentId).toBe(fork2.id);
    });
  });

  // ─── Multiple ForkAgents from same Spawn ─────────────────────────

  describe("multiple forks", () => {
    it("should all share the same memory", () => {
      const spawn = mainAgent.spawn({ taskDescription: "S" });
      const f1 = spawn.fork({ taskDescription: "F1" });
      const f2 = spawn.fork({ taskDescription: "F2" });

      f1.memorySet("data", "from f1");
      expect(f2.memoryGet("data")).toBe("from f1");
    });

    it("should each have independent lifecycle", async () => {
      const spawn = mainAgent.spawn({ taskDescription: "S" });
      const f1 = spawn.fork({ taskDescription: "F1" });
      const f2 = spawn.fork({ taskDescription: "F2" });

      await f1.init();
      await f1.terminate();

      // f2 remains IDLE, unaffected
      expect(f2.status).toBe(AgentStatus.IDLE);
      expect(f1.status).toBe(AgentStatus.TERMINATED);
    });
  });
});
