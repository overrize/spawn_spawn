// registry.test.ts
// Covers: toolNeedsApproval, getToolsForRole, executeTool basics, deleteAgentMemory

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { executeTool, toolNeedsApproval, getToolsForRole } from "../tools/registry.js";
import {
  createMemory, saveMemory, deleteAgentMemory, appendMessage, loadMessages,
  memoryPath, messagesPath, ensureMemoryDir, MESSAGES_WINDOW,
} from "../memory/MemoryStore.js";

let tmpDir: string;
let origCwd: string;

before(() => {
  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-registry-"));
  process.chdir(tmpDir);
});

after(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── toolNeedsApproval ────────────────────────────────────────────────────────

describe("toolNeedsApproval — read-only tools", () => {
  it("Read / Write / Edit / Think → false", () => {
    assert.equal(toolNeedsApproval("Read"),  false);
    assert.equal(toolNeedsApproval("Write"), false);
    assert.equal(toolNeedsApproval("Edit"),  false);
    assert.equal(toolNeedsApproval("Think"), false);
  });

  it("unknown tool → true (safe default)", () => {
    assert.equal(toolNeedsApproval("NoSuchTool"), true);
  });
});

describe("toolNeedsApproval — Bash command classification", () => {
  it("read-only commands → false", () => {
    assert.equal(toolNeedsApproval("Bash", { command: "cat package.json" }), false);
    assert.equal(toolNeedsApproval("Bash", { command: "ls src/" }), false);
    assert.equal(toolNeedsApproval("Bash", { command: "node --version" }), false);
  });

  it("destructive commands → true", () => {
    assert.equal(toolNeedsApproval("Bash", { command: "rm -rf /tmp/x" }),     true);
    assert.equal(toolNeedsApproval("Bash", { command: "git commit -m msg" }), true);
    assert.equal(toolNeedsApproval("Bash", { command: "npm install lodash" }), true);
    assert.equal(toolNeedsApproval("Bash", { command: "echo x >> file.txt" }), true);
  });
});

// ── getToolsForRole ──────────────────────────────────────────────────────────

describe("getToolsForRole", () => {
  it("Leader and Worker receive the same tool set", () => {
    const leader = getToolsForRole("Leader").map(t => t.name).sort();
    const worker = getToolsForRole("Worker").map(t => t.name).sort();
    assert.deepEqual(leader, worker);
  });

  it("includes all core tools", () => {
    const names = getToolsForRole("Leader").map(t => t.name);
    for (const t of ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "LS", "Think"]) {
      assert.ok(names.includes(t), `Missing: ${t}`);
    }
  });
});

// ── executeTool — Read ───────────────────────────────────────────────────────

describe("executeTool — Read", () => {
  it("reads an existing file with line numbers", async () => {
    const f = path.join(tmpDir, "read-test.txt");
    fs.writeFileSync(f, "alpha\nbeta\ngamma");
    const r = await executeTool("Read", { path: f });
    assert.ok(r.ok);
    assert.ok(r.output.includes("alpha"));
    assert.ok(r.output.includes("1\t"));
  });

  it("returns ok:false for missing file", async () => {
    const r = await executeTool("Read", { path: path.join(tmpDir, "missing.txt") });
    assert.equal(r.ok, false);
  });
});

// ── executeTool — Write ──────────────────────────────────────────────────────

describe("executeTool — Write", () => {
  it("creates file with content", async () => {
    const f = path.join(tmpDir, "write-test.txt");
    const r = await executeTool("Write", { path: f, content: "hello world" });
    assert.ok(r.ok);
    assert.equal(fs.readFileSync(f, "utf8"), "hello world");
  });

  it("creates intermediate directories", async () => {
    const f = path.join(tmpDir, "deep", "dir", "file.txt");
    const r = await executeTool("Write", { path: f, content: "deep" });
    assert.ok(r.ok);
    assert.equal(fs.readFileSync(f, "utf8"), "deep");
  });
});

// ── executeTool — Edit ───────────────────────────────────────────────────────

describe("executeTool — Edit", () => {
  it("replaces a unique string", async () => {
    const f = path.join(tmpDir, "edit-test.txt");
    fs.writeFileSync(f, "foo BAR baz");
    const r = await executeTool("Edit", { path: f, old_string: "BAR", new_string: "QUX" });
    assert.ok(r.ok);
    assert.equal(fs.readFileSync(f, "utf8"), "foo QUX baz");
  });

  it("errors when old_string not found", async () => {
    const f = path.join(tmpDir, "edit-notfound.txt");
    fs.writeFileSync(f, "foo bar");
    const r = await executeTool("Edit", { path: f, old_string: "MISSING", new_string: "x" });
    assert.equal(r.ok, false);
    assert.ok(r.output.includes("not found"));
  });

  it("errors when old_string is ambiguous (multiple matches)", async () => {
    const f = path.join(tmpDir, "edit-dup.txt");
    fs.writeFileSync(f, "foo foo foo");
    const r = await executeTool("Edit", { path: f, old_string: "foo", new_string: "bar" });
    assert.equal(r.ok, false);
    assert.ok(r.output.includes("3 times"));
  });
});

// ── executeTool — Think ──────────────────────────────────────────────────────

describe("executeTool — Think", () => {
  it("always returns ok:true", async () => {
    const r = await executeTool("Think", { thought: "check the config before editing" });
    assert.ok(r.ok);
  });
});

// ── executeTool — Bash banned commands ──────────────────────────────────────

describe("executeTool — Bash banned commands", () => {
  for (const banned of ["curl", "wget", "ssh", "nc", "telnet"]) {
    it(`blocks ${banned}`, async () => {
      const r = await executeTool("Bash", { command: `${banned} example.com` });
      assert.equal(r.ok, false);
      assert.ok(r.output.toLowerCase().includes("banned"));
    });
  }
});

// ── executeTool — unknown tool ───────────────────────────────────────────────

describe("executeTool — unknown tool", () => {
  it("returns error listing available tools", async () => {
    const r = await executeTool("NoSuchTool", {});
    assert.equal(r.ok, false);
    assert.ok(r.output.includes("Unknown tool"));
    assert.ok(r.output.includes("Read"));
  });
});

// ── appendMessage — sliding window ──────────────────────────────────────────

describe("appendMessage — sliding window (depth=" + MESSAGES_WINDOW + ")", () => {
  it("keeps all messages while under the window", () => {
    for (let i = 0; i < MESSAGES_WINDOW; i++) {
      appendMessage("win-agent", { role: i % 2 === 0 ? "user" : "assistant", content: `msg-${i}`, ts: i });
    }
    const msgs = loadMessages("win-agent");
    assert.equal(msgs.length, MESSAGES_WINDOW);
    assert.equal(msgs[0].content, "msg-0");
  });

  it("evicts oldest when window is exceeded", () => {
    const extra = 3;
    for (let i = 0; i < MESSAGES_WINDOW + extra; i++) {
      appendMessage("win-evict", { role: "user", content: `msg-${i}`, ts: i });
    }
    const msgs = loadMessages("win-evict");
    assert.equal(msgs.length, MESSAGES_WINDOW, "file must not grow beyond window");
    assert.equal(msgs[0].content, `msg-${extra}`, "oldest evicted, newest retained");
    assert.equal(msgs[msgs.length - 1].content, `msg-${MESSAGES_WINDOW + extra - 1}`);
  });

  it("is idempotent on empty file", () => {
    appendMessage("win-empty", { role: "user", content: "first", ts: 0 });
    const msgs = loadMessages("win-empty");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, "first");
  });
});

// ── deleteAgentMemory ────────────────────────────────────────────────────────

describe("deleteAgentMemory — agent.done cleanup", () => {
  it("removes .json and .messages.jsonl after completion", () => {
    ensureMemoryDir();
    const mem = createMemory({
      agentId: "tl-cleanup-test",
      agentType: "LEADER",
      parentChain: ["pm"],
      depth: 1,
      model: "deepseek-v4-pro",
      roleName: "Leader",
    });
    saveMemory("tl-cleanup-test", mem);
    fs.appendFileSync(
      messagesPath("tl-cleanup-test"),
      JSON.stringify({ role: "assistant", content: "done", ts: Date.now() }) + "\n",
    );

    assert.ok(fs.existsSync(memoryPath("tl-cleanup-test")),     ".json must exist before cleanup");
    assert.ok(fs.existsSync(messagesPath("tl-cleanup-test")), ".jsonl must exist before cleanup");

    deleteAgentMemory("tl-cleanup-test");

    assert.equal(fs.existsSync(memoryPath("tl-cleanup-test")),     false, ".json should be deleted");
    assert.equal(fs.existsSync(messagesPath("tl-cleanup-test")), false, ".jsonl should be deleted");
  });

  it("is idempotent — no throw when files already gone", () => {
    assert.doesNotThrow(() => deleteAgentMemory("never-existed-agent"));
  });
});
