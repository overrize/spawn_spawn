import { describe, it } from "node:test";
import { strict as assert } from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseTestCounts, detectTestCommand } from "../tools/registry.js";

// ── parseTestCounts ───────────────────────────────────────────────────────────

describe("parseTestCounts — node test runner", () => {
  const framework = "node";

  it("parses pass and fail counts from ℹ prefix lines", () => {
    const output = `
ℹ tests 10
ℹ suites 3
ℹ pass 8
ℹ fail 2
ℹ skipped 1
duration_ms 1234
`;
    const r = parseTestCounts(output, framework);
    assert.equal(r.passed, 8);
    assert.equal(r.failed, 2);
    assert.equal(r.skipped, 1);
  });

  it("returns zeros when no markers found", () => {
    const r = parseTestCounts("some other output", framework);
    assert.equal(r.passed, 0);
    assert.equal(r.failed, 0);
    assert.equal(r.skipped, 0);
  });

  it("falls back to mocha-style 'N passing' when ℹ markers absent", () => {
    const r = parseTestCounts("5 passing (100ms)\n1 failing", framework);
    assert.equal(r.passed, 5);
    assert.equal(r.failed, 1);
  });

  it("all-pass case: fail stays 0", () => {
    const r = parseTestCounts("ℹ pass 219\nℹ fail 0", framework);
    assert.equal(r.passed, 219);
    assert.equal(r.failed, 0);
  });
});

describe("parseTestCounts — pytest", () => {
  const framework = "pytest";

  it("parses N passed N failed", () => {
    const output = "3 failed, 17 passed in 2.1s";
    const r = parseTestCounts(output, framework);
    assert.equal(r.passed, 17);
    assert.equal(r.failed, 3);
  });

  it("all pass", () => {
    const r = parseTestCounts("10 passed in 0.5s", framework);
    assert.equal(r.passed, 10);
    assert.equal(r.failed, 0);
  });
});

describe("parseTestCounts — cargo", () => {
  const framework = "cargo";

  it("parses 'test result: ok. N passed; 0 failed'", () => {
    const output = "test result: ok. 42 passed; 0 failed; 0 ignored";
    const r = parseTestCounts(output, framework);
    assert.equal(r.passed, 42);
    assert.equal(r.failed, 0);
  });

  it("parses failures", () => {
    const output = "test result: FAILED. 38 passed; 4 failed; 0 ignored";
    const r = parseTestCounts(output, framework);
    assert.equal(r.passed, 38);
    assert.equal(r.failed, 4);
  });
});

describe("parseTestCounts — go", () => {
  const framework = "go";

  it("counts --- PASS and --- FAIL markers", () => {
    const output = "--- PASS: TestFoo (0.01s)\n--- PASS: TestBar (0.02s)\n--- FAIL: TestBaz (0.03s)";
    const r = parseTestCounts(output, framework);
    assert.equal(r.passed, 2);
    assert.equal(r.failed, 1);
  });

  it("treats bare 'ok  package' as at least 1 pass", () => {
    const r = parseTestCounts("ok  github.com/example/pkg  0.01s", framework);
    assert.equal(r.failed, 0);
    assert.ok(r.passed >= 1);
  });
});

// ── detectTestCommand ─────────────────────────────────────────────────────────

describe("detectTestCommand", () => {
  const mkTmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-test-"));
    return d;
  };

  it("detects Node.js project via package.json scripts.test", () => {
    const dir = mkTmp();
    try {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ scripts: { test: "node --test src/**/*.test.ts" } }),
      );
      const result = detectTestCommand(dir);
      assert.ok(result, "should detect command");
      assert.equal(result!.framework, "node");
      assert.match(result!.cmd, /npm/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for echo-only test script (placeholder)", () => {
    const dir = mkTmp();
    try {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }),
      );
      const result = detectTestCommand(dir);
      assert.equal(result, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects Python project via pytest.ini", () => {
    const dir = mkTmp();
    try {
      fs.writeFileSync(path.join(dir, "pytest.ini"), "[pytest]\n");
      const result = detectTestCommand(dir);
      assert.ok(result);
      assert.equal(result!.framework, "pytest");
      assert.match(result!.cmd, /pytest/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects Rust project via Cargo.toml", () => {
    const dir = mkTmp();
    try {
      fs.writeFileSync(path.join(dir, "Cargo.toml"), "[package]\nname = \"test\"\n");
      const result = detectTestCommand(dir);
      assert.ok(result);
      assert.equal(result!.framework, "cargo");
      assert.match(result!.cmd, /cargo/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects Go project via go.mod", () => {
    const dir = mkTmp();
    try {
      fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/test\ngo 1.21\n");
      const result = detectTestCommand(dir);
      assert.ok(result);
      assert.equal(result!.framework, "go");
      assert.match(result!.cmd, /go test/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no recognizable project file exists", () => {
    const dir = mkTmp();
    try {
      const result = detectTestCommand(dir);
      assert.equal(result, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
