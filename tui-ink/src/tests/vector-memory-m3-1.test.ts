/**
 * M3-1 · goal-relevance retrieval + cold archive (vector memory, n-gram degrade).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { retrieveByGoal, retrieveRelevant } from "../memory/retrieval.js";
import { archiveFacts, loadArchivedFacts } from "../memory/MemoryStore.js";
import type { MemoryFact } from "../memory/types.js";

let tmpDir: string, origCwd: string;
before(() => { origCwd = process.cwd(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "m3-1-")); process.chdir(tmpDir); });
after(() => { process.chdir(origCwd); fs.rmSync(tmpDir, { recursive: true, force: true }); });

let seq = 0;
const fact = (text: string, weight = 1): MemoryFact => ({ id: `f${++seq}`, text, src: "t", ts: Date.now(), weight });

describe("M3-1 retrieveByGoal", () => {
  it("surfaces the fact most relevant to the goal (CJK), not the newest", () => {
    const facts = [
      fact("飞书消息需要按 open_id 做会话隔离"),
      fact("配置文件在 src/config.ts，需要保留 baseUrl"),
      fact("worker 完成后必须 message 给 parent 再 agent.done"),
    ];
    const top = retrieveByGoal("修改 config.ts 的 baseUrl 解析", facts, 1);
    assert.equal(top.length, 1);
    assert.ok(top[0]!.text.includes("config.ts"), `got: ${top[0]?.text}`);
  });

  it("no goal → falls back to weight then recency", () => {
    const facts = [fact("a", 1), fact("b", 5), fact("c", 2)];
    assert.deepEqual(retrieveByGoal("", facts, 2).map((f) => f.text), ["b", "c"]);
  });

  it("k<=0 or empty pool → empty", () => {
    assert.deepEqual(retrieveByGoal("x", [fact("a")], 0), []);
    assert.deepEqual(retrieveByGoal("x", [], 3), []);
  });
});

describe("M3-1 cold archive", () => {
  beforeEach(() => { try { fs.rmSync(path.join(".spawn", "memory"), { recursive: true, force: true }); } catch {} });

  it("archived facts round-trip and skip corrupt lines", () => {
    archiveFacts("tl-1", [fact("归档事实 A"), fact("归档事实 B")]);
    fs.appendFileSync(path.join(".spawn", "memory", "tl-1.archive.jsonl"), "{bad json\n", "utf8");
    archiveFacts("tl-1", [fact("归档事实 C")]);
    const loaded = loadArchivedFacts("tl-1");
    assert.equal(loaded.length, 3);
    assert.equal(loaded.some((f) => f.text.includes("A")) && loaded.some((f) => f.text.includes("C")), true);
  });

  it("retrieveRelevant searches working set + archive, de-duped, by goal", () => {
    archiveFacts("tl-1", [fact("旧决定：数据库选 Postgres 因为需要 JSONB")]);
    const workingSet = [fact("当前 sprint 聚焦 TUI 渲染"), fact("Postgres 连接池上限设 20")];
    const top = retrieveRelevant("tl-1", workingSet, "Postgres 相关的历史决定", 2);
    assert.ok(top.some((f) => f.text.includes("Postgres")), "should surface Postgres facts from both pools");
  });
});
