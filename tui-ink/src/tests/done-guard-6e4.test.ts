/**
 * M1-6e-4 · coding-completion done-guard decision (M0 deferred assertion).
 * `decideDoneGuard` is now WIRED into WorkerHandler (the two agent.done blocks route
 * through it — golden 25 confirms equivalence), so this is a real test of live behavior,
 * not parallel dead code. Covers the emit conditions for `test_failed_but_claimed_done`
 * and `agent_done_blocked_by_guard`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { decideDoneGuard } from "../runtime/OrchestratorRuntime.js";

describe("M1-6e-4 decideDoneGuard (coding completion guard)", () => {
  it("success=false → allow (nothing to guard)", () => {
    assert.equal(decideDoneGuard({ success: false, lastTestFailed: 3, ranTestCommand: true }), "allow");
  });

  it("RunTests showed failures → test_failed (blocks + emits test_failed_but_claimed_done)", () => {
    assert.equal(decideDoneGuard({ success: true, lastTestFailed: 3, ranTestCommand: true }), "test_failed");
    assert.equal(decideDoneGuard({ success: true, lastTestFailed: 1, ranTestCommand: false }), "test_failed");
  });

  it("tests all green (failed=0) → allow", () => {
    assert.equal(decideDoneGuard({ success: true, lastTestFailed: 0, ranTestCommand: true }), "allow");
  });

  it("ran a test command but no valid result → missing_evidence", () => {
    assert.equal(decideDoneGuard({ success: true, lastTestFailed: null, ranTestCommand: true }), "missing_evidence");
  });

  it("never ran tests → allow (no evidence requirement)", () => {
    assert.equal(decideDoneGuard({ success: true, lastTestFailed: null, ranTestCommand: false }), "allow");
  });
});
