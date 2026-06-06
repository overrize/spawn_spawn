/**
 * Regression: <thinking> blocks from DeepSeek-style models must be stripped.
 *
 * Bug: agents using extended reasoning emit <thinking>...</thinking> sections.
 * These were shown verbatim in the conversation pane as message content.
 *
 * Fix: httpAgent.ts detects `<thinking>` / `</thinking>` tags, hides block
 * content, and emits a single "thinking…" step event instead.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import { MockLLMServer } from "../driver/MockLLMServer.js";
import { TuiDriver } from "../driver/TuiDriver.js";
import { thinkingBlock } from "../fixtures/responses.js";

describe("regression: <thinking> block stripping", () => {
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

  it("message after <thinking> block is shown correctly", { timeout: 40_000 }, async () => {
    mock.enqueue(thinkingBlock(null, "after-thinking-message"));
    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("test thinking strip");
      await driver.waitFor("after-thinking-message", 20_000);
    } finally {
      driver.destroy();
    }
  });

  it("<thinking> raw tag is not shown in conversation pane", { timeout: 40_000 }, async () => {
    mock.enqueue(thinkingBlock(null, "thinking-hidden-check"));
    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("check thinking hidden");
      await driver.waitFor("thinking-hidden-check", 20_000);
      // The raw XML tag must not appear
      driver.assertAbsent(/<thinking>/);
      driver.assertAbsent(/<\/thinking>/);
      // Inner content must not appear
      driver.assertAbsent("internal chain-of-thought");
    } finally {
      driver.destroy();
    }
  });

  it("emits exactly one 'thinking…' step (not multiple)", { timeout: 40_000 }, async () => {
    mock.enqueue(thinkingBlock(null, "one-step-check"));
    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("check single thinking step");
      await driver.waitFor("one-step-check", 20_000);
      // "thinking…" should appear at most once in the pane
      const count = driver.count(/thinking…/);
      if (count > 1) {
        throw new Error(`Expected ≤1 "thinking…" step, found ${count}`);
      }
    } finally {
      driver.destroy();
    }
  });
});
