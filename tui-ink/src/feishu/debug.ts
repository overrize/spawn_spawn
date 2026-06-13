// Feishu-specific debug logger.
// Writes to OS temp dir so it never pollutes TUI output or the project tree.
// Tail it with:  tail -f <path printed on startup>

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_PATH = path.join(os.tmpdir(), "feishu-debug.log");
let _printed = false;

export function feishuLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch { /* non-fatal */ }
  if (!_printed) {
    _printed = true;
    process.stderr.write(`[feishu-debug] logging to ${LOG_PATH}\n`);
  }
}
