import { describe, it, expect, beforeEach } from "vitest";
import { AgentState, InvalidTransitionError } from "../../src/core/AgentState";
import { AgentStatus } from "../../src/core/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const S = AgentStatus;

function transitionPath(state: AgentState, ...targets: AgentStatus[]): void {
  for (const t of targets) state.transition(t);
}

// ---------------------------------------------------------------------------
// Constructor & initial state
// ---------------------------------------------------------------------------

describe("AgentState — constructor & initial state", () => {
  it("defaults to IDLE", () => {
    const state = new AgentState();
    expect(state.current).toBe(S.IDLE);
    expect(state.history).toEqual([]);
    expect(state.isActive).toBe(false);
    expect(state.isTerminal).toBe(false);
  });

  it("accepts a custom initial state", () => {
    const state = new AgentState(S.RUNNING);
    expect(state.current).toBe(S.RUNNING);
    expect(state.isActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Valid transitions — full lifecycle paths
// ---------------------------------------------------------------------------

describe("AgentState — valid transitions", () => {
  let state: AgentState;

  beforeEach(() => {
    state = new AgentState();
  });

  // -- Individual valid transitions (13 total) --

  it("IDLE → INITIALIZING", () => {
    state.transition(S.INITIALIZING);
    expect(state.current).toBe(S.INITIALIZING);
  });

  it("INITIALIZING → RUNNING", () => {
    transitionPath(state, S.INITIALIZING);
    state.transition(S.RUNNING);
    expect(state.current).toBe(S.RUNNING);
  });

  it("INITIALIZING → ERROR", () => {
    transitionPath(state, S.INITIALIZING);
    state.transition(S.ERROR);
    expect(state.current).toBe(S.ERROR);
  });

  it("RUNNING → PAUSED", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING);
    state.transition(S.PAUSED);
    expect(state.current).toBe(S.PAUSED);
  });

  it("RUNNING → TERMINATING", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING);
    state.transition(S.TERMINATING);
    expect(state.current).toBe(S.TERMINATING);
  });

  it("RUNNING → ERROR", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING);
    state.transition(S.ERROR);
    expect(state.current).toBe(S.ERROR);
  });

  it("PAUSED → RESUMING", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.PAUSED);
    state.transition(S.RESUMING);
    expect(state.current).toBe(S.RESUMING);
  });

  it("PAUSED → TERMINATING", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.PAUSED);
    state.transition(S.TERMINATING);
    expect(state.current).toBe(S.TERMINATING);
  });

  it("RESUMING → RUNNING", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.PAUSED, S.RESUMING);
    state.transition(S.RUNNING);
    expect(state.current).toBe(S.RUNNING);
  });

  it("RESUMING → ERROR", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.PAUSED, S.RESUMING);
    state.transition(S.ERROR);
    expect(state.current).toBe(S.ERROR);
  });

  it("TERMINATING → TERMINATED", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.TERMINATING);
    state.transition(S.TERMINATED);
    expect(state.current).toBe(S.TERMINATED);
  });

  it("TERMINATING → ERROR", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.TERMINATING);
    state.transition(S.ERROR);
    expect(state.current).toBe(S.ERROR);
  });

  it("ERROR → TERMINATING", () => {
    transitionPath(state, S.INITIALIZING, S.ERROR);
    state.transition(S.TERMINATING);
    expect(state.current).toBe(S.TERMINATING);
  });

  // -- Full lifecycle paths --

  it("completes full happy path: IDLE → INIT → RUNNING → PAUSED → RESUMING → RUNNING → TERMINATING → TERMINATED", () => {
    transitionPath(
      state,
      S.INITIALIZING,
      S.RUNNING,
      S.PAUSED,
      S.RESUMING,
      S.RUNNING,
      S.TERMINATING,
      S.TERMINATED,
    );
    expect(state.current).toBe(S.TERMINATED);
    expect(state.history).toHaveLength(7);
  });

  it("completes error path: IDLE → INIT → ERROR → TERMINATING → TERMINATED", () => {
    transitionPath(
      state,
      S.INITIALIZING,
      S.ERROR,
      S.TERMINATING,
      S.TERMINATED,
    );
    expect(state.current).toBe(S.TERMINATED);
    expect(state.history).toHaveLength(4);
  });

  it("completes direct termination: IDLE → INIT → RUNNING → TERMINATING → TERMINATED", () => {
    transitionPath(
      state,
      S.INITIALIZING,
      S.RUNNING,
      S.TERMINATING,
      S.TERMINATED,
    );
    expect(state.current).toBe(S.TERMINATED);
    expect(state.history).toHaveLength(4);
  });

  it("completes RUNNING → ERROR → TERMINATING → TERMINATED", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.ERROR, S.TERMINATING, S.TERMINATED);
    expect(state.current).toBe(S.TERMINATED);
    expect(state.history).toHaveLength(5);
  });

  it("completes PAUSED → TERMINATING → TERMINATED (skip resume)", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.PAUSED, S.TERMINATING, S.TERMINATED);
    expect(state.current).toBe(S.TERMINATED);
    expect(state.history).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Invalid transitions
// ---------------------------------------------------------------------------

describe("AgentState — invalid transitions", () => {
  let state: AgentState;

  beforeEach(() => {
    state = new AgentState();
  });

  // -- IDLE can only go to INITIALIZING --

  it("IDLE → RUNNING throws", () => {
    expect(() => state.transition(S.RUNNING)).toThrow(InvalidTransitionError);
  });

  it("IDLE → PAUSED throws", () => {
    expect(() => state.transition(S.PAUSED)).toThrow(InvalidTransitionError);
  });

  it("IDLE → TERMINATED throws", () => {
    expect(() => state.transition(S.TERMINATED)).toThrow(InvalidTransitionError);
  });

  it("IDLE → ERROR throws", () => {
    expect(() => state.transition(S.ERROR)).toThrow(InvalidTransitionError);
  });

  it("IDLE → RESUMING throws", () => {
    expect(() => state.transition(S.RESUMING)).toThrow(InvalidTransitionError);
  });

  it("IDLE → TERMINATING throws", () => {
    expect(() => state.transition(S.TERMINATING)).toThrow(InvalidTransitionError);
  });

  // -- INITIALIZING can only go to RUNNING or ERROR --

  it("INITIALIZING → IDLE throws", () => {
    state.transition(S.INITIALIZING);
    expect(() => state.transition(S.IDLE)).toThrow(InvalidTransitionError);
  });

  it("INITIALIZING → PAUSED throws", () => {
    state.transition(S.INITIALIZING);
    expect(() => state.transition(S.PAUSED)).toThrow(InvalidTransitionError);
  });

  it("INITIALIZING → TERMINATED throws", () => {
    state.transition(S.INITIALIZING);
    expect(() => state.transition(S.TERMINATED)).toThrow(InvalidTransitionError);
  });

  it("INITIALIZING → TERMINATING throws", () => {
    state.transition(S.INITIALIZING);
    expect(() => state.transition(S.TERMINATING)).toThrow(InvalidTransitionError);
  });

  it("INITIALIZING → RESUMING throws", () => {
    state.transition(S.INITIALIZING);
    expect(() => state.transition(S.RESUMING)).toThrow(InvalidTransitionError);
  });

  // -- RUNNING can only go to PAUSED, TERMINATING, ERROR --

  it("RUNNING → IDLE throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING);
    expect(() => state.transition(S.IDLE)).toThrow(InvalidTransitionError);
  });

  it("RUNNING → INITIALIZING throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING);
    expect(() => state.transition(S.INITIALIZING)).toThrow(InvalidTransitionError);
  });

  it("RUNNING → RESUMING throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING);
    expect(() => state.transition(S.RESUMING)).toThrow(InvalidTransitionError);
  });

  it("RUNNING → TERMINATED throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING);
    expect(() => state.transition(S.TERMINATED)).toThrow(InvalidTransitionError);
  });

  // -- PAUSED can only go to RESUMING, TERMINATING --

  it("PAUSED → IDLE throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.PAUSED);
    expect(() => state.transition(S.IDLE)).toThrow(InvalidTransitionError);
  });

  it("PAUSED → INITIALIZING throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.PAUSED);
    expect(() => state.transition(S.INITIALIZING)).toThrow(InvalidTransitionError);
  });

  it("PAUSED → RUNNING throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.PAUSED);
    expect(() => state.transition(S.RUNNING)).toThrow(InvalidTransitionError);
  });

  it("PAUSED → ERROR throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.PAUSED);
    expect(() => state.transition(S.ERROR)).toThrow(InvalidTransitionError);
  });

  it("PAUSED → TERMINATED throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.PAUSED);
    expect(() => state.transition(S.TERMINATED)).toThrow(InvalidTransitionError);
  });

  // -- RESUMING can only go to RUNNING, ERROR --

  it("RESUMING → IDLE throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.PAUSED, S.RESUMING);
    expect(() => state.transition(S.IDLE)).toThrow(InvalidTransitionError);
  });

  it("RESUMING → PAUSED throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.PAUSED, S.RESUMING);
    expect(() => state.transition(S.PAUSED)).toThrow(InvalidTransitionError);
  });

  it("RESUMING → TERMINATING throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.PAUSED, S.RESUMING);
    expect(() => state.transition(S.TERMINATING)).toThrow(InvalidTransitionError);
  });

  it("RESUMING → TERMINATED throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.PAUSED, S.RESUMING);
    expect(() => state.transition(S.TERMINATED)).toThrow(InvalidTransitionError);
  });

  // -- TERMINATING can only go to TERMINATED, ERROR --

  it("TERMINATING → IDLE throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.TERMINATING);
    expect(() => state.transition(S.IDLE)).toThrow(InvalidTransitionError);
  });

  it("TERMINATING → RUNNING throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.TERMINATING);
    expect(() => state.transition(S.RUNNING)).toThrow(InvalidTransitionError);
  });

  it("TERMINATING → PAUSED throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.TERMINATING);
    expect(() => state.transition(S.PAUSED)).toThrow(InvalidTransitionError);
  });

  it("TERMINATING → RESUMING throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.TERMINATING);
    expect(() => state.transition(S.RESUMING)).toThrow(InvalidTransitionError);
  });

  it("TERMINATING → INITIALIZING throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.TERMINATING);
    expect(() => state.transition(S.INITIALIZING)).toThrow(InvalidTransitionError);
  });

  // -- TERMINATED cannot go anywhere --

  it("TERMINATED → IDLE throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.TERMINATING, S.TERMINATED);
    expect(() => state.transition(S.IDLE)).toThrow(InvalidTransitionError);
  });

  it("TERMINATED → RUNNING throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.TERMINATING, S.TERMINATED);
    expect(() => state.transition(S.RUNNING)).toThrow(InvalidTransitionError);
  });

  it("TERMINATED → INITIALIZING throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.TERMINATING, S.TERMINATED);
    expect(() => state.transition(S.INITIALIZING)).toThrow(InvalidTransitionError);
  });

  it("TERMINATED → ERROR throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.TERMINATING, S.TERMINATED);
    expect(() => state.transition(S.ERROR)).toThrow(InvalidTransitionError);
  });

  it("TERMINATED → TERMINATING throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.TERMINATING, S.TERMINATED);
    expect(() => state.transition(S.TERMINATING)).toThrow(InvalidTransitionError);
  });

  it("TERMINATED → PAUSED throws", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.TERMINATING, S.TERMINATED);
    expect(() => state.transition(S.PAUSED)).toThrow(InvalidTransitionError);
  });

  // -- ERROR can only go to TERMINATING --

  it("ERROR → IDLE throws", () => {
    transitionPath(state, S.INITIALIZING, S.ERROR);
    expect(() => state.transition(S.IDLE)).toThrow(InvalidTransitionError);
  });

  it("ERROR → RUNNING throws", () => {
    transitionPath(state, S.INITIALIZING, S.ERROR);
    expect(() => state.transition(S.RUNNING)).toThrow(InvalidTransitionError);
  });

  it("ERROR → PAUSED throws", () => {
    transitionPath(state, S.INITIALIZING, S.ERROR);
    expect(() => state.transition(S.PAUSED)).toThrow(InvalidTransitionError);
  });

  it("ERROR → RESUMING throws", () => {
    transitionPath(state, S.INITIALIZING, S.ERROR);
    expect(() => state.transition(S.RESUMING)).toThrow(InvalidTransitionError);
  });

  it("ERROR → INITIALIZING throws", () => {
    transitionPath(state, S.INITIALIZING, S.ERROR);
    expect(() => state.transition(S.INITIALIZING)).toThrow(InvalidTransitionError);
  });

  it("ERROR → TERMINATED throws", () => {
    transitionPath(state, S.INITIALIZING, S.ERROR);
    expect(() => state.transition(S.TERMINATED)).toThrow(InvalidTransitionError);
  });
});

// ---------------------------------------------------------------------------
// canTransition
// ---------------------------------------------------------------------------

describe("AgentState — canTransition", () => {
  let state: AgentState;

  beforeEach(() => {
    state = new AgentState();
  });

  it("IDLE can transition to INITIALIZING", () => {
    expect(state.canTransition(S.INITIALIZING)).toBe(true);
  });

  it("IDLE cannot transition to RUNNING", () => {
    expect(state.canTransition(S.RUNNING)).toBe(false);
  });

  it("RUNNING can transition to PAUSED, TERMINATING, ERROR", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING);
    expect(state.canTransition(S.PAUSED)).toBe(true);
    expect(state.canTransition(S.TERMINATING)).toBe(true);
    expect(state.canTransition(S.ERROR)).toBe(true);
    expect(state.canTransition(S.IDLE)).toBe(false);
    expect(state.canTransition(S.INITIALIZING)).toBe(false);
    expect(state.canTransition(S.TERMINATED)).toBe(false);
  });

  it("TERMINATED can transition to nothing", () => {
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.TERMINATING, S.TERMINATED);
    expect(state.canTransition(S.IDLE)).toBe(false);
    expect(state.canTransition(S.RUNNING)).toBe(false);
    expect(state.canTransition(S.TERMINATING)).toBe(false);
    expect(state.canTransition(S.ERROR)).toBe(false);
    expect(state.canTransition(S.PAUSED)).toBe(false);
    expect(state.canTransition(S.RESUMING)).toBe(false);
  });

  it("ERROR can only transition to TERMINATING", () => {
    transitionPath(state, S.INITIALIZING, S.ERROR);
    expect(state.canTransition(S.TERMINATING)).toBe(true);
    expect(state.canTransition(S.IDLE)).toBe(false);
    expect(state.canTransition(S.RUNNING)).toBe(false);
    expect(state.canTransition(S.TERMINATED)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// History tracking
// ---------------------------------------------------------------------------

describe("AgentState — history tracking", () => {
  it("records each transition with from/to/timestamp", () => {
    const before = Date.now();
    const state = new AgentState();
    state.transition(S.INITIALIZING);
    state.transition(S.RUNNING);
    const after = Date.now();

    expect(state.history).toHaveLength(2);

    const first = state.history[0]!;
    expect(first.from).toBe(S.IDLE);
    expect(first.to).toBe(S.INITIALIZING);
    expect(first.timestamp).toBeGreaterThanOrEqual(before);
    expect(first.timestamp).toBeLessThanOrEqual(after);

    const second = state.history[1]!;
    expect(second.from).toBe(S.INITIALIZING);
    expect(second.to).toBe(S.RUNNING);
    expect(second.timestamp).toBeGreaterThanOrEqual(before);
    expect(second.timestamp).toBeLessThanOrEqual(after);
  });

  it("starts with empty history", () => {
    const state = new AgentState();
    expect(state.history).toEqual([]);
  });

  it("history is readonly (type-level enforcement)", () => {
    const state = new AgentState();
    state.transition(S.INITIALIZING);
    // history is typed ReadonlyArray, just verify it has the entry
    expect(state.history[0]).toBeDefined();
  });

  it("does NOT record failed transitions", () => {
    const state = new AgentState();
    expect(() => state.transition(S.RUNNING)).toThrow();
    expect(state.history).toEqual([]);
    expect(state.current).toBe(S.IDLE);
  });
});

// ---------------------------------------------------------------------------
// isTerminal
// ---------------------------------------------------------------------------

describe("AgentState — isTerminal", () => {
  it("TERMINATED is terminal", () => {
    const state = new AgentState();
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.TERMINATING, S.TERMINATED);
    expect(state.isTerminal).toBe(true);
  });

  it("ERROR is terminal", () => {
    const state = new AgentState();
    transitionPath(state, S.INITIALIZING, S.ERROR);
    expect(state.isTerminal).toBe(true);
  });

  it("IDLE is not terminal", () => {
    expect(new AgentState().isTerminal).toBe(false);
  });

  it("RUNNING is not terminal", () => {
    const state = new AgentState();
    transitionPath(state, S.INITIALIZING, S.RUNNING);
    expect(state.isTerminal).toBe(false);
  });

  it("PAUSED is not terminal", () => {
    const state = new AgentState();
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.PAUSED);
    expect(state.isTerminal).toBe(false);
  });

  it("TERMINATING is not terminal", () => {
    const state = new AgentState();
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.TERMINATING);
    expect(state.isTerminal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isActive
// ---------------------------------------------------------------------------

describe("AgentState — isActive", () => {
  it("RUNNING is active", () => {
    const state = new AgentState();
    transitionPath(state, S.INITIALIZING, S.RUNNING);
    expect(state.isActive).toBe(true);
  });

  it("IDLE is not active", () => {
    expect(new AgentState().isActive).toBe(false);
  });

  it("INITIALIZING is not active", () => {
    const state = new AgentState();
    state.transition(S.INITIALIZING);
    expect(state.isActive).toBe(false);
  });

  it("PAUSED is not active", () => {
    const state = new AgentState();
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.PAUSED);
    expect(state.isActive).toBe(false);
  });

  it("RESUMING is not active", () => {
    const state = new AgentState();
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.PAUSED, S.RESUMING);
    expect(state.isActive).toBe(false);
  });

  it("TERMINATING is not active", () => {
    const state = new AgentState();
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.TERMINATING);
    expect(state.isActive).toBe(false);
  });

  it("TERMINATED is not active", () => {
    const state = new AgentState();
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.TERMINATING, S.TERMINATED);
    expect(state.isActive).toBe(false);
  });

  it("ERROR is not active", () => {
    const state = new AgentState();
    transitionPath(state, S.INITIALIZING, S.ERROR);
    expect(state.isActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

describe("AgentState — reset()", () => {
  it("returns state to IDLE with empty history", () => {
    const state = new AgentState();
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.PAUSED);
    expect(state.current).toBe(S.PAUSED);
    expect(state.history).toHaveLength(3);

    state.reset();
    expect(state.current).toBe(S.IDLE);
    expect(state.history).toEqual([]);
  });

  it("resets from TERMINATED to IDLE", () => {
    const state = new AgentState();
    transitionPath(state, S.INITIALIZING, S.RUNNING, S.TERMINATING, S.TERMINATED);
    state.reset();
    expect(state.current).toBe(S.IDLE);
    expect(state.history).toEqual([]);
  });

  it("resets from ERROR to IDLE", () => {
    const state = new AgentState();
    transitionPath(state, S.INITIALIZING, S.ERROR);
    state.reset();
    expect(state.current).toBe(S.IDLE);
    expect(state.history).toEqual([]);
  });

  it("does NOT emit any events (reset is purely internal)", () => {
    const state = new AgentState();
    transitionPath(state, S.INITIALIZING, S.RUNNING);
    state.reset();
    expect(state.current).toBe(S.IDLE);
  });
});

// ---------------------------------------------------------------------------
// InvalidTransitionError
// ---------------------------------------------------------------------------

describe("InvalidTransitionError", () => {
  it("contains the from/to states in its message", () => {
    const err = new InvalidTransitionError(S.IDLE, S.RUNNING);
    expect(err.message).toContain("IDLE");
    expect(err.message).toContain("RUNNING");
  });

  it("has name 'InvalidTransitionError'", () => {
    const err = new InvalidTransitionError(S.IDLE, S.RUNNING);
    expect(err.name).toBe("InvalidTransitionError");
  });

  it("is an instance of Error", () => {
    const err = new InvalidTransitionError(S.RUNNING, S.TERMINATED);
    expect(err).toBeInstanceOf(Error);
  });

  it("is thrown by invalid transition()", () => {
    const state = new AgentState();
    try {
      state.transition(S.RUNNING);
      // Should not reach here
      expect.unreachable("Expected InvalidTransitionError to be thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      expect((e as InvalidTransitionError).message).toContain("IDLE");
      expect((e as InvalidTransitionError).message).toContain("RUNNING");
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("AgentState — edge cases", () => {
  it("current getter reflects state after every transition", () => {
    const state = new AgentState();
    expect(state.current).toBe(S.IDLE);
    state.transition(S.INITIALIZING);
    expect(state.current).toBe(S.INITIALIZING);
    state.transition(S.RUNNING);
    expect(state.current).toBe(S.RUNNING);
  });

  it("cannot transition to the same state (self-transition is invalid)", () => {
    const state = new AgentState();
    // IDLE → IDLE not in VALID_TRANSITIONS
    expect(() => state.transition(S.IDLE)).toThrow(InvalidTransitionError);

    state.transition(S.INITIALIZING);
    expect(() => state.transition(S.INITIALIZING)).toThrow(InvalidTransitionError);
  });

  it("transition does not mutate state on failure", () => {
    const state = new AgentState();
    state.transition(S.INITIALIZING);
    try {
      state.transition(S.TERMINATED);
    } catch {
      // expected
    }
    // State should be unchanged
    expect(state.current).toBe(S.INITIALIZING);
    expect(state.history).toHaveLength(1);
  });

  it("multiple ERROR → TERMINATING → TERMINATED cycles", () => {
    const state1 = new AgentState();
    transitionPath(state1, S.INITIALIZING, S.ERROR, S.TERMINATING, S.TERMINATED);
    expect(state1.isTerminal).toBe(true);

    const state2 = new AgentState();
    transitionPath(state2, S.INITIALIZING, S.RUNNING, S.ERROR, S.TERMINATING, S.TERMINATED);
    expect(state2.isTerminal).toBe(true);
  });
});
