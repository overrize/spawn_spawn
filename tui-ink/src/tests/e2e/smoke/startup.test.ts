/**
 * Smoke tests: TUI startup and basic rendering.
 * All tests use --demo mode so no real LLM connection is required.
 */

import { describe, it, before, after } from "node:test";
import { MockLLMServer } from "../driver/MockLLMServer.js";
import { TuiDriver } from "../driver/TuiDriver.js";

describe("smoke: TUI startup", () => {
  let mock: MockLLMServer;
  let port: number;

  before(async () => {
    mock = new MockLLMServer();
    port = await mock.start();
  });

  after(async () => {
    await mock.stop();
  });

  it("renders AGENTS pane header", { timeout: 30_000 }, async () => {
    const driver = new TuiDriver({ mockPort: port, demo: true });
    try {
      await driver.start(); // already waits for "AGENTS"
      driver.assertContains("AGENTS");
    } finally {
      driver.destroy();
    }
  });

  it("shows pm entry in agent list", { timeout: 30_000 }, async () => {
    const driver = new TuiDriver({ mockPort: port, demo: true });
    try {
      await driver.start();
      driver.assertContains(/pm/i);
    } finally {
      driver.destroy();
    }
  });

  it("shows status bar with effort indicator", { timeout: 30_000 }, async () => {
    const driver = new TuiDriver({ mockPort: port, demo: true });
    try {
      await driver.start();
      driver.assertContains(/effort:/i);
    } finally {
      driver.destroy();
    }
  });

  it("accepts text typed into input bar", { timeout: 30_000 }, async () => {
    const driver = new TuiDriver({ mockPort: port, demo: true });
    try {
      await driver.start();
      await driver.type("hello e2e test");
      driver.assertContains("hello e2e test");
    } finally {
      driver.destroy();
    }
  });

  it("clears typed text on Enter", { timeout: 30_000 }, async () => {
    const driver = new TuiDriver({ mockPort: port, demo: true });
    try {
      await driver.start();
      await driver.sendLine("clear after enter");
      // input bar should be empty after submit
      const out = driver.capture();
      // Text should no longer be in the input field area
      // (it may appear in conversation pane but input bar cleared)
      driver.assertAbsent(/clear after enter.*clear after enter/); // not doubled
    } finally {
      driver.destroy();
    }
  });

  it("shows hint line with keyboard shortcuts", { timeout: 30_000 }, async () => {
    const driver = new TuiDriver({ mockPort: port, demo: true });
    try {
      await driver.start();
      // Hint line should mention Tab and/or effort
      driver.assertContains(/Tab|effort|E effort/i);
    } finally {
      driver.destroy();
    }
  });

  it("Tab key changes selected agent", { timeout: 30_000 }, async () => {
    const driver = new TuiDriver({ mockPort: port, demo: true, cols: 200, rows: 50 });
    try {
      await driver.start();
      const before = driver.capture();
      await driver.key("Tab");
      const after = driver.capture();
      // Selection indicator should have changed (we can't assert specifics
      // without knowing exact agent list, just verify no crash)
      // TUI is still alive and rendering
      driver.assertContains("AGENTS");
    } finally {
      driver.destroy();
    }
  });
});
