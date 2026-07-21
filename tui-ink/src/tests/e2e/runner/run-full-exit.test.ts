import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

describe("run-full exit code", () => {
  it("exits 0 when all TestSuite phases pass", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", "src/tests/e2e/runner/run-full.ts"],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /全部通过/);
    assert.match(result.stdout, /总计: 65 通过 \/ 0 失败/);
  });
});
