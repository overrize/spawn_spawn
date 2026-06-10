/**
 * Headless test: token.usage events must contain ttft_ms and total_ms timing fields.
 * Uses MockLLMServer + HttpConvAgent directly — no TUI process, no real LLM calls.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { MockLLMServer } from "../driver/MockLLMServer.js";
import { HttpConvAgent } from "../../../adapters/httpAgent.js";
import type { TuiEvent } from "../../../protocol.js";

type UsageEv = Extract<TuiEvent, { type: "token.usage" }>;

function makeAgent(port: number, id = "latency-test"): HttpConvAgent {
  return new HttpConvAgent({
    id,
    role: "Leader",
    providerCfg: {
      provider: "openai",
      model: "test-model",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${port}`,
    },
  });
}

async function runAgent(agent: HttpConvAgent, message = "hello"): Promise<UsageEv[]> {
  const usageEvents: UsageEv[] = [];
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("agent timeout after 5s")), 5_000);
    agent.on("event", (ev: TuiEvent) => {
      if (ev.type === "token.usage") usageEvents.push(ev as UsageEv);
      if (ev.type === "agent.state" && ev.state === "idle") {
        clearTimeout(timeout);
        resolve();
      }
    });
    agent.send(message);
  });
  return usageEvents;
}

describe("latency-fields: token.usage carries ttft_ms and total_ms", () => {
  const mock = new MockLLMServer();
  let port: number;

  before(async () => { port = await mock.start(); });
  after(async () => { mock.reset(); await mock.stop(); });

  it("emits token.usage with ttft_ms and total_ms on every LLM call", async () => {
    mock.enqueue({
      agentId: null,
      events: [
        { v: 1, type: "message", to: "user", text: "React 是一个 JavaScript UI 库。" },
        { v: 1, type: "agent.done", success: true, reason: "answered" },
      ],
    });

    const events = await runAgent(makeAgent(port, "agent-a"));

    assert.ok(events.length >= 1, `Expected ≥1 token.usage event, got ${events.length}`);
    const u = events[0]!;
    assert.ok("ttft_ms" in u,    "token.usage must have ttft_ms field");
    assert.ok("total_ms" in u,   "token.usage must have total_ms field");
    assert.equal(typeof u.ttft_ms,  "number", "ttft_ms must be a number");
    assert.equal(typeof u.total_ms, "number", "total_ms must be a number");
    assert.ok(u.total_ms! >= u.ttft_ms!, `total_ms(${u.total_ms}) must be ≥ ttft_ms(${u.ttft_ms})`);
  });

  it("token.usage is emitted even when server sends zero token counts", async () => {
    // MockLLMServer does not include usage data in SSE — confirms we always emit
    mock.enqueue({
      agentId: null,
      events: [
        { v: 1, type: "message", to: "user", text: "ok" },
        { v: 1, type: "agent.done", success: true },
      ],
    });

    const events = await runAgent(makeAgent(port, "agent-b"));
    assert.ok(events.length >= 1, "token.usage must be emitted even with zero token counts");
    const u = events[0]!;
    assert.equal(u.prompt,     0, "prompt tokens are 0 from mock");
    assert.equal(u.completion, 0, "completion tokens are 0 from mock");
    assert.ok("ttft_ms"  in u, "ttft_ms present even with zero tokens");
    assert.ok("total_ms" in u, "total_ms present even with zero tokens");
  });

  it("total_ms is always >= ttft_ms", async () => {
    mock.enqueue({
      agentId: null,
      delayMs: 5,
      events: [
        { v: 1, type: "step",    text: "processing" },
        { v: 1, type: "message", to: "user", text: "result" },
        { v: 1, type: "agent.done", success: true },
      ],
    });

    const events = await runAgent(makeAgent(port, "agent-c"));
    assert.ok(events.length >= 1);
    const u = events[0]!;
    assert.ok(
      u.total_ms! >= u.ttft_ms!,
      `total_ms(${u.total_ms}) must be >= ttft_ms(${u.ttft_ms})`,
    );
  });
});
