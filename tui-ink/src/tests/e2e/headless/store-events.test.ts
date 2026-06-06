/**
 * Headless tests: store applyEvent and token supervision.
 *
 * Tests the Zustand store logic in isolation — no TUI process, no HTTP.
 * Fast, deterministic, zero external dependencies.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  applyEvent, ensureAgent, getState, _resetForTest,
  setTokenBudget, pruneAgents, markPendingInput,
} from "../../../store.js";

beforeEach(() => _resetForTest());

describe("store: spawn event", () => {
  it("creates agent in store with correct fields", () => {
    applyEvent({ v: 1, type: "spawn", parent: "pm", child: "tl-01", role: "Leader", goal: "test goal" });
    const a = getState().agents.get("tl-01");
    assert.ok(a, "agent tl-01 not created");
    assert.equal(a.goal, "test goal");
    assert.equal(a.parent, "pm");
    assert.equal(a.role, "Leader");
    assert.equal(a.state, "idle");
  });

  it("adds spawn system message to parent conv", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "idle" });
    applyEvent({ v: 1, type: "spawn", parent: "pm", child: "tl-01", role: "Leader", goal: "spawn test" });
    const msgs = getState().messagesByAgent.get("pm") ?? [];
    const spawnMsg = msgs.find((m) => m.text.includes("tl-01"));
    assert.ok(spawnMsg, "No spawn message in parent pane");
  });
});

describe("store: agent.done", () => {
  it("sets agent state to done", () => {
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run" });
    applyEvent({ v: 1, type: "agent.done", agent: "tl-01", success: true, reason: "finished" });
    assert.equal(getState().agents.get("tl-01")?.state, "done");
  });

  it("sets agent state to err on failure", () => {
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run" });
    applyEvent({ v: 1, type: "agent.done", agent: "tl-01", success: false, reason: "error" });
    assert.equal(getState().agents.get("tl-01")?.state, "err");
  });
});

describe("store: message event", () => {
  it("to=user adds to agent conv pane", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "idle" });
    applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: "hello user" });
    const msgs = getState().messagesByAgent.get("pm") ?? [];
    assert.ok(msgs.some((m) => m.text === "hello user"));
  });

  it("to=other adds to both sender and recipient panes", () => {
    ensureAgent({ id: "pm",    name: "pm",    role: "Leader", state: "idle" });
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "idle" });
    applyEvent({ v: 1, type: "message", agent: "tl-01", to: "pm", text: "report" });
    const pmMsgs  = getState().messagesByAgent.get("pm")    ?? [];
    const tlMsgs  = getState().messagesByAgent.get("tl-01") ?? [];
    assert.ok(pmMsgs.some((m) => m.text.includes("report")));
    assert.ok(tlMsgs.some((m) => m.text.includes("report")));
  });
});

describe("store: prune", () => {
  it("global prune hides done agents, not running", () => {
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "done" });
    ensureAgent({ id: "tl-02", name: "tl-02", role: "Leader", state: "run" });
    pruneAgents();
    assert.equal(getState().agents.get("tl-01")?.hidden, true);
    assert.equal(getState().agents.get("tl-02")?.hidden, undefined);
  });

  it("targeted prune hides specific agent regardless of state", () => {
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run" });
    pruneAgents("tl-01");
    assert.equal(getState().agents.get("tl-01")?.hidden, true);
  });

  it("prune cascades to children", () => {
    ensureAgent({ id: "tl-01",     name: "tl-01",     role: "Leader", state: "run" });
    ensureAgent({ id: "worker-01", name: "worker-01", role: "Worker", state: "run", parent: "tl-01" });
    pruneAgents("tl-01");
    assert.equal(getState().agents.get("tl-01")?.hidden, true);
    assert.equal(getState().agents.get("worker-01")?.hidden, true);
  });

  it("pm is always immune to targeted prune", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "idle" });
    pruneAgents("pm");
    assert.equal(getState().agents.get("pm")?.hidden, undefined);
  });
});

// ── pendingInputAgents — "message queued" indicator ──────────────────────────
// These cover the bug where the hint only checked state==="run" and went blank
// during tool execution (state="idle" between LLM turns).

describe("store: pendingInputAgents (message-queued indicator)", () => {
  it("markPendingInput sets the flag for that agent", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "idle" });
    markPendingInput("pm");
    assert.ok(getState().pendingInputAgents.has("pm"),
      "flag not set after markPendingInput");
  });

  it("flag is cleared when agent.state:run fires — normal processing path", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "idle" });
    markPendingInput("pm");
    applyEvent({ v: 1, type: "agent.state", agent: "pm", state: "run", sub: "thinking…" });
    assert.equal(getState().pendingInputAgents.has("pm"), false,
      "flag not cleared on state:run");
  });

  it("flag persists during state:idle — tool execution gap must keep indicator visible", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });
    markPendingInput("pm");
    // Simulate LLM turn ending (agent emits idle between tool calls)
    applyEvent({ v: 1, type: "agent.state", agent: "pm", state: "idle", sub: "" });
    assert.ok(getState().pendingInputAgents.has("pm"),
      "flag wrongly cleared on state:idle — user would lose the queued indicator");
  });

  it("flag is cleared when agent.done fires (success)", () => {
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run" });
    markPendingInput("tl-01");
    applyEvent({ v: 1, type: "agent.done", agent: "tl-01", success: true, reason: "done" });
    assert.equal(getState().pendingInputAgents.has("tl-01"), false,
      "flag not cleared on agent.done success — hint would stay stuck forever");
  });

  it("flag is cleared when agent.done fires (failure)", () => {
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run" });
    markPendingInput("tl-01");
    applyEvent({ v: 1, type: "agent.done", agent: "tl-01", success: false, reason: "error" });
    assert.equal(getState().pendingInputAgents.has("tl-01"), false,
      "flag not cleared on agent.done failure");
  });

  it("flag is cleared when agent.state:err fires", () => {
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run" });
    markPendingInput("tl-01");
    applyEvent({ v: 1, type: "agent.state", agent: "tl-01", state: "err", sub: "timeout" });
    assert.equal(getState().pendingInputAgents.has("tl-01"), false,
      "flag not cleared on state:err — hint stays stuck after network error");
  });

  it("flag is cleared when agent.error fires", () => {
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run" });
    markPendingInput("tl-01");
    applyEvent({ v: 1, type: "agent.error", agent: "tl-01", code: "http_error", detail: "500" });
    assert.equal(getState().pendingInputAgents.has("tl-01"), false,
      "flag not cleared on agent.error");
  });

  it("clearing one agent's flag does not affect another agent", () => {
    ensureAgent({ id: "pm",    name: "pm",    role: "Leader", state: "idle" });
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run"  });
    markPendingInput("pm");
    markPendingInput("tl-01");
    applyEvent({ v: 1, type: "agent.state", agent: "tl-01", state: "run", sub: "" });
    assert.ok(getState().pendingInputAgents.has("pm"),
      "pm flag incorrectly cleared when tl-01 processed its message");
    assert.equal(getState().pendingInputAgents.has("tl-01"), false);
  });
});

describe("store: token supervision", () => {
  it("token.usage accumulates per agent", () => {
    applyEvent({ v: 1, type: "token.usage", agent: "pm", prompt: 100, completion: 50 });
    applyEvent({ v: 1, type: "token.usage", agent: "pm", prompt: 200, completion: 80 });
    const bucket = getState().tokensByAgent.get("pm");
    assert.equal(bucket?.prompt, 300);
    assert.equal(bucket?.completion, 130);
  });

  it("token.usage from different agents accumulates in sessionTokens", () => {
    applyEvent({ v: 1, type: "token.usage", agent: "pm",    prompt: 100, completion: 50 });
    applyEvent({ v: 1, type: "token.usage", agent: "tl-01", prompt: 200, completion: 100 });
    const s = getState().sessionTokens;
    assert.equal(s.prompt, 300);
    assert.equal(s.completion, 150);
  });

  it("setTokenBudget sets budget", () => {
    setTokenBudget(50_000);
    assert.equal(getState().tokenBudget, 50_000);
  });

  it("budget 0 means unlimited", () => {
    setTokenBudget(0);
    assert.equal(getState().tokenBudget, 0);
    // No warning messages should appear at 0 budget even with huge token count
    applyEvent({ v: 1, type: "token.usage", agent: "pm", prompt: 9_999_999, completion: 0 });
    const msgs = getState().messagesByAgent.get("pm") ?? [];
    const warnMsg = msgs.find((m) => m.text.includes("预算"));
    assert.equal(warnMsg, undefined, "Unexpected budget warning at unlimited budget");
  });

  it("budget warning appears when exceeding 80%", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "idle" });
    setTokenBudget(1_000);
    // Use 850 tokens to cross 80%
    applyEvent({ v: 1, type: "token.usage", agent: "pm", prompt: 850, completion: 0 });
    const msgs = getState().messagesByAgent.get("pm") ?? [];
    const warnMsg = msgs.find((m) => m.text.includes("预算"));
    assert.ok(warnMsg, "Expected budget warning at 85% usage");
  });

  it("_resetForTest clears token state", () => {
    applyEvent({ v: 1, type: "token.usage", agent: "pm", prompt: 500, completion: 200 });
    _resetForTest();
    assert.equal(getState().sessionTokens.prompt, 0);
    assert.equal(getState().sessionTokens.completion, 0);
    assert.equal(getState().tokensByAgent.size, 0);
    assert.equal(getState().tokenBudget, 0);
  });
});
