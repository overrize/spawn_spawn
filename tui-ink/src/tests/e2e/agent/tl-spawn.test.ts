/**
 * Agent tests: PM → TL → Worker pipeline.
 *
 * Verifies the spawn chain is correctly processed and rendered in the AGENTS pane.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import { MockLLMServer } from "../driver/MockLLMServer.js";
import { TuiDriver } from "../driver/TuiDriver.js";
import {
  pmSpawnTL,
  tlSpawnWorker,
  workerDone,
  anyAgentNoop,
} from "../fixtures/responses.js";

describe("agent: TL spawn pipeline", () => {
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

  it("PM spawns TL and TL appears in AGENTS pane", { timeout: 60_000 }, async () => {
    const tlId = "tl-spawn-test-01";
    mock.enqueue(pmSpawnTL(tlId, "analyse the architecture"));
    mock.enqueue(anyAgentNoop()); // TL boot call

    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("analyse the architecture");
      await driver.waitFor(new RegExp(tlId), 25_000);
      driver.assertContains(/pm/i);
      driver.assertContains(new RegExp(tlId));
    } finally {
      driver.destroy();
    }
  });

  it("TL spawns Worker and Worker appears in AGENTS pane", { timeout: 80_000 }, async () => {
    const tlId    = "tl-chain-01";
    const workerId = "worker-chain-01";
    const goal    = "read README and summarise";

    mock.enqueue(pmSpawnTL(tlId, goal));
    mock.enqueue(tlSpawnWorker(tlId, workerId, goal));
    mock.enqueue(workerDone(workerId, "summary complete"));
    mock.enqueue(anyAgentNoop()); // TL post-worker call

    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("summarise the README");

      // Wait for TL
      await driver.waitFor(new RegExp(tlId), 25_000);
      // Wait for Worker
      await driver.waitFor(new RegExp(workerId), 30_000);

      driver.assertContains(new RegExp(tlId));
      driver.assertContains(new RegExp(workerId));
    } finally {
      driver.destroy();
    }
  });

  it("hierarchy depth: Worker is child of TL is child of PM", { timeout: 80_000 }, async () => {
    const tlId    = "tl-depth-01";
    const workerId = "worker-depth-01";
    const goal    = "depth hierarchy test";

    mock.enqueue(pmSpawnTL(tlId, goal));
    mock.enqueue(tlSpawnWorker(tlId, workerId, goal));
    mock.enqueue(anyAgentNoop()); // worker boot

    const driver = new TuiDriver({ mockPort: port });
    try {
      await driver.start();
      await driver.sendLine("test depth");

      await driver.waitFor(new RegExp(workerId), 40_000);

      const out = driver.capture();
      const tlPos     = out.indexOf(tlId);
      const workerPos = out.indexOf(workerId);
      const pmPos     = out.toLowerCase().indexOf("pm");

      // In a depth-sorted list: pm → tl → worker (top to bottom)
      if (tlPos < 0 || workerPos < 0 || pmPos < 0) {
        throw new Error(`Not all agents visible: pm=${pmPos} tl=${tlPos} worker=${workerPos}\nPane:\n${out}`);
      }
      if (tlPos > workerPos) {
        throw new Error(`TL (${tlPos}) should appear above Worker (${workerPos})\nPane:\n${out}`);
      }
    } finally {
      driver.destroy();
    }
  });
});
