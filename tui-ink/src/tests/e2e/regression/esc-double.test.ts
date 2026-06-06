/**
 * Regression: ESC must fire the interrupt handler exactly once.
 *
 * Bug: Both App.useInput and InputBar.useInput handled the Escape key,
 * causing two "⏹ interrupted" messages to appear in the pane.
 *
 * Fix: index.tsx gates the App-level ESC handler on `pending.length > 0`
 * so only one handler fires per keypress.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import { MockLLMServer } from "../driver/MockLLMServer.js";
import { TuiDriver } from "../driver/TuiDriver.js";

describe("regression: ESC fires only once", () => {
  let mock: MockLLMServer;
  let port: number;

  before(async () => {
    mock = new MockLLMServer();
    port = await mock.start();
  });

  after(async () => {
    await mock.stop();
  });

  beforeEach(() => mock.reset());

  it("pressing ESC once produces at most one interrupt indicator", { timeout: 40_000 }, async () => {
    // Enqueue a slow response so the agent stays "running" when ESC fires
    mock.enqueue({
      agentId: null,
      events: [
        { v: 1, type: "step", agent: "pm", text: "working…" },
        { v: 1, type: "message", to: "user", text: "esc-test-response" },
        { v: 1, type: "agent.done", success: true, reason: "done" },
      ],
      delayMs: 400,
    });

    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      // Trigger PM to start processing (slow mock gives us a window)
      await driver.sendLine("start slow task");
      // Immediately press ESC while the agent is likely still running
      await driver.key("Escape");
      // Wait briefly for any interrupt message to render
      await new Promise((r) => setTimeout(r, 1_000));

      const out = driver.capture();
      // Count ESC-related indicators — must be 0 or 1, never 2+
      const interrupted = (out.match(/⏹|interrupted/gi) ?? []).length;
      if (interrupted > 1) {
        throw new Error(
          `ESC fired ${interrupted} times (expected ≤1)\nPane:\n${out}`,
        );
      }
    } finally {
      driver.destroy();
    }
  });

  it("pressing ESC twice shows at most two separate interrupts (not 4)", { timeout: 40_000 }, async () => {
    // Two messages, two potential ESC presses
    mock.enqueue({
      agentId: null,
      events: [{ v: 1, type: "step", agent: "pm", text: "turn 1" }],
      delayMs: 500,
    });
    mock.enqueue({
      agentId: null,
      events: [{ v: 1, type: "step", agent: "pm", text: "turn 2" }],
      delayMs: 500,
    });

    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("turn one");
      await driver.key("Escape");
      await new Promise((r) => setTimeout(r, 800));
      await driver.sendLine("turn two");
      await driver.key("Escape");
      await new Promise((r) => setTimeout(r, 800));

      const out = driver.capture();
      const interrupted = (out.match(/⏹|interrupted/gi) ?? []).length;
      if (interrupted > 2) {
        throw new Error(
          `Expected ≤2 interrupts for 2 ESC presses, got ${interrupted}\nPane:\n${out}`,
        );
      }
    } finally {
      driver.destroy();
    }
  });
});
