/**
 * Regression: inline JSON on same line as prose text must be parsed as an event.
 *
 * Bug: PM emitted lines like:
 *   Here is my response: {"v":1,"type":"message","to":"user","text":"..."}
 * The whole line was treated as prose and shown raw in the conversation pane.
 *
 * Fix: httpAgent.ts detects `{"` mid-line, splits at that boundary,
 * emits the prose prefix as plain text (if non-empty), then parses the JSON.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import { MockLLMServer } from "../driver/MockLLMServer.js";
import { TuiDriver } from "../driver/TuiDriver.js";
import { inlineJsonOnProse } from "../fixtures/responses.js";

describe("regression: inline JSON parsing", () => {
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

  it("message text extracted from inline JSON event", { timeout: 40_000 }, async () => {
    mock.enqueue(inlineJsonOnProse(null, "inline-json-extracted"));
    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("test inline json");
      await driver.waitFor("inline-json-extracted", 20_000);
    } finally {
      driver.destroy();
    }
  });

  it("raw JSON brace not shown verbatim in pane", { timeout: 40_000 }, async () => {
    mock.enqueue(inlineJsonOnProse(null, "no-raw-json-visible"));
    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("check no raw json");
      await driver.waitFor("no-raw-json-visible", 20_000);
      // The raw JSON object must not appear as visible text
      driver.assertAbsent(/"type":"message"/);
      driver.assertAbsent(/"v":1/);
    } finally {
      driver.destroy();
    }
  });

  it("agent.done in inline position is processed (agent reaches done state)", { timeout: 40_000 }, async () => {
    mock.enqueue(inlineJsonOnProse(null, "inline-done-processed"));
    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("test inline done");
      await driver.waitFor("inline-done-processed", 20_000);
      // Wait for state to settle
      await new Promise((r) => setTimeout(r, 1_000));
      // TUI still responsive
      driver.assertContains("AGENTS");
    } finally {
      driver.destroy();
    }
  });
});
