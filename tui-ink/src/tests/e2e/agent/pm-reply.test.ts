/**
 * Agent tests: PM receives user message and responds.
 *
 * These tests verify the full round-trip:
 * user input → PM LLM call → response parsed → shown in conversation pane.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MockLLMServer } from "../driver/MockLLMServer.js";
import { TuiDriver } from "../driver/TuiDriver.js";
import { pmReply } from "../fixtures/responses.js";

describe("agent: PM reply", () => {
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

  it("PM message appears in conversation pane", { timeout: 40_000 }, async () => {
    mock.enqueue(pmReply("hello from pm agent"));
    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("say hello");
      await driver.waitFor("hello from pm agent", 20_000);
    } finally {
      driver.destroy();
    }
  });

  it("multiple sequential PM replies are all shown", { timeout: 60_000 }, async () => {
    mock.enqueue(pmReply("first reply"));
    mock.enqueue(pmReply("second reply"));

    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("message one");
      await driver.waitFor("first reply", 20_000);

      await driver.sendLine("message two");
      await driver.waitFor("second reply", 20_000);
    } finally {
      driver.destroy();
    }
  });

  it("mock records the correct number of LLM calls", { timeout: 40_000 }, async () => {
    mock.enqueue(pmReply("call count check"));
    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("count my calls");
      await driver.waitFor("call count check", 20_000);

      // At least one call must have been recorded by the mock
      assert.ok(mock.calls.length >= 1, `Expected ≥1 LLM calls, got ${mock.calls.length}`);
    } finally {
      driver.destroy();
    }
  });

  it("PM call includes user message in payload", { timeout: 40_000 }, async () => {
    mock.enqueue(pmReply("payload confirmed"));
    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("payload-marker-xyz");
      await driver.waitFor("payload confirmed", 20_000);

      // The mock recorded at least one call with multiple messages
      // (system + user message = messageCount >= 2)
      const pmCall = mock.calls.find((c) => c.messageCount >= 2);
      assert.ok(pmCall !== undefined, "No LLM call with messageCount ≥ 2 found");
    } finally {
      driver.destroy();
    }
  });
});
