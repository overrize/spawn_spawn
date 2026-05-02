import { describe, it, expect, vi } from "vitest";
import { BaseAgent, AgentHooks } from "../../src/agent/BaseAgent";
import { AgentContext } from "../../src/core/AgentContext";
import { AgentStatus, AgentType } from "../../src/core/types";

/**
 * Concrete subclass of BaseAgent for testing.
 * Implements execute() with the standard RUNNING guard,
 * matching the pattern used by MainAgent/SpawnAgent/ForkAgent.
 * Allows injection of hooks for lifecycle testing.
 */
class TestAgent extends BaseAgent {
  executeCalls: number = 0;

  constructor(hooks?: AgentHooks) {
    const context = AgentContext.createRoot("test agent", undefined, { test: true });
    super(context, hooks);
  }

  override get type(): AgentType {
    return AgentType.MAIN;
  }

  async execute(): Promise<void> {
    if (this.status !== AgentStatus.RUNNING) {
      throw new Error(`TestAgent "${this.id}" is not RUNNING (current: ${this.status})`);
    }
    this.executeCalls++;
  }
}

/**
 * Helper: create a mock hook that returns a resolved promise.
 * Necessary because BaseAgent.handleError calls .catch() on onError's return value.
 */
function mockAsyncFn(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(undefined);
}

describe("BaseAgent (tested via TestAgent)", () => {
  // ─── Constructor & Properties ────────────────────────────────────

  describe("properties", () => {
    it("should have a valid id starting with main-", () => {
      const agent = new TestAgent();
      expect(agent.id).toMatch(/^main-/);
    });

    it("should have the correct type", () => {
      const agent = new TestAgent();
      expect(agent.type).toBe(AgentType.MAIN);
    });

    it("should start with IDLE status", () => {
      const agent = new TestAgent();
      expect(agent.status).toBe(AgentStatus.IDLE);
    });

    it("should have null error initially", () => {
      const agent = new TestAgent();
      expect(agent.error).toBeNull();
    });

    it("should format toString() correctly", () => {
      const agent = new TestAgent();
      expect(agent.toString()).toMatch(/^MAIN\[main-\w+\]\(IDLE\)$/);
    });

    it("toString() should reflect current status", async () => {
      const agent = new TestAgent();
      await agent.init();
      expect(agent.toString()).toContain("(RUNNING)");
    });
  });

  // ─── init() ──────────────────────────────────────────────────────

  describe("init()", () => {
    it("should transition IDLE → RUNNING on successful init", async () => {
      const agent = new TestAgent();
      expect(agent.status).toBe(AgentStatus.IDLE);

      await agent.init();

      expect(agent.status).toBe(AgentStatus.RUNNING);
    });

    it("should call onInit hook before RUNNING state", async () => {
      const onInit = mockAsyncFn();
      const onStart = mockAsyncFn();
      const agent = new TestAgent({ onInit, onStart });

      await agent.init();

      expect(onInit).toHaveBeenCalledOnce();
      expect(onStart).toHaveBeenCalledOnce();
      // onInit should have been called before onStart
      expect(onInit.mock.invocationCallOrder[0]).toBeLessThan(onStart.mock.invocationCallOrder[0]);
    });

    it("should call onStart hook after entering RUNNING", async () => {
      const onStart = mockAsyncFn();
      const agent = new TestAgent({ onStart });
      await agent.init();
      expect(onStart).toHaveBeenCalledOnce();
      expect(agent.status).toBe(AgentStatus.RUNNING);
    });

    it("should not call onStart if onInit throws", async () => {
      const onInit = vi.fn().mockRejectedValue(new Error("init failed"));
      const onStart = mockAsyncFn();
      const agent = new TestAgent({ onInit, onStart });

      await agent.init();

      expect(agent.status).toBe(AgentStatus.ERROR);
      expect(onStart).not.toHaveBeenCalled();
    });

    it("should handle hooks being undefined gracefully", async () => {
      const agent = new TestAgent(); // no hooks
      await agent.init();
      expect(agent.status).toBe(AgentStatus.RUNNING);
    });
  });

  // ─── pause() ─────────────────────────────────────────────────────

  describe("pause()", () => {
    it("should transition RUNNING → PAUSED", async () => {
      const agent = new TestAgent();
      await agent.init();
      expect(agent.status).toBe(AgentStatus.RUNNING);

      await agent.pause();

      expect(agent.status).toBe(AgentStatus.PAUSED);
    });

    it("should call onPause hook", async () => {
      const onPause = mockAsyncFn();
      const agent = new TestAgent({ onPause });
      await agent.init();
      await agent.pause();

      expect(onPause).toHaveBeenCalledOnce();
    });

    it("should set error when pausing from IDLE (invalid transition)", async () => {
      const agent = new TestAgent();
      // pause() catches the guard error internally, does not throw
      await agent.pause();
      // Error is caught by handleError — _error is set, but state stays IDLE
      expect(agent.error).toBeInstanceOf(Error);
      expect(agent.error?.message).toContain("PAUSED");
    });

    it("should handle onPause throwing and set _error", async () => {
      const onPause = vi.fn().mockRejectedValue(new Error("pause failed"));
      const agent = new TestAgent({ onPause });
      await agent.init();
      await agent.pause();

      // onPause throws AFTER state transitions to PAUSED.
      // handleError tries PAUSED→ERROR (invalid), so state stays PAUSED, but error is set.
      expect(agent.status).toBe(AgentStatus.PAUSED);
      expect(agent.error?.message).toBe("pause failed");
    });
  });

  // ─── resume() ────────────────────────────────────────────────────

  describe("resume()", () => {
    it("should transition PAUSED → RUNNING", async () => {
      const agent = new TestAgent();
      await agent.init();
      await agent.pause();
      expect(agent.status).toBe(AgentStatus.PAUSED);

      await agent.resume();

      expect(agent.status).toBe(AgentStatus.RUNNING);
    });

    it("should call onResume hook", async () => {
      const onResume = mockAsyncFn();
      const agent = new TestAgent({ onResume });
      await agent.init();
      await agent.pause();
      await agent.resume();

      expect(onResume).toHaveBeenCalledOnce();
    });

    it("should set error when resuming from RUNNING (invalid transition)", async () => {
      const agent = new TestAgent();
      await agent.init();
      // resume() catches guard error internally, does not throw
      await agent.resume();
      expect(agent.error).toBeInstanceOf(Error);
      expect(agent.error?.message).toContain("RESUMING");
    });

    it("should handle onResume throwing and set _error", async () => {
      const onResume = vi.fn().mockRejectedValue(new Error("resume failed"));
      const agent = new TestAgent({ onResume });
      await agent.init();
      await agent.pause();
      await agent.resume();

      // onResume throws AFTER RESUMING transition.
      // RESUMING→ERROR is valid, so state transitions to ERROR.
      expect(agent.status).toBe(AgentStatus.ERROR);
      expect(agent.error?.message).toBe("resume failed");
    });
  });

  // ─── terminate() ─────────────────────────────────────────────────

  describe("terminate()", () => {
    it("should transition RUNNING → TERMINATED", async () => {
      const agent = new TestAgent();
      await agent.init();

      await agent.terminate();

      expect(agent.status).toBe(AgentStatus.TERMINATED);
    });

    it("should call onTerminate hook", async () => {
      const onTerminate = mockAsyncFn();
      const agent = new TestAgent({ onTerminate });
      await agent.init();
      await agent.terminate();

      expect(onTerminate).toHaveBeenCalledOnce();
    });

    it("should handle onTerminate throwing and go to ERROR", async () => {
      const onTerminate = vi.fn().mockRejectedValue(new Error("terminate failed"));
      const agent = new TestAgent({ onTerminate });
      await agent.init();
      await agent.terminate();

      // Error is caught; TERMINATING→ERROR is valid, so goes to ERROR
      expect(agent.error?.message).toBe("terminate failed");
      expect(agent.status).toBe(AgentStatus.ERROR);
    });

    it("should transition from PAUSED to TERMINATED", async () => {
      const agent = new TestAgent();
      await agent.init();
      await agent.pause();
      expect(agent.status).toBe(AgentStatus.PAUSED);

      await agent.terminate();

      expect(agent.status).toBe(AgentStatus.TERMINATED);
    });

    it("should transition from ERROR to TERMINATED", async () => {
      const onInit = vi.fn().mockRejectedValue(new Error("crash"));
      const onTerminate = mockAsyncFn();
      const agent = new TestAgent({ onInit, onTerminate });
      await agent.init();
      expect(agent.status).toBe(AgentStatus.ERROR);

      await agent.terminate();

      expect(agent.status).toBe(AgentStatus.TERMINATED);
      expect(onTerminate).toHaveBeenCalledOnce();
    });

    it("should NOT throw on double terminate (idempotent safety)", async () => {
      const onTerminate = mockAsyncFn();
      const onError = mockAsyncFn();
      const agent = new TestAgent({ onTerminate, onError });
      await agent.init();
      await agent.terminate();
      expect(agent.status).toBe(AgentStatus.TERMINATED);

      // Second terminate: TERMINATED→TERMINATING is invalid, caught by try-catch
      await agent.terminate();
      expect(agent.error).not.toBeNull();
      expect(onTerminate).toHaveBeenCalledTimes(1); // NOT re-executed
    });

    it("should not call onTerminate again on second terminate", async () => {
      const onTerminate = mockAsyncFn();
      const agent = new TestAgent({ onTerminate });
      await agent.init();
      await agent.terminate();
      expect(onTerminate).toHaveBeenCalledTimes(1);

      await agent.terminate();
      expect(onTerminate).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Error handling ──────────────────────────────────────────────

  describe("error handling", () => {
    it("should set _error when transition hook throws", async () => {
      const onInit = vi.fn().mockRejectedValue(new Error("boom"));
      const agent = new TestAgent({ onInit });

      await agent.init();

      expect(agent.error).toBeInstanceOf(Error);
      expect(agent.error?.message).toBe("boom");
      expect(agent.status).toBe(AgentStatus.ERROR);
    });

    it("should call onError hook when transitioning to ERROR", async () => {
      const onInit = vi.fn().mockRejectedValue(new Error("init error"));
      const onError = mockAsyncFn();
      const agent = new TestAgent({ onInit, onError });

      await agent.init();

      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(onError.mock.calls[0][0].message).toBe("init error");
    });

    it("should swallow errors from onError hook itself", async () => {
      const onInit = vi.fn().mockRejectedValue(new Error("init error"));
      const onError = vi.fn().mockRejectedValue(new Error("error handler failed"));
      const agent = new TestAgent({ onInit, onError });

      // Should not throw — onError's .catch swallows the rejection
      await expect(agent.init()).resolves.toBeUndefined();
      expect(agent.status).toBe(AgentStatus.ERROR);
    });

    it("should not transition to ERROR from TERMINATED (swallowed)", async () => {
      const agent = new TestAgent();
      await agent.init();
      await agent.terminate();
      expect(agent.status).toBe(AgentStatus.TERMINATED);

      // Force second terminate — error is caught, can't go to ERROR from TERMINATED
      await agent.terminate();
      expect(agent.status).toBe(AgentStatus.TERMINATED);
    });
  });

  // ─── execute() guard ─────────────────────────────────────────────

  describe("execute() guard", () => {
    it("should allow execute when RUNNING", async () => {
      const agent = new TestAgent();
      await agent.init();
      await agent.execute();
      expect(agent.executeCalls).toBe(1);
    });

    it("should throw when execute() called from IDLE", async () => {
      const agent = new TestAgent();
      await expect(agent.execute()).rejects.toThrow(/not RUNNING/i);
    });

    it("should throw when execute() called from PAUSED", async () => {
      const agent = new TestAgent();
      await agent.init();
      await agent.pause();
      await expect(agent.execute()).rejects.toThrow(/not RUNNING/i);
    });

    it("should throw when execute() called from TERMINATED", async () => {
      const agent = new TestAgent();
      await agent.init();
      await agent.terminate();
      await expect(agent.execute()).rejects.toThrow(/not RUNNING/i);
    });
  });

  // ─── Full lifecycle sequence ─────────────────────────────────────

  describe("full lifecycle", () => {
    it("should support init → pause → resume → terminate", async () => {
      const agent = new TestAgent();
      expect(agent.status).toBe(AgentStatus.IDLE);

      await agent.init();
      expect(agent.status).toBe(AgentStatus.RUNNING);

      await agent.pause();
      expect(agent.status).toBe(AgentStatus.PAUSED);

      await agent.resume();
      expect(agent.status).toBe(AgentStatus.RUNNING);

      await agent.terminate();
      expect(agent.status).toBe(AgentStatus.TERMINATED);
    });

    it("should call all hooks in correct order during full lifecycle", async () => {
      const calls: string[] = [];
      const hooks: AgentHooks = {
        onInit: vi.fn().mockImplementation(async () => { calls.push("init"); }),
        onStart: vi.fn().mockImplementation(async () => { calls.push("start"); }),
        onPause: vi.fn().mockImplementation(async () => { calls.push("pause"); }),
        onResume: vi.fn().mockImplementation(async () => { calls.push("resume"); }),
        onTerminate: vi.fn().mockImplementation(async () => { calls.push("terminate"); }),
      };
      const agent = new TestAgent(hooks);

      await agent.init();
      await agent.pause();
      await agent.resume();
      await agent.terminate();

      expect(calls).toEqual(["init", "start", "pause", "resume", "terminate"]);
    });
  });

  // ─── context access ──────────────────────────────────────────────

  describe("context", () => {
    it("should expose context property", () => {
      const agent = new TestAgent();
      expect(agent.context).toBeInstanceOf(AgentContext);
    });

    it("should have context with agentType MAIN", () => {
      const agent = new TestAgent();
      expect(agent.context.agentType).toBe(AgentType.MAIN);
    });
  });
});
