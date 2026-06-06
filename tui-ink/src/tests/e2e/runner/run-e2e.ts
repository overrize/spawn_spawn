/**
 * CLI entry: runs the E2E suite (headless H1-H3 + HTTP E1-E3).
 * Usage: npm run test:e2e:full
 */

import { getState } from "../../../store.js";
import { E2ESuite } from "./E2ESuite.js";

const MONITOR = "e2e-monitor";

const suite = new E2ESuite();
suite.run().then(() => {
  const msgs = getState().messagesByAgent.get(MONITOR) ?? [];
  for (const m of msgs) process.stdout.write(m.text + "\n");

  const monitor = getState().agents.get(MONITOR);
  process.exit(monitor?.state === "done" ? 0 : 1);
}).catch((e) => {
  process.stderr.write(`E2ESuite fatal: ${e}\n`);
  process.exit(1);
});
