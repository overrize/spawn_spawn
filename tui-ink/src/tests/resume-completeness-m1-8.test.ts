/**
 * M1-8 · resume completeness — the interrupted "现场" (in-flight tool.calls /
 * pending approvals) is persisted to the tombstone so resume restores it, not
 * just memory.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SecretaryProxy } from "../memory/SecretaryProxy.js";
import { createMemory, loadMemory } from "../memory/MemoryStore.js";
import type { TuiEvent } from "../protocol.js";

let tmpDir: string, origCwd: string;
before(() => { origCwd = process.cwd(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-8-")); process.chdir(tmpDir); });
after(() => { process.chdir(origCwd); fs.rmSync(tmpDir, { recursive: true, force: true }); });

function sec(id = "w-1") {
  return new SecretaryProxy(createMemory({ agentId: id, agentType: "WORKER", parentChain: [], depth: 2, model: "m", roleName: "Worker" }));
}
const call = (agent: string, id: string, name: string, needs = false): TuiEvent =>
  ({ v: 1, type: "tool.call", agent, id, name, args: {}, needs_approval: needs } as TuiEvent);
const result = (agent: string, id: string): TuiEvent =>
  ({ v: 1, type: "tool.result", agent, id, ok: true, output: "x" } as TuiEvent);

describe("M1-8 in-flight tool.calls → tombstone", () => {
  let s: SecretaryProxy;
  beforeEach(() => { s = sec(); });

  it("unresolved tool.call is persisted; resolved one is not", () => {
    s.observe(call("w-1", "t1", "Bash", true));
    s.observe(call("w-1", "t2", "Read"));
    s.observe(result("w-1", "t2"));           // t2 completes
    // force a flush via done? no — use a fresh reload after snapshot timer isn't fired.
    // trigger a save by observing a spawn (saveAsync) then read from disk.
    s.observe({ v: 1, type: "spawn", parent: "w-1", child: "c", role: "Worker", goal: "g",
      dispatch: { background: "b", constraints: [], acceptance_criteria: ["a"], stop_conditions: ["s"] } } as TuiEvent);
    // saveAsync uses setImmediate; wait a tick.
    return new Promise<void>((res) => setImmediate(() => {
      const m = loadMemory("w-1");
      const pending = m?.tombstone.pending_tool_calls ?? [];
      assert.equal(pending.length, 1);
      assert.equal(pending[0]!.id, "t1");
      assert.equal(pending[0]!.needs_approval, true);
      res();
    }));
  });

  it("agent.done clears pending (a completed agent has no 现场)", () => {
    s.observe(call("w-1", "t1", "Bash"));
    s.observe({ v: 1, type: "agent.done", agent: "w-1", success: true, reason: "done" } as TuiEvent);
    assert.equal(s.getMemory().tombstone.pending_tool_calls, undefined);
    const m = loadMemory("w-1");
    assert.equal(m?.tombstone.pending_tool_calls ?? undefined, undefined);
  });

  it("only the agent's own tool.calls are tracked", () => {
    s.observe(call("other", "x1", "Bash"));   // different agent
    s.observe(call("w-1", "t1", "Read"));
    s.observe({ v: 1, type: "agent.error", agent: "w-1", code: "http_error" } as TuiEvent); // flushSync
    const m = loadMemory("w-1");
    const pending = m?.tombstone.pending_tool_calls ?? [];
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.id, "t1");
  });
});
