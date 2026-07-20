import { describe, it } from "node:test";
import assert from "node:assert/strict";

type WorkerIdleAction =
  | "nudge"
  | "hard-circuit"
  | "silent-nudge"
  | "silent-hard-circuit"
  | "noop";

interface WorkerIdleState {
  acted: boolean;
  hasPendingTodos: boolean;
  continuations: number;
  gaveUp: boolean;
}

function decideWorkerIdleAfterNoTools(s: WorkerIdleState): WorkerIdleAction {
  if (!s.acted && !s.gaveUp) {
    if (s.hasPendingTodos && s.continuations < 3) return "nudge";
    if (s.hasPendingTodos) return "hard-circuit";
    if (s.continuations < 2) return "silent-nudge";
    return "silent-hard-circuit";
  }
  return "noop";
}

describe("worker idle circuit decision", () => {
  it("nudges pending workers before the hard circuit threshold", () => {
    assert.equal(decideWorkerIdleAfterNoTools({
      acted: false,
      hasPendingTodos: true,
      continuations: 0,
      gaveUp: false,
    }), "nudge");
  });

  it("hard-circuits pending workers after nudges are exhausted", () => {
    assert.equal(decideWorkerIdleAfterNoTools({
      acted: false,
      hasPendingTodos: true,
      continuations: 3,
      gaveUp: false,
    }), "hard-circuit");
  });

  it("hard-circuits silent workers without pending todos instead of resetting forever", () => {
    assert.equal(decideWorkerIdleAfterNoTools({
      acted: false,
      hasPendingTodos: false,
      continuations: 2,
      gaveUp: false,
    }), "silent-hard-circuit");
  });
});
