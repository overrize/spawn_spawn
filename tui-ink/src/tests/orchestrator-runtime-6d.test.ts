/**
 * M1-6d · OrchestratorRuntime façade contract.
 * Asserts the guarantees in docs/spawn-1.0/M1-6d-SPEC.md §4.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  checkMessageLegal,
  replaceAgentForResume,
} from "../runtime/OrchestratorRuntime.js";
import type { TuiEvent } from "../protocol.js";

function msg(agent: string, to: string): Extract<TuiEvent, { type: "message" }> {
  return { v: 1, type: "message", agent, to, text: "hi" } as any;
}

function ctxWith(roles: Record<string, string>) {
  const events: TuiEvent[] = [];
  const observed: TuiEvent[] = [];
  const agents = new Map(Object.entries(roles).map(([id, role]) => [id, { role }]));
  return {
    events,
    observed,
    ctx: {
      getState: () => ({ agents }),
      applyEvent: (e: TuiEvent) => { events.push(e); },
      pm: { observe: (e: TuiEvent) => { observed.push(e); } },
    },
  };
}

describe("M1-6d OrchestratorRuntime façade", () => {
  it("§4.1 checkMessageLegal blocks Worker→user and Worker→Worker", () => {
    // Worker → user
    let h = ctxWith({ w1: "Worker" });
    assert.equal(checkMessageLegal(msg("w1", "user"), h.ctx), false);
    assert.equal(h.events[0]?.type, "agent.error");
    assert.equal((h.events[0] as any).code, "illegal_message");
    assert.equal(h.observed.length, 1, "worker→user still observed by pm");

    // Worker → Worker
    h = ctxWith({ w1: "Worker", w2: "Worker" });
    assert.equal(checkMessageLegal(msg("w1", "w2"), h.ctx), false);
    assert.equal((h.events[0] as any).code, "illegal_message");

    // Leader → user : allowed
    h = ctxWith({ pm: "Leader" });
    assert.equal(checkMessageLegal(msg("pm", "user"), h.ctx), true);
    assert.equal(h.events.length, 0);

    // Leader → Leader : allowed
    h = ctxWith({ tl: "Leader", pm: "Leader" });
    assert.equal(checkMessageLegal(msg("tl", "pm"), h.ctx), true);

    // unknown sender : allowed
    h = ctxWith({});
    assert.equal(checkMessageLegal(msg("ghost", "user"), h.ctx), true);
  });

  it("§4.2 replaceAgentForResume tears down live agent, keeps sessions map slots", () => {
    let killed = 0;
    let destroyed = 0;
    const agents = new Map<string, any>([["a1", { kill: () => { killed++; } }]]);
    const secretaries = new Map<string, any>([["a1", { destroy: () => { destroyed++; } }]]);
    const killedAgents = new Set<string>(["a1"]);

    replaceAgentForResume("a1", { agents, secretaries, killedAgents } as any);

    assert.equal(killed, 1, "agent killed");
    assert.equal(agents.has("a1"), false, "removed from agents");
    assert.equal(destroyed, 1, "secretary destroyed");
    assert.equal(secretaries.has("a1"), false, "removed from secretaries");
    assert.equal(killedAgents.has("a1"), false, "cleared from killedAgents");
  });

  it("§4.3 façade still re-exports the runtime pieces", async () => {
    const mod = await import("../runtime/OrchestratorRuntime.js");
    for (const name of ["ProcessManager", "TurnController", "TaskScheduler", "classifyFollowup"]) {
      assert.ok((mod as any)[name], `re-exports ${name}`);
    }
  });
});
