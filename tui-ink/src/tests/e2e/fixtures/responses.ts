/**
 * Pre-scripted LLM response factory functions for E2E tests.
 *
 * Each function returns a ScriptedResponse that can be passed to
 * mock.enqueue(). rawContent is emitted verbatim by the SSE server;
 * events[] is auto-wrapped in SSE delta chunks.
 */

import type { ScriptedResponse } from "../driver/MockLLMServer.js";

// ── Normal agent replies ───────────────────────────────────────────────────

export function pmReply(text: string): ScriptedResponse {
  return {
    agentId: "pm",
    events: [
      { v: 1, type: "message", to: "user", text },
      { v: 1, type: "agent.done", success: true, reason: "replied" },
    ],
  };
}

export function pmSpawnTL(tlId: string, goal: string): ScriptedResponse {
  return {
    agentId: "pm",
    events: [
      { v: 1, type: "step", agent: "pm", text: `spawning ${tlId}` },
      { v: 1, type: "spawn", role: "leader", id: tlId, goal, parent: "pm" },
      { v: 1, type: "agent.done", success: true, reason: "spawned TL" },
    ],
  };
}

export function tlSpawnWorker(
  tlId: string,
  workerId: string,
  goal: string,
): ScriptedResponse {
  return {
    agentId: tlId,
    events: [
      { v: 1, type: "step", agent: tlId, text: `spawning ${workerId}` },
      { v: 1, type: "spawn", role: "worker", id: workerId, goal, parent: tlId },
      { v: 1, type: "agent.done", success: true, reason: "spawned worker" },
    ],
  };
}

export function workerDone(workerId: string, result: string): ScriptedResponse {
  return {
    agentId: workerId,
    events: [
      { v: 1, type: "message", to: "parent", text: result },
      { v: 1, type: "agent.done", success: true, reason: result },
    ],
  };
}

/** A no-op PM response — useful as a "boot" placeholder when PM fires on startup. */
export const pmNoop: ScriptedResponse = {
  agentId: "pm",
  events: [
    { v: 1, type: "agent.done", success: true, reason: "idle" },
  ],
};

/** Match any agent — useful when you don't know which agent calls first. */
export function anyAgentNoop(): ScriptedResponse {
  return {
    agentId: null,
    events: [
      { v: 1, type: "agent.done", success: true, reason: "idle" },
    ],
  };
}

// ── Regression: fence-wrapped output ─────────────────────────────────────

/** Agent wraps its JSON events in a ```json ... ``` fence (should be stripped). */
export function fenceWrapped(
  agentId: string | null,
  text: string,
): ScriptedResponse {
  const msg  = JSON.stringify({ v: 1, type: "message", to: "user", text });
  const done = JSON.stringify({ v: 1, type: "agent.done", success: true, reason: "done" });
  return {
    agentId,
    rawContent: "```json\n" + msg + "\n```\n" + done + "\n",
  };
}

/** Agent wraps in plain ``` fence (no language tag). */
export function plainFenceWrapped(
  agentId: string | null,
  text: string,
): ScriptedResponse {
  const msg  = JSON.stringify({ v: 1, type: "message", to: "user", text });
  const done = JSON.stringify({ v: 1, type: "agent.done", success: true, reason: "done" });
  return {
    agentId,
    rawContent: "```\n" + msg + "\n```\n" + done + "\n",
  };
}

// ── Regression: <thinking> block ─────────────────────────────────────────

/** Agent emits a DeepSeek-style <thinking> block before the real response. */
export function thinkingBlock(
  agentId: string | null,
  afterText: string,
): ScriptedResponse {
  const msg  = JSON.stringify({ v: 1, type: "message", to: "user", text: afterText });
  const done = JSON.stringify({ v: 1, type: "agent.done", success: true, reason: "done" });
  return {
    agentId,
    rawContent:
      "<thinking>\ninternal chain-of-thought goes here\ncould be multiple lines\n</thinking>\n" +
      msg + "\n" + done + "\n",
  };
}

// ── Regression: inline JSON on prose line ────────────────────────────────

/** Agent writes prose text + JSON event on the same line. */
export function inlineJsonOnProse(
  agentId: string | null,
  text: string,
): ScriptedResponse {
  const msg  = JSON.stringify({ v: 1, type: "message", to: "user", text });
  const done = JSON.stringify({ v: 1, type: "agent.done", success: true, reason: "done" });
  return {
    agentId,
    rawContent: `Here is my response: ${msg}\n${done}\n`,
  };
}

// ── Regression: duplicate TL spawn ───────────────────────────────────────

/** PM tries to spawn a second TL with the same goal — TUI should block it. */
export function pmDuplicateSpawn(
  tlId: string,
  goal: string,
): ScriptedResponse {
  return {
    agentId: "pm",
    events: [
      { v: 1, type: "step", agent: "pm", text: "attempting duplicate TL spawn" },
      { v: 1, type: "spawn", role: "leader", id: tlId, goal, parent: "pm" },
      { v: 1, type: "agent.done", success: true, reason: "spawned" },
    ],
  };
}

// ── Regression: ESC interrupt ────────────────────────────────────────────

/**
 * PM emits a tool.call that requires approval (rm = destructive bash).
 * Use delayMs so the test has time to press ESC before the response finishes.
 */
export function pmRequestsApproval(): ScriptedResponse {
  return {
    agentId: "pm",
    events: [
      { v: 1, type: "step", agent: "pm", text: "running destructive command" },
      {
        v: 1,
        type: "tool.call",
        id: "tc-esc-test-001",
        name: "Bash",
        input: { cmd: "rm -rf /tmp/tui-e2e-canary" },
      },
    ],
    delayMs: 300,
  };
}
