import { describe, it, expect, beforeEach, vi } from "vitest";
import { MainAgent } from "../../src/agent/MainAgent";
import { AgentContext } from "../../src/core/AgentContext";
import { AgentStatus, AgentType, MemoryEventType } from "../../src/core/types";

describe("SpawnAgent", () => {
  let mainAgent: MainAgent;

  beforeEach(() => {
    mainAgent = new MainAgent(AgentContext.createRoot("test"));
  });

  function createSpawn() {
    return mainAgent.spawn({
      taskDescription: "Sub task",
      constraints: ["spawn-c1"],
    });
  }

  // ─── Properties ──────────────────────────────────────────────────

  describe("properties", () => {
    it("should have type SPAWN", () => {
      const spawn = createSpawn();
      expect(spawn.type).toBe(AgentType.SPAWN);
    });

    it("should have a valid id starting with spawn-", () => {
      const spawn = createSpawn();
      expect(spawn.id).toMatch(/^spawn-/);
    });

    it("should start with IDLE status", () => {
      const spawn = createSpawn();
      expect(spawn.status).toBe(AgentStatus.IDLE);
    });

    it("should have parentId set to MainAgent id", () => {
      const spawn = createSpawn();
      expect(spawn.parentId).toBe(mainAgent.id);
    });

    it("should have skills shared from MainAgent", () => {
      mainAgent.registerSkill("skill-a", "Skill A");
      const spawn = createSpawn();
      expect(spawn.skills).toBeDefined();
      expect(spawn.skills.has("skill-a")).toBe(true);
    });

    it("should have a sharedMemory instance", () => {
      const spawn = createSpawn();
      expect(spawn.sharedMemory).toBeDefined();
    });

    it("should have events emitter", () => {
      const spawn = createSpawn();
      expect(spawn.events).toBeDefined();
    });
  });

  // ─── init() lifecycle ────────────────────────────────────────────

  describe("init() lifecycle", () => {
    it("should transition IDLE → RUNNING", async () => {
      const spawn = createSpawn();
      await spawn.init();
      expect(spawn.status).toBe(AgentStatus.RUNNING);
    });

    it("should support init → pause → resume → terminate", async () => {
      const spawn = createSpawn();
      await spawn.init();
      await spawn.pause();
      expect(spawn.status).toBe(AgentStatus.PAUSED);
      await spawn.resume();
      expect(spawn.status).toBe(AgentStatus.RUNNING);
      await spawn.terminate();
      expect(spawn.status).toBe(AgentStatus.TERMINATED);
    });
  });

  // ─── Memory Operations ───────────────────────────────────────────

  describe("memory operations", () => {
    it("should set and get a value", () => {
      const spawn = createSpawn();
      spawn.memorySet("key1", "value1");
      expect(spawn.memoryGet("key1")).toBe("value1");
    });

    it("should return undefined for non-existent key", () => {
      const spawn = createSpawn();
      expect(spawn.memoryGet("nonexistent")).toBeUndefined();
    });

    it("should overwrite existing value", () => {
      const spawn = createSpawn();
      spawn.memorySet("key1", "first");
      spawn.memorySet("key1", "second");
      expect(spawn.memoryGet("key1")).toBe("second");
    });

    it("should delete a key and return true", () => {
      const spawn = createSpawn();
      spawn.memorySet("key1", "value1");
      expect(spawn.memoryDelete("key1")).toBe(true);
      expect(spawn.memoryGet("key1")).toBeUndefined();
    });

    it("should return false when deleting non-existent key", () => {
      const spawn = createSpawn();
      expect(spawn.memoryDelete("missing")).toBe(false);
    });

    it("should clear all memory", () => {
      const spawn = createSpawn();
      spawn.memorySet("a", 1);
      spawn.memorySet("b", 2);
      spawn.memoryClear();
      expect(spawn.memoryGet("a")).toBeUndefined();
      expect(spawn.memoryGet("b")).toBeUndefined();
    });

    it("should support complex JSON values", () => {
      const spawn = createSpawn();
      const complex = { nested: { array: [1, 2, 3] }, flag: true };
      spawn.memorySet("complex", complex);
      expect(spawn.memoryGet("complex")).toEqual(complex);
    });
  });

  // ─── Memory Events ───────────────────────────────────────────────

  describe("memory events", () => {
    it("should fire onMemoryChange callback on set", () => {
      const spawn = createSpawn();
      const callback = vi.fn();
      spawn.onMemoryChange(callback);
      spawn.memorySet("k1", "v1");
      expect(callback).toHaveBeenCalledTimes(1);
      const payload = callback.mock.calls[0][0];
      expect(payload.type).toBe(MemoryEventType.SET);
      expect(payload.key).toBe("k1");
      expect(payload.value).toBe("v1");
    });

    it("should fire onMemoryChange callback on delete", () => {
      const spawn = createSpawn();
      spawn.memorySet("k1", "v1");
      const callback = vi.fn();
      spawn.onMemoryChange(callback);
      spawn.memoryDelete("k1");
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].type).toBe(MemoryEventType.DELETE);
    });

    it("should fire onMemoryChange callback on clear", () => {
      const spawn = createSpawn();
      spawn.memorySet("k1", "v1");
      const callback = vi.fn();
      spawn.onMemoryChange(callback);
      spawn.memoryClear();
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].type).toBe(MemoryEventType.CLEAR);
    });

    it("should fire onMemoryKeyChange for specific key", () => {
      const spawn = createSpawn();
      const callback = vi.fn();
      spawn.onMemoryKeyChange("target-key", callback);

      spawn.memorySet("other-key", "other");
      expect(callback).not.toHaveBeenCalled();

      spawn.memorySet("target-key", "hit");
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].key).toBe("target-key");
    });

    it("should return unsubscribe function from onMemoryChange", () => {
      const spawn = createSpawn();
      const callback = vi.fn();
      const unsubscribe = spawn.onMemoryChange(callback);
      unsubscribe();
      spawn.memorySet("k1", "v1");
      expect(callback).not.toHaveBeenCalled();
    });

    it("should return unsubscribe function from onMemoryKeyChange", () => {
      const spawn = createSpawn();
      const callback = vi.fn();
      const unsubscribe = spawn.onMemoryKeyChange("key", callback);
      unsubscribe();
      spawn.memorySet("key", "val");
      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ─── Serialize / Deserialize Memory ──────────────────────────────

  describe("serializeMemory / deserializeMemory", () => {
    it("should serialize and deserialize memory round-trip", () => {
      const spawn = createSpawn();
      spawn.memorySet("a", "val-a");
      spawn.memorySet("b", 42);

      const snapshot = spawn.serializeMemory();
      expect(snapshot.entries).toBeDefined();
      expect(Object.keys(snapshot.entries)).toHaveLength(2);

      // Clear and restore
      spawn.memoryClear();
      spawn.deserializeMemory(snapshot);

      expect(spawn.memoryGet("a")).toBe("val-a");
      expect(spawn.memoryGet("b")).toBe(42);
    });

    it("should overwrite existing memory on deserialize", () => {
      const spawn = createSpawn();
      spawn.memorySet("x", "old");
      const snapshot = spawn.serializeMemory();

      spawn.memorySet("x", "intermediate");
      spawn.deserializeMemory(snapshot);

      expect(spawn.memoryGet("x")).toBe("old");
    });
  });

  // ─── fork() ──────────────────────────────────────────────────────

  describe("fork()", () => {
    it("should fork and return a ForkAgent", () => {
      const spawn = createSpawn();
      const fork = spawn.fork({ taskDescription: "Fork task" });
      expect(fork.type).toBe(AgentType.FORK);
    });

    it("should fork from IDLE spawn", () => {
      const spawn = createSpawn();
      const fork = spawn.fork({ taskDescription: "Fork task" });
      expect(fork).toBeDefined();
      expect(fork.type).toBe(AgentType.FORK);
    });

    it("should fork from RUNNING spawn", async () => {
      const spawn = createSpawn();
      await spawn.init();
      const fork = spawn.fork({ taskDescription: "Fork task" });
      expect(fork.type).toBe(AgentType.FORK);
    });

    it("should throw when forking from PAUSED spawn", async () => {
      const spawn = createSpawn();
      await spawn.init();
      await spawn.pause();
      expect(() => spawn.fork({ taskDescription: "Fork task" })).toThrow(/state/);
    });

    it("should throw when forking from TERMINATED spawn", async () => {
      const spawn = createSpawn();
      await spawn.init();
      await spawn.terminate();
      expect(() => spawn.fork({ taskDescription: "Fork task" })).toThrow(/state/);
    });

    it("should emit fork:created event on spawn", () => {
      const spawn = createSpawn();
      const listener = vi.fn();
      spawn.events.on("fork:created", listener);

      const fork = spawn.fork({ taskDescription: "Fork task" });
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0]).toMatchObject({
        spawnId: spawn.id,
        forkId: fork.id,
      });
    });
  });

  // ─── Fork Management ─────────────────────────────────────────────

  describe("fork management", () => {
    it("should track fork via getFork", () => {
      const spawn = createSpawn();
      const fork = spawn.fork({ taskDescription: "F1" });
      expect(spawn.getFork(fork.id)).toBe(fork);
    });

    it("should return undefined for unknown fork id", () => {
      const spawn = createSpawn();
      expect(spawn.getFork("unknown")).toBeUndefined();
    });

    it("should list fork IDs", () => {
      const spawn = createSpawn();
      const f1 = spawn.fork({ taskDescription: "A" });
      const f2 = spawn.fork({ taskDescription: "B" });

      const ids = spawn.forkIds;
      expect(ids).toContain(f1.id);
      expect(ids).toContain(f2.id);
      expect(ids).toHaveLength(2);
    });

    it("should count forks correctly", () => {
      const spawn = createSpawn();
      expect(spawn.forkCount).toBe(0);
      spawn.fork({ taskDescription: "A" });
      expect(spawn.forkCount).toBe(1);
      spawn.fork({ taskDescription: "B" });
      expect(spawn.forkCount).toBe(2);
    });
  });

  // ─── terminateFork ───────────────────────────────────────────────

  describe("terminateFork()", () => {
    it("should terminate a specific fork", async () => {
      const spawn = createSpawn();
      const fork = spawn.fork({ taskDescription: "F1" });
      await fork.init();
      await spawn.terminateFork(fork.id);

      expect(fork.status).toBe(AgentStatus.TERMINATED);
      expect(spawn.forkCount).toBe(0);
    });

    it("should throw for unknown fork id", async () => {
      const spawn = createSpawn();
      await expect(spawn.terminateFork("unknown")).rejects.toThrow(/not found/);
    });
  });

  // ─── terminateAllForks ───────────────────────────────────────────

  describe("terminateAllForks()", () => {
    it("should terminate all forks", async () => {
      const spawn = createSpawn();
      const f1 = spawn.fork({ taskDescription: "A" });
      const f2 = spawn.fork({ taskDescription: "B" });
      const f3 = spawn.fork({ taskDescription: "C" });
      await Promise.all([f1.init(), f2.init(), f3.init()]);

      await spawn.terminateAllForks();

      expect(f1.status).toBe(AgentStatus.TERMINATED);
      expect(f2.status).toBe(AgentStatus.TERMINATED);
      expect(f3.status).toBe(AgentStatus.TERMINATED);
      expect(spawn.forkCount).toBe(0);
    });
  });

  // ─── Cascading terminate ─────────────────────────────────────────

  describe("cascading terminate", () => {
    it("Spawn.terminate() should also terminate all forks", async () => {
      const spawn = createSpawn();
      await spawn.init();
      const fork = spawn.fork({ taskDescription: "F1" });
      await fork.init();

      await spawn.terminate();

      expect(fork.status).toBe(AgentStatus.TERMINATED);
      expect(spawn.status).toBe(AgentStatus.TERMINATED);
    });

    it("should terminate spawn with no forks gracefully", async () => {
      const spawn = createSpawn();
      await spawn.init();
      await spawn.terminate();
      expect(spawn.status).toBe(AgentStatus.TERMINATED);
    });
  });

  // ─── Skills Access ───────────────────────────────────────────────

  describe("skills access", () => {
    it("has() should report registered skills", () => {
      mainAgent.registerSkill("tool-x", "Tool X");
      const spawn = createSpawn();
      expect(spawn.skills.has("tool-x")).toBe(true);
    });

    it("get() should return skill details", () => {
      mainAgent.registerSkill("tool-y", "Tool Y", "3.0.0");
      const spawn = createSpawn();
      const skill = spawn.skills.get("tool-y");
      expect(skill).toBeDefined();
      expect(skill?.name).toBe("tool-y");
      expect(skill?.version).toBe("3.0.0");
    });

    it("list() should return all skill names", () => {
      mainAgent.registerSkill("a", "A");
      mainAgent.registerSkill("b", "B");
      const spawn = createSpawn();
      expect(spawn.skills.list()).toEqual(["a", "b"]);
    });
  });

  // ─── Shared Memory with ForkAgent ────────────────────────────────

  describe("shared memory with ForkAgent", () => {
    it("ForkAgent writing to memory → Spawn can read it", () => {
      const spawn = createSpawn();
      const fork = spawn.fork({ taskDescription: "F1" });

      fork.memorySet("shared-data", { result: 42 });
      expect(spawn.memoryGet("shared-data")).toEqual({ result: 42 });
    });

    it("Spawn writing to memory → ForkAgent can read it", () => {
      const spawn = createSpawn();
      const fork = spawn.fork({ taskDescription: "F1" });

      spawn.memorySet("parent-data", "from spawn");
      expect(fork.memoryGet("parent-data")).toBe("from spawn");
    });

    it("ForkAgent delete is visible to Spawn", () => {
      const spawn = createSpawn();
      const fork = spawn.fork({ taskDescription: "F1" });

      spawn.memorySet("del-key", "value");
      fork.memoryDelete("del-key");
      expect(spawn.memoryGet("del-key")).toBeUndefined();
    });

    it("ForkAgent clear is visible to Spawn", () => {
      const spawn = createSpawn();
      const fork = spawn.fork({ taskDescription: "F1" });

      spawn.memorySet("k1", "v1");
      spawn.memorySet("k2", "v2");
      fork.memoryClear();

      expect(spawn.memoryGet("k1")).toBeUndefined();
      expect(spawn.memoryGet("k2")).toBeUndefined();
    });

    it("multiple forks share the same memory", () => {
      const spawn = createSpawn();
      const f1 = spawn.fork({ taskDescription: "F1" });
      const f2 = spawn.fork({ taskDescription: "F2" });

      f1.memorySet("key", "from f1");
      expect(f2.memoryGet("key")).toBe("from f1");
    });

    it("onMemoryChange from Spawn fires on ForkAgent writes", () => {
      const spawn = createSpawn();
      const fork = spawn.fork({ taskDescription: "F1" });
      const callback = vi.fn();
      spawn.onMemoryChange(callback);

      fork.memorySet("x", 1);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].agentId).toBe(fork.id);
    });
  });

  // ─── execute() ───────────────────────────────────────────────────

  describe("execute()", () => {
    it("should execute when RUNNING", async () => {
      const spawn = createSpawn();
      await spawn.init();
      await spawn.execute(); // should not throw
    });

    it("should throw when not RUNNING", async () => {
      const spawn = createSpawn();
      await expect(spawn.execute()).rejects.toThrow(/not RUNNING/);
    });
  });
});
