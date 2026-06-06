/**
 * Stability tests: multi-turn session with no hangs or crashes.
 *
 * These tests run longer than smoke/regression tests and verify that the TUI
 * remains responsive across many LLM turns without memory leaks or silent idle.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MockLLMServer } from "../driver/MockLLMServer.js";
import { TuiDriver } from "../driver/TuiDriver.js";
import { pmReply } from "../fixtures/responses.js";

describe("stability: long multi-turn session", () => {
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

  it("10 consecutive user→PM turns without hang", { timeout: 120_000 }, async () => {
    const TURNS = 10;
    for (let i = 0; i < TURNS; i++) {
      mock.enqueue(pmReply(`turn-${i}-ack`));
    }

    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();

      for (let i = 0; i < TURNS; i++) {
        await driver.sendLine(`message ${i}`);
        await driver.waitFor(`turn-${i}-ack`, 15_000);
      }

      // After 10 turns TUI must still be alive and rendering
      driver.assertContains("AGENTS");
      assert.equal(mock.calls.length >= TURNS, true, `Expected ≥${TURNS} LLM calls`);
    } finally {
      driver.destroy();
    }
  });

  it("TUI stays responsive after agent completion (no zombie loop)", { timeout: 60_000 }, async () => {
    // Agent completes then TUI should go quiet, not spam nudges
    mock.enqueue(pmReply("task-complete-marker"));

    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("do a task");
      await driver.waitFor("task-complete-marker", 20_000);

      // Wait 5 seconds — TUI should not be making additional LLM calls
      const callsBefore = mock.calls.length;
      await new Promise((r) => setTimeout(r, 5_000));
      const callsAfter = mock.calls.length;

      // Allow at most 1 extra call (secretary or nudge cycle starting)
      const extraCalls = callsAfter - callsBefore;
      if (extraCalls > 2) {
        throw new Error(
          `${extraCalls} unexpected LLM calls after agent completed (zombie loop?). ` +
          `calls before=${callsBefore} after=${callsAfter}`,
        );
      }
    } finally {
      driver.destroy();
    }
  });
});
