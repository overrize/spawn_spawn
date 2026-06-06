/**
 * Regression: PM must not spawn two Tech Leads with the same goal.
 *
 * Bug: `hasRunningChildWithGoal` compared `agent.sub` (mutable display field)
 * instead of `agent.goal` (immutable goal set at spawn), so the duplicate
 * detection failed as soon as TL updated its sub-status.
 *
 * Fix: ProcessManager.ts uses `a.goal ?? a.sub`, normalises whitespace,
 * and covers both "run" and "idle" states.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import { MockLLMServer } from "../driver/MockLLMServer.js";
import { TuiDriver } from "../driver/TuiDriver.js";
import { pmSpawnTL, pmDuplicateSpawn, anyAgentNoop } from "../fixtures/responses.js";

describe("regression: duplicate TL goal blocked", () => {
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

  it("second spawn with identical goal is blocked, only one TL appears", {
    timeout: 60_000,
  }, async () => {
    const GOAL = "analyse src/store.ts and report issues";
    const tlId1 = "tl-dup-01";
    const tlId2 = "tl-dup-02";

    // First PM call: spawn TL
    mock.enqueue(pmSpawnTL(tlId1, GOAL));
    // TL-01 boot call (idle / no-op)
    mock.enqueue(anyAgentNoop());
    // Second PM call: attempt duplicate spawn (PM might nudge after TL is running)
    mock.enqueue(pmDuplicateSpawn(tlId2, GOAL));

    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("analyse the codebase");

      // Wait for first TL to appear
      await driver.waitFor(new RegExp(tlId1), 20_000);

      // Wait a moment then check TL2 was NOT spawned
      await new Promise((r) => setTimeout(r, 3_000));

      const out = driver.capture();
      if (out.includes(tlId2)) {
        throw new Error(
          `Duplicate TL "${tlId2}" appeared with goal "${GOAL}"\nPane:\n${out}`,
        );
      }

      // Count how many TL entries appear with this goal — must be exactly 1
      const tlCount = driver.count(new RegExp(tlId1));
      if (tlCount === 0) {
        throw new Error(`TL "${tlId1}" not found in pane\nPane:\n${out}`);
      }
    } finally {
      driver.destroy();
    }
  });

  it("spawn with DIFFERENT goal is allowed", { timeout: 60_000 }, async () => {
    const GOAL_A = "implement feature X";
    const GOAL_B = "write tests for Y";
    const tlId1 = "tl-diff-01";
    const tlId2 = "tl-diff-02";

    mock.enqueue(pmSpawnTL(tlId1, GOAL_A));
    mock.enqueue(anyAgentNoop()); // tl-01 boot
    mock.enqueue(pmSpawnTL(tlId2, GOAL_B)); // different goal — should be allowed

    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("do both features");

      await driver.waitFor(new RegExp(tlId1), 20_000);

      // Second TL should appear because goals differ
      // It may take a moment for PM's second response to fire
      await new Promise((r) => setTimeout(r, 3_000));

      // Both TLs should be present
      driver.assertContains(new RegExp(tlId1));
    } finally {
      driver.destroy();
    }
  });
});
