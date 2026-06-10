/**
 * Agent-level latency measurement tests.
 * Tests that ttft_ms accurately reflects the server-side start delay introduced
 * by MockLLMServer.enqueueDelayed(), confirming the timing path is wired correctly.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { MockLLMServer } from "../driver/MockLLMServer.js";
import { HttpConvAgent } from "../../../adapters/httpAgent.js";
import type { TuiEvent } from "../../../protocol.js";

type UsageEv = Extract<TuiEvent, { type: "token.usage" }>;

function makeAgent(port: number, id: string): HttpConvAgent {
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

async function collectUsage(agent: HttpConvAgent): Promise<UsageEv[]> {
  const collected: UsageEv[] = [];
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout after 10s")), 10_000);
    agent.on("event", (ev: TuiEvent) => {
      if (ev.type === "token.usage") collected.push(ev as UsageEv);
      if (ev.type === "agent.state" && ev.state === "idle") {
        clearTimeout(t);
        resolve();
      }
    });
    agent.send("measure latency");
  });
  return collected;
}

describe("latency-measure: ttft_ms reflects real server-side delay", () => {
  const mock = new MockLLMServer();
  let port: number;

  before(async () => { port = await mock.start(); });
  after(async () => { mock.reset(); await mock.stop(); });

  it("ttft_ms >= startDelayMs * 0.7 (70% floor, 30% timing jitter budget)", async () => {
    const START_DELAY_MS = 50;
    mock.enqueueDelayed(START_DELAY_MS, {
      agentId: null,
      events: [
        { v: 1, type: "message", to: "user", text: "pong" },
        { v: 1, type: "agent.done", success: true },
      ],
    });

    const events = await collectUsage(makeAgent(port, "measure-a"));

    assert.ok(events.length >= 1, "must emit at least one token.usage event");
    const u = events[0]!;
    assert.equal(typeof u.ttft_ms,  "number", "ttft_ms must be a number");
    assert.equal(typeof u.total_ms, "number", "total_ms must be a number");

    const floor = Math.floor(START_DELAY_MS * 0.7);
    assert.ok(
      u.ttft_ms! >= floor,
      `ttft_ms(${u.ttft_ms}ms) should be ≥ ${floor}ms (70% of ${START_DELAY_MS}ms server delay)`,
    );
    assert.ok(
      u.total_ms! >= u.ttft_ms!,
      `total_ms(${u.total_ms}) must be ≥ ttft_ms(${u.ttft_ms})`,
    );
  });

  it("total_ms > ttft_ms when streaming has per-chunk delay", async () => {
    const START_DELAY_MS = 20;
    const CHUNK_DELAY_MS = 10;
    // 3 chunks × 10ms = 30ms streaming after ttft — so total_ms >> ttft_ms
    mock.enqueueDelayed(START_DELAY_MS, {
      agentId: null,
      delayMs: CHUNK_DELAY_MS,
      events: [
        { v: 1, type: "step",    text: "t1" },
        { v: 1, type: "step",    text: "t2" },
        { v: 1, type: "message", to: "user", text: "done" },
        { v: 1, type: "agent.done", success: true },
      ],
    });

    const events = await collectUsage(makeAgent(port, "measure-b"));

    assert.ok(events.length >= 1);
    const u = events[0]!;
    assert.ok(u.total_ms! >= u.ttft_ms!, `total_ms(${u.total_ms}) >= ttft_ms(${u.ttft_ms})`);
    // total includes streaming time on top of ttft
    const expectedMin = START_DELAY_MS + CHUNK_DELAY_MS * 2;
    assert.ok(
      u.total_ms! >= Math.floor(expectedMin * 0.5),
      `total_ms(${u.total_ms}) should reflect streaming time (expected ≥ ${Math.floor(expectedMin * 0.5)}ms)`,
    );
  });

  it("no-delay response has total_ms >= ttft_ms even when both are small", async () => {
    mock.enqueue({
      agentId: null,
      events: [
        { v: 1, type: "message", to: "user", text: "immediate" },
        { v: 1, type: "agent.done", success: true },
      ],
    });

    const events = await collectUsage(makeAgent(port, "measure-c"));

    assert.ok(events.length >= 1);
    const u = events[0]!;
    assert.ok(u.total_ms! >= u.ttft_ms!, `total_ms(${u.total_ms}) >= ttft_ms(${u.ttft_ms})`);
  });
});
