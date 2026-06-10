/**
 * Headless test: Stage 0 fast-answer gate — PM responds directly without spawn.
 *
 * Uses MockLLMServer + HttpConvAgent to verify that simple Q&A inputs result in
 * a message.to=user event and NO spawn event. Models the Stage 0 short-circuit path.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MockLLMServer } from "../driver/MockLLMServer.js";
import { HttpConvAgent } from "../../../adapters/httpAgent.js";
import type { TuiEvent } from "../../../protocol.js";

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

interface CollectedEvents {
  messages: Extract<TuiEvent, { type: "message" }>[];
  spawns:   Extract<TuiEvent, { type: "spawn" }>[];
  all:      TuiEvent[];
}

async function runAndCollect(agent: HttpConvAgent, input: string): Promise<CollectedEvents> {
  const collected: CollectedEvents = { messages: [], spawns: [], all: [] };
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("agent timeout after 8s")), 8_000);
    agent.on("event", (ev: TuiEvent) => {
      collected.all.push(ev);
      if (ev.type === "message") collected.messages.push(ev as Extract<TuiEvent, { type: "message" }>);
      if (ev.type === "spawn")   collected.spawns.push(ev as Extract<TuiEvent, { type: "spawn" }>);
      if (ev.type === "agent.state" && ev.state === "idle") {
        clearTimeout(t);
        resolve();
      }
    });
    agent.send(input);
  });
  return collected;
}

describe("stage0-parsing: direct answer path emits message, no spawn", () => {
  const mock = new MockLLMServer();
  let port: number;

  before(async () => { port = await mock.start(); });
  after(async () => { mock.reset(); await mock.stop(); });
  beforeEach(() => mock.reset());

  it("concept-explanation input → message.to=user, zero spawn events", async () => {
    mock.enqueue({
      agentId: null,
      events: [
        { v: 1, type: "message", to: "user", text: "React 是一个用于构建用户界面的 JavaScript 库。" },
        { v: 1, type: "agent.done", success: true, reason: "direct-answer" },
      ],
    });

    const ev = await runAndCollect(makeAgent(port, "stage0-a"), "React 和 Vue 的核心区别是什么？");

    assert.ok(ev.messages.length >= 1, "must emit at least one message event");
    const toUser = ev.messages.find((m) => (m as { to?: string }).to === "user");
    assert.ok(toUser, "must have a message.to=user event");
    assert.equal(ev.spawns.length, 0, "Stage 0 path must NOT emit any spawn event");
  });

  it("factual-lookup input → message.to=user, zero spawn events", async () => {
    mock.enqueue({
      agentId: null,
      events: [
        { v: 1, type: "message", to: "user", text: "HTTP 301 是永久重定向，302 是临时重定向。" },
        { v: 1, type: "agent.done", success: true, reason: "direct-answer" },
      ],
    });

    const ev = await runAndCollect(makeAgent(port, "stage0-b"), "HTTP 301 和 302 的区别？");

    assert.ok(ev.messages.length >= 1);
    const toUser = ev.messages.find((m) => (m as { to?: string }).to === "user");
    assert.ok(toUser, "factual answer must route to user, not spawn");
    assert.equal(ev.spawns.length, 0, "no spawn for simple factual question");
  });

  it("multi-file analysis triggers spawn (must NOT be short-circuited)", async () => {
    // This verifies the counter-example: complex task must still spawn
    mock.enqueue({
      agentId: null,
      events: [
        { v: 1, type: "spawn", parent: "pm", child: "tl-01", role: "Leader",
          goal: "analyse src/ code quality and report",
          dispatch: {
            background: "user asked for code quality analysis",
            constraints: [],
            acceptance_criteria: ["quality report produced"],
            stop_conditions: ["agent.done"],
          },
        },
        { v: 1, type: "message", to: "user", text: "已 spawn tl-01 处理代码质量分析。" },
        { v: 1, type: "agent.done", success: true, reason: "spawned" },
      ],
    });

    const ev = await runAndCollect(makeAgent(port, "stage0-c"), "帮我分析一下 src/ 下的代码质量");

    assert.ok(ev.spawns.length >= 1, "complex task must emit spawn event");
  });
});
