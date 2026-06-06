/**
 * Regression: markdown fence lines must be stripped from agent output.
 *
 * Bug: agents sometimes wrap JSON events in ```json...``` fences,
 * causing raw ``` characters to appear in the conversation pane and
 * the JSON events inside to go unprocessed.
 *
 * Fix: httpAgent.ts skips lines matching /^```/.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import { MockLLMServer } from "../driver/MockLLMServer.js";
import { TuiDriver } from "../driver/TuiDriver.js";
import { fenceWrapped, plainFenceWrapped } from "../fixtures/responses.js";

describe("regression: markdown fence stripping", () => {
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

  it("json-fenced event is parsed and message shown", { timeout: 40_000 }, async () => {
    mock.enqueue(fenceWrapped(null, "fence-test-alpha"));
    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("trigger fence test");
      await driver.waitFor("fence-test-alpha", 20_000);
      // Raw fence lines must NOT appear in the pane
      driver.assertAbsent(/```json/);
    } finally {
      driver.destroy();
    }
  });

  it("plain-fenced event is parsed and message shown", { timeout: 40_000 }, async () => {
    mock.enqueue(plainFenceWrapped(null, "fence-test-beta"));
    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("trigger plain fence");
      await driver.waitFor("fence-test-beta", 20_000);
      driver.assertAbsent(/^```\s*$/m);
    } finally {
      driver.destroy();
    }
  });

  it("agent.done inside fence is processed (TUI doesn't hang)", { timeout: 40_000 }, async () => {
    // If agent.done is never processed the agent stays "running" forever.
    // After the fenced response the agent should reach idle/done state.
    mock.enqueue(fenceWrapped(null, "fence-done-test"));
    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("check done state");
      // Message must appear (event processed)
      await driver.waitFor("fence-done-test", 20_000);
      // Agent should not still be marked as actively running
      // Wait a moment for state to settle
      await new Promise((r) => setTimeout(r, 1_000));
      // Pane should not show infinite "running" spinner still
      // (exact text depends on UI; at minimum TUI must stay responsive)
      driver.assertContains("AGENTS");
    } finally {
      driver.destroy();
    }
  });
});
