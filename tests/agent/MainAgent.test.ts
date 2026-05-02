import { describe, it, expect, beforeEach, vi } from "vitest";
import { MainAgent } from "../../src/agent/MainAgent";
import { AgentContext } from "../../src/core/AgentContext";
import { AgentStatus, AgentType } from "../../src/core/types";

describe("MainAgent", () => {
  let mainAgent: MainAgent;

  beforeEach(() => {
    mainAgent = new MainAgent(
      AgentContext.createRoot("test", ["constraint1"])
    );
  });

  // ─── Properties ──────────────────────────────────────────────────

  describe("properties", () => {
    it("should have type MAIN", () => {
      expect(mainAgent.type).toBe(AgentType.MAIN);
    });

    it("should start with IDLE status", () => {
      expect(mainAgent.status).toBe(AgentStatus.IDLE);
    });

    it("should have a valid id", () => {
      expect(mainAgent.id).toMatch(/^main-/);
    });

    it("should expose context from root", () => {
      expect(mainAgent.context.description).toBe("test");
      expect(mainAgent.context.constraints).toEqual(["constraint1"]);
      expect(mainAgent.context.agentType).toBe(AgentType.MAIN);
    });

    it("should initialize skill registry", () => {
      expect(mainAgent.skills).toBeDefined();
      expect(mainAgent.sharedSkills).toBeDefined();
      expect(mainAgent.skills.size).toBe(0);
    });

    it("should have events emitter", () => {
      expect(mainAgent.events).toBeDefined();
    });
  });

  // ─── Skill Management ───────────────────────────────────────────

  describe("skill management", () => {
    it("should register a skill", () => {
      mainAgent.registerSkill("code-search", "Search codebases", "2.0.0");
      expect(mainAgent.skills.has("code-search")).toBe(true);
    });

    it("should list registered skills", () => {
      mainAgent.registerSkill("s1", "First skill");
      mainAgent.registerSkill("s2", "Second skill");
      expect(mainAgent.skills.list()).toEqual(["s1", "s2"]);
    });

    it("should throw on duplicate skill registration", () => {
      mainAgent.registerSkill("dup", "Duplicate");
      expect(() => mainAgent.registerSkill("dup", "Again")).toThrow(/already registered/);
    });

    it("should expose skills via sharedSkills (read-only)", () => {
      mainAgent.registerSkill("shared-skill", "A shared skill");
      expect(mainAgent.sharedSkills.has("shared-skill")).toBe(true);
      expect(mainAgent.sharedSkills.list()).toEqual(["shared-skill"]);
      const skill = mainAgent.sharedSkills.get("shared-skill");
      expect(skill?.name).toBe("shared-skill");
    });
  });

  // ─── spawn() ─────────────────────────────────────────────────────

  describe("spawn()", () => {
    it("should return a SpawnAgent", async () => {
      await mainAgent.init();
      const spawn = mainAgent.spawn({
        taskDescription: "Sub task",
        constraints: ["c1"],
      });
      expect(spawn.type).toBe(AgentType.SPAWN);
      expect(spawn).toBeDefined();
    });

    it("should add spawn to children map", async () => {
      await mainAgent.init();
      const spawn = mainAgent.spawn({ taskDescription: "T1" });
      expect(mainAgent.getChild(spawn.id)).toBe(spawn);
      expect(mainAgent.childCount).toBe(1);
      expect(mainAgent.childIds).toContain(spawn.id);
    });

    it("should create child context with correct parentChain", async () => {
      await mainAgent.init();
      const spawn = mainAgent.spawn({ taskDescription: "T1" });
      const ctx = spawn.context;
      // parentChain should contain the main agent's ID
      expect(ctx.parentChain).toContain(mainAgent.id);
      expect(ctx.parentChain.length).toBe(1);
    });

    it("should propagate task context to child", async () => {
      await mainAgent.init();
      const spawn = mainAgent.spawn({
        taskDescription: "Sub task",
        constraints: ["sub-c1"],
        metadata: { priority: "high" },
      });
      expect(spawn.context.description).toBe("Sub task");
      expect(spawn.context.constraints).toContain("constraint1");
      expect(spawn.context.constraints).toContain("sub-c1");
      expect(spawn.context.metadata).toHaveProperty("priority", "high");
    });

    it("should give child read-only skills access", async () => {
      mainAgent.registerSkill("test-skill", "Testing");
      await mainAgent.init();
      const spawn = mainAgent.spawn({ taskDescription: "T1" });
      expect(spawn.skills.has("test-skill")).toBe(true);
    });

    it("should emit spawn:created event", async () => {
      const listener = vi.fn();
      mainAgent.events.on("spawn:created", listener);
      await mainAgent.init();
      const spawn = mainAgent.spawn({ taskDescription: "T1" });
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0]).toMatchObject({
        parentId: mainAgent.id,
        childId: spawn.id,
      });
    });

    it("should track multiple spawns", async () => {
      await mainAgent.init();
      const s1 = mainAgent.spawn({ taskDescription: "A" });
      const s2 = mainAgent.spawn({ taskDescription: "B" });
      const s3 = mainAgent.spawn({ taskDescription: "C" });
      expect(mainAgent.childCount).toBe(3);
      expect(mainAgent.childIds).toHaveLength(3);
    });
  });

  // ─── fork() ──────────────────────────────────────────────────────

  describe("fork()", () => {
    it("should fork from a spawn and return ForkAgent", async () => {
      await mainAgent.init();
      const spawn = mainAgent.spawn({ taskDescription: "T1" });
      await spawn.init();

      const fork = mainAgent.fork(spawn.id, { taskDescription: "F1" });
      expect(fork.type).toBe(AgentType.FORK);
    });

    it("should allow fork from IDLE spawn", async () => {
      await mainAgent.init();
      const spawn = mainAgent.spawn({ taskDescription: "T1" });
      // spawn is IDLE (not yet initialized)
      const fork = mainAgent.fork(spawn.id, { taskDescription: "F1" });
      expect(fork.type).toBe(AgentType.FORK);
    });

    it("should throw when forking from non-existent spawn", async () => {
      await mainAgent.init();
      expect(() =>
        mainAgent.fork("nonexistent-id", { taskDescription: "F1" })
      ).toThrow(/not found/);
    });

    it("should throw when forking from terminated spawn", async () => {
      await mainAgent.init();
      const spawn = mainAgent.spawn({ taskDescription: "T1" });
      await spawn.init();
      await spawn.terminate();

      expect(() =>
        mainAgent.fork(spawn.id, { taskDescription: "F1" })
      ).toThrow(/state/);
    });

    it("should throw when forking from paused spawn", async () => {
      await mainAgent.init();
      const spawn = mainAgent.spawn({ taskDescription: "T1" });
      await spawn.init();
      await spawn.pause();

      expect(() =>
        mainAgent.fork(spawn.id, { taskDescription: "F1" })
      ).toThrow(/state/);
    });

    it("should emit fork:created event", async () => {
      const listener = vi.fn();
      mainAgent.events.on("fork:created", listener);
      await mainAgent.init();
      const spawn = mainAgent.spawn({ taskDescription: "T1" });
      const fork = mainAgent.fork(spawn.id, { taskDescription: "F1" });

      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0]).toMatchObject({
        spawnId: spawn.id,
        forkId: fork.id,
      });
    });

    it("should create ForkAgent that shares Spawn's memory", async () => {
      await mainAgent.init();
      const spawn = mainAgent.spawn({ taskDescription: "T1" });
      const fork = mainAgent.fork(spawn.id, { taskDescription: "F1" });

      // Write via fork, read via spawn
      fork.memorySet("shared-key", "hello from fork");
      expect(spawn.memoryGet("shared-key")).toBe("hello from fork");
    });
  });

  // ─── Child Management ────────────────────────────────────────────

  describe("child management", () => {
    it("getChild should return undefined for unknown id", () => {
      expect(mainAgent.getChild("unknown")).toBeUndefined();
    });

    it("childIds should return empty array initially", () => {
      expect(mainAgent.childIds).toEqual([]);
    });

    it("childCount should be 0 initially", () => {
      expect(mainAgent.childCount).toBe(0);
    });

    it("should track children correctly after multiple spawns", async () => {
      await mainAgent.init();
      const s1 = mainAgent.spawn({ taskDescription: "A" });
      const s2 = mainAgent.spawn({ taskDescription: "B" });

      expect(mainAgent.childCount).toBe(2);
      expect(mainAgent.getChild(s1.id)).toBe(s1);
      expect(mainAgent.getChild(s2.id)).toBe(s2);
    });
  });

  // ─── getAllForkIds ───────────────────────────────────────────────

  describe("getAllForkIds()", () => {
    it("should return empty array when no forks exist", async () => {
      await mainAgent.init();
      mainAgent.spawn({ taskDescription: "S1" });
      expect(mainAgent.getAllForkIds()).toEqual([]);
    });

    it("should collect fork IDs across multiple spawns", async () => {
      await mainAgent.init();
      const s1 = mainAgent.spawn({ taskDescription: "A" });
      const s2 = mainAgent.spawn({ taskDescription: "B" });
      const f1 = mainAgent.fork(s1.id, { taskDescription: "F1" });
      const f2 = mainAgent.fork(s2.id, { taskDescription: "F2" });
      const f3 = mainAgent.fork(s1.id, { taskDescription: "F3" });

      const allForks = mainAgent.getAllForkIds();
      expect(allForks).toContain(f1.id);
      expect(allForks).toContain(f2.id);
      expect(allForks).toContain(f3.id);
      expect(allForks).toHaveLength(3);
    });
  });

  // ─── terminateChild ──────────────────────────────────────────────

  describe("terminateChild()", () => {
    it("should terminate a specific child spawn", async () => {
      await mainAgent.init();
      const spawn = mainAgent.spawn({ taskDescription: "T1" });
      await spawn.init(); // must be init'd for terminate to work
      await mainAgent.terminateChild(spawn.id);
      expect(spawn.status).toBe(AgentStatus.TERMINATED);
      expect(mainAgent.childCount).toBe(0);
    });

    it("should throw when terminating unknown child", async () => {
      await expect(mainAgent.terminateChild("unknown")).rejects.toThrow(/not found/);
    });

    it("should emit spawn:terminated event", async () => {
      const listener = vi.fn();
      mainAgent.events.on("spawn:terminated", listener);
      await mainAgent.init();
      const spawn = mainAgent.spawn({ taskDescription: "T1" });
      await spawn.init();
      await mainAgent.terminateChild(spawn.id);
      expect(listener).toHaveBeenCalledOnce();
    });
  });

  // ─── terminateAllChildren ────────────────────────────────────────

  describe("terminateAllChildren()", () => {
    it("should terminate all spawn children", async () => {
      await mainAgent.init();
      const s1 = mainAgent.spawn({ taskDescription: "A" });
      const s2 = mainAgent.spawn({ taskDescription: "B" });
      const s3 = mainAgent.spawn({ taskDescription: "C" });
      await s1.init();
      await s2.init();
      await s3.init();

      await mainAgent.terminateAllChildren();

      expect(s1.status).toBe(AgentStatus.TERMINATED);
      expect(s2.status).toBe(AgentStatus.TERMINATED);
      expect(s3.status).toBe(AgentStatus.TERMINATED);
      expect(mainAgent.childCount).toBe(0);
    });

    it("should cascade terminate to forks of spawn children", async () => {
      await mainAgent.init();
      const spawn = mainAgent.spawn({ taskDescription: "S1" });
      await spawn.init();
      const fork = mainAgent.fork(spawn.id, { taskDescription: "F1" });
      await fork.init();

      await mainAgent.terminateAllChildren();

      expect(spawn.status).toBe(AgentStatus.TERMINATED);
      expect(fork.status).toBe(AgentStatus.TERMINATED);
    });
  });

  // ─── terminate() (Main) ──────────────────────────────────────────

  describe("terminate() (Main cascade)", () => {
    it("should cascade: terminate all spawns → all forks → then Main", async () => {
      await mainAgent.init();
      const spawn = mainAgent.spawn({ taskDescription: "S1" });
      await spawn.init();
      const fork = mainAgent.fork(spawn.id, { taskDescription: "F1" });
      await fork.init();

      await mainAgent.terminate();

      expect(spawn.status).toBe(AgentStatus.TERMINATED);
      expect(fork.status).toBe(AgentStatus.TERMINATED);
      expect(mainAgent.status).toBe(AgentStatus.TERMINATED);
    });

    it("should terminate Main even with no children", async () => {
      await mainAgent.init();
      await mainAgent.terminate();
      expect(mainAgent.status).toBe(AgentStatus.TERMINATED);
    });
  });

  // ─── execute() ───────────────────────────────────────────────────

  describe("execute()", () => {
    it("should execute when RUNNING", async () => {
      await mainAgent.init();
      await mainAgent.execute(); // should not throw
    });

    it("should throw when not RUNNING", async () => {
      await expect(mainAgent.execute()).rejects.toThrow(/not RUNNING/);
    });
  });
});
