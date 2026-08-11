/**
 * M1-6b · ToolRuntime façade contract.
 * Asserts the guarantees in docs/spawn-1.0/M1-6b-SPEC.md §4.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runToolBatch,
  formatToolResults,
  findApproverLeader,
  executeTool,
  toolNeedsApproval,
  buildToolSchemaBlock,
  type ToolCall,
  type ToolResult,
} from "../runtime/ToolRuntime.js";
import * as registry from "../tools/registry.js";
import { HttpConvAgent } from "../adapters/httpAgent.js";

function mkAgent(id: string, role: string): HttpConvAgent {
  return new HttpConvAgent({ id, role, providerCfg: { baseUrl: "http://x", apiKey: "k", model: "m" } as any });
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { v: 1, type: "tool.call", agent: "a1", id, name, args } as ToolCall;
}

describe("M1-6b ToolRuntime façade", () => {
  it("§4.1 runToolBatch preserves order and equals per-call executeTool", async () => {
    const batch: ToolCall[] = [call("1", "LS", { path: "." }), call("2", "LS", { path: "." })];
    const viaBatch = await runToolBatch(batch, "a1");
    const viaLoop: ToolResult[] = [];
    for (const c of batch) viaLoop.push(await executeTool(c.name, c.args, { agentId: "a1" }));
    assert.equal(viaBatch.length, 2);
    for (let i = 0; i < 2; i++) {
      assert.equal(viaBatch[i]!.ok, viaLoop[i]!.ok);
      assert.equal(viaBatch[i]!.output, viaLoop[i]!.output);
    }
    assert.deepEqual(await runToolBatch([], "a1"), []);
  });

  it("§4.2 formatToolResults is byte-identical to the old inline builder", () => {
    const batch: ToolCall[] = [call("aa", "Read", {}), call("bb", "Read", {})];
    const results: ToolResult[] = [
      { ok: true, output: "hello" },
      { ok: false, output: "boom" },
    ];
    const expected = batch
      .map((c, i) => `[tool_result id="${c.id}" ok="${results[i]!.ok}"]\n${results[i]!.output}`)
      .join("\n\n");
    assert.equal(formatToolResults(batch, results), expected);
    // one result → no separator
    assert.equal(formatToolResults([batch[0]!], [results[0]!]), `[tool_result id="aa" ok="true"]\nhello`);
    // two results → exactly one \n\n separator
    assert.equal(formatToolResults(batch, results).split("\n\n").length, 2);
  });

  it("§4.3 findApproverLeader walks the parent chain to nearest Leader/PM", () => {
    const pm = mkAgent("pm", "Leader");
    const tl = mkAgent("tl", "Leader");
    const worker = mkAgent("worker", "Worker");
    const agents = new Map<string, HttpConvAgent>([["pm", pm], ["tl", tl], ["worker", worker]]);
    const storeAgents = new Map<string, { parent?: string; role?: string }>([
      ["pm", { role: "Leader" }],
      ["tl", { parent: "pm", role: "Leader" }],
      ["worker", { parent: "tl", role: "Worker" }],
    ]);
    const ctx = { agents, getState: () => ({ agents: storeAgents }) };

    // worker → nearest Leader up the chain = tl
    assert.equal(findApproverLeader("worker", ctx), tl);
    // child directly under pm → pm
    storeAgents.set("direct", { parent: "pm", role: "Worker" });
    agents.set("direct", mkAgent("direct", "Worker"));
    assert.equal(findApproverLeader("direct", ctx), pm);
    // no parent (root) → pm fallback
    assert.equal(findApproverLeader("pm", ctx), pm);
  });

  it("§4.4 façade re-exports the registry unwrapped", () => {
    assert.equal(executeTool, registry.executeTool);
    assert.equal(toolNeedsApproval, registry.toolNeedsApproval);
    assert.equal(buildToolSchemaBlock, registry.buildToolSchemaBlock);
  });
});
