/**
 * M3-6 · security matrix — the guarantees documented in docs/spawn-1.0/SECURITY_MODEL.md.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeTool, toolNeedsApproval } from "../tools/registry.js";

describe("M3-6 security matrix", () => {
  it("banned network commands are rejected (no exfiltration path)", async () => {
    for (const cmd of ["curl http://evil", "wget http://x", "ssh host", "nc -l 1234"]) {
      const r = await executeTool("Bash", { command: cmd });
      assert.equal(r.ok, false, cmd);
      assert.match(r.output, /Banned command/, cmd);
    }
  });

  it("destructive Bash requires approval; read-only auto-allows", () => {
    for (const cmd of ["rm -rf dist", "git reset --hard", "npm install evil", "echo x > out.txt", "chmod 777 f"]) {
      assert.equal(toolNeedsApproval("Bash", { command: cmd }), true, cmd);
    }
    for (const cmd of ["ls -la", "cat file.txt", "git status", "grep foo src"]) {
      assert.equal(toolNeedsApproval("Bash", { command: cmd }), false, cmd);
    }
  });

  it("writes outside the workspace boundary are rejected", async () => {
    const outside = "../".repeat(30) + "spawn-outside-test.txt";
    const r = await executeTool("Write", { path: outside, content: "x" });
    assert.equal(r.ok, false);
    assert.match(r.output, /outside_workspace|rejected|Path/i);
  });

  it("unknown tools default to requiring approval", () => {
    assert.equal(toolNeedsApproval("NoSuchTool"), true);
  });
});
