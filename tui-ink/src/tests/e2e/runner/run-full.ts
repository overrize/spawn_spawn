/**
 * CLI entry: runs the 5-phase TestSuite in headless mode (no TUI process).
 * Prints results to stdout after the suite completes.
 *
 * Usage: npm run test:full
 */

import { getState } from "../../../store.js";
import { TestSuite } from "./TestSuite.js";

const MONITOR = "test-monitor";

const suite = new TestSuite();

suite.run().then(() => {
  // All applyEvent calls are synchronous — read final state now.
  const msgs = getState().messagesByAgent.get(MONITOR) ?? [];
  for (const m of msgs) {
    process.stdout.write(m.text + "\n");
  }

  const monitor = getState().agents.get(MONITOR);
  const ok = monitor?.state === "done";
  process.exit(ok ? 0 : 1);
}).catch((e) => {
  process.stderr.write(`TestSuite fatal: ${e}\n`);
  process.exit(1);
});
