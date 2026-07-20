import { describe, it } from "node:test";
import { strict as assert } from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseTestCounts, detectTestCommand, executeTool } from "../tools/registry.js";

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



describe("parseTestCounts — deno", () => {
  const framework = "deno";

  it("parses ok | N passed | M failed pattern", () => {
    const output = "ok | 10 passed | 2 failed (200ms)\n";
    const r = parseTestCounts(output, framework);
    assert.equal(r.passed, 10);
    assert.equal(r.failed, 2);
  });

  it("all-pass case: no failures", () => {
    const output = "ok | 5 passed | 0 failed (50ms)\n";
    const r = parseTestCounts(output, framework);
    assert.equal(r.passed, 5);
    assert.equal(r.failed, 0);
  });

  it("falls back for empty/unmatched output", () => {
    const r = parseTestCounts("some random output", framework);
    assert.equal(r.passed, 0);
    assert.equal(r.failed, 0);
  });

  it("parses 'test result: ok. N passed; M failed' style", () => {
    const output = "test result: ok. 42 passed; 3 failed; 0 ignored\n";
    const r = parseTestCounts(output, framework);
    assert.equal(r.passed, 42);
    assert.equal(r.failed, 3);
  });
});

describe("parseTestCounts — bun", () => {
  const framework = "bun";

  it("parses pass and fail counts from bun test summary", () => {
    const output = " 5 pass\n 1 fail\n Ran 6 tests";
    const r = parseTestCounts(output, framework);
    assert.equal(r.passed, 5);
    assert.equal(r.failed, 1);
  });

  it("parses all-pass bun output", () => {
    const output = " 12 pass\n 0 fail\n Ran 12 tests";
    const r = parseTestCounts(output, framework);
    assert.equal(r.passed, 12);
    assert.equal(r.failed, 0);
  });

  it("parses skipped bun output when present", () => {
    const output = " 7 pass\n 0 fail\n 2 skip\n Ran 9 tests";
    const r = parseTestCounts(output, framework);
    assert.equal(r.passed, 7);
    assert.equal(r.failed, 0);
    assert.equal(r.skipped, 2);
  });

  it("parses zero tests bun output (no tests at all)", () => {
    const output = " 0 pass\n 0 fail\n Ran 0 tests";
    const r = parseTestCounts(output, "bun");
    assert.equal(r.passed, 0);
    assert.equal(r.failed, 0);
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

  it("detects Bun project via bun test script", () => {
    const dir = mkTmp();
    try {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ scripts: { test: "bun test" } }),
      );
      const result = detectTestCommand(dir);
      assert.ok(result, "should detect command");
      assert.equal(result!.framework, "bun");
      assert.equal(result!.cmd, "bun test");
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

  it("detects Bun project via bun.lock file", () => {
    const dir = mkTmp();
    try {
      fs.writeFileSync(path.join(dir, "bun.lock"), "# bun lockfile\n");
      const result = detectTestCommand(dir);
      assert.ok(result, "should detect command");
      assert.equal(result!.framework, "bun");
      assert.equal(result!.cmd, "bun test");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects Bun project via bun.lock file", () => {
    const dir = mkTmp();
    try {
      fs.writeFileSync(path.join(dir, "bun.lock"), "# bun lockfile\n");
      const result = detectTestCommand(dir);
      assert.ok(result, "should detect command");
      assert.equal(result!.framework, "bun");
      assert.equal(result!.cmd, "bun test");
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

// ── Edit tool — CRLF normalization ───────────────────────────────────────────

describe("Edit tool — CRLF normalization", () => {
  const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "spawn-edit-"));

  it("LF old_string matches CRLF file content", async () => {
    const dir = mkTmp();
    try {
      const file = path.join(dir, "test.ts");
      fs.writeFileSync(file, "const x = 1;\r\nconst y = 2;\r\n", "utf8");
      const r = await executeTool("Edit", {
        path: file,
        old_string: "const x = 1;\nconst y = 2;",
        new_string: "const x = 10;\nconst y = 20;",
      });
      assert.ok(r.ok, `Edit should succeed on CRLF file: ${r.output}`);
      const after = fs.readFileSync(file, "utf8");
      assert.ok(after.includes("const x = 10;"), "replacement content present");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Edit preserves CRLF line endings after replacement", async () => {
    const dir = mkTmp();
    try {
      const file = path.join(dir, "test.ts");
      fs.writeFileSync(file, "line1\r\nline2\r\nline3\r\n", "utf8");
      const r = await executeTool("Edit", {
        path: file,
        old_string: "line2",
        new_string: "replaced",
      });
      assert.ok(r.ok);
      const after = fs.readFileSync(file, "utf8");
      assert.equal(after, "line1\r\nreplaced\r\nline3\r\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Edit on LF file still works (no regression)", async () => {
    const dir = mkTmp();
    try {
      const file = path.join(dir, "test.ts");
      fs.writeFileSync(file, "line1\nline2\nline3\n", "utf8");
      const r = await executeTool("Edit", {
        path: file,
        old_string: "line2",
        new_string: "replaced",
      });
      assert.ok(r.ok);
      const after = fs.readFileSync(file, "utf8");
      assert.equal(after, "line1\nreplaced\nline3\n");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("multiline LF old_string matches CRLF file", async () => {
    const dir = mkTmp();
    try {
      const file = path.join(dir, "test.ts");
      fs.writeFileSync(
        file,
        "function foo() {\r\n  return 1;\r\n}\r\n",
        "utf8",
      );
      const r = await executeTool("Edit", {
        path: file,
        old_string: "function foo() {\n  return 1;\n}",
        new_string: "function foo() {\n  return 42;\n}",
      });
      assert.ok(r.ok, `multiline CRLF edit failed: ${r.output}`);
      const after = fs.readFileSync(file, "utf8");
      assert.ok(after.includes("return 42;"), "replacement applied");
      assert.ok(after.includes("\r\n"), "CRLF preserved");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
