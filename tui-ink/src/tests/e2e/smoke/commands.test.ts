/**
 * Smoke tests: slash commands and keyboard shortcuts.
 * All tests use --demo mode.
 */

import { describe, it, before, after } from "node:test";
import { MockLLMServer } from "../driver/MockLLMServer.js";
import { TuiDriver } from "../driver/TuiDriver.js";

describe("smoke: slash commands (demo mode)", () => {
  let mock: MockLLMServer;
  let port: number;

  before(async () => {
    mock = new MockLLMServer();
    port = await mock.start();
  });

  after(async () => {
    await mock.stop();
  });

  it("/prune runs without crashing and pm is immune", { timeout: 30_000 }, async () => {
    const driver = new TuiDriver({ mockPort: port, demo: true });
    try {
      await driver.start();
      await driver.sendLine("/prune");
      // Wait briefly for the command to process
      await driver.waitFor(/pm/i, 3_000);
      // PM must always remain visible
      driver.assertContains(/pm/i);
    } finally {
      driver.destroy();
    }
  });

  it("/prune with agentId syntax is accepted", { timeout: 30_000 }, async () => {
    const driver = new TuiDriver({ mockPort: port, demo: true });
    try {
      await driver.start();
      // Even if agent doesn't exist, should not crash
      await driver.sendLine("/prune tl-nonexistent");
      driver.assertContains("AGENTS");
    } finally {
      driver.destroy();
    }
  });

  it("E key opens effort bar", { timeout: 30_000 }, async () => {
    const driver = new TuiDriver({ mockPort: port, demo: true });
    try {
      await driver.start();
      await driver.key("E");
      // Effort bar renders all 4 levels
      await driver.waitFor(/min|mid|high|max/, 5_000);
    } finally {
      driver.destroy();
    }
  });

  it("effort bar: arrow keys navigate levels", { timeout: 30_000 }, async () => {
    const driver = new TuiDriver({ mockPort: port, demo: true });
    try {
      await driver.start();
      await driver.key("E");
      await driver.waitFor(/min|mid|high|max/, 5_000);
      // Navigate right then left — should not crash
      await driver.key("Right");
      await driver.key("Left");
      driver.assertContains(/min|mid|high|max/);
    } finally {
      driver.destroy();
    }
  });

  it("effort bar: Enter confirms selection and bar closes", { timeout: 30_000 }, async () => {
    const driver = new TuiDriver({ mockPort: port, demo: true });
    try {
      await driver.start();
      await driver.key("E");
      await driver.waitFor(/min|mid|high|max/, 5_000);
      await driver.key("Right"); // move to "high" or next
      await driver.enter();
      // Effort bar should close; input bar back
      await driver.waitFor(/effort:/i, 5_000);
    } finally {
      driver.destroy();
    }
  });

  it("effort bar: Escape cancels without changing effort", { timeout: 30_000 }, async () => {
    const driver = new TuiDriver({ mockPort: port, demo: true });
    try {
      await driver.start();
      // Get initial effort level from status bar
      const before = driver.capture();
      await driver.key("E");
      await driver.waitFor(/min|mid|high|max/, 5_000);
      await driver.key("Escape");
      // Bar should be gone
      await driver.waitFor(/effort:/i, 5_000);
      // Effort level unchanged
      const after = driver.capture();
      // Extract effort:XXX from both captures
      const effortBefore = before.match(/effort:(\w+)/i)?.[1];
      const effortAfter  = after.match(/effort:(\w+)/i)?.[1];
      if (effortBefore && effortAfter) {
        if (effortBefore !== effortAfter) {
          throw new Error(`Effort changed after ESC: ${effortBefore} → ${effortAfter}`);
        }
      }
    } finally {
      driver.destroy();
    }
  });

  it("/effort command opens effort bar", { timeout: 30_000 }, async () => {
    const driver = new TuiDriver({ mockPort: port, demo: true });
    try {
      await driver.start();
      await driver.sendLine("/effort");
      await driver.waitFor(/min|mid|high|max/, 5_000);
    } finally {
      driver.destroy();
    }
  });

  it("/effort high sets effort directly", { timeout: 30_000 }, async () => {
    const driver = new TuiDriver({ mockPort: port, demo: true });
    try {
      await driver.start();
      await driver.sendLine("/effort high");
      await driver.waitFor(/effort.*high|high.*effort/i, 5_000);
    } finally {
      driver.destroy();
    }
  });

  it("[ and ] scroll conversation pane without crashing", { timeout: 30_000 }, async () => {
    const driver = new TuiDriver({ mockPort: port, demo: true });
    try {
      await driver.start();
      await driver.key("[");
      await driver.key("]");
      driver.assertContains("AGENTS");
    } finally {
      driver.destroy();
    }
  });
});
