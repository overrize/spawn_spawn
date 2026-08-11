/**
 * M1-6c · MemoryRuntime façade contract.
 * Asserts the guarantees in docs/spawn-1.0/M1-6c-SPEC.md §4.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  initSecretary,
  destroySecretary,
  buildResumeContext,
  SecretaryProxy,
  createMemory,
  loadMemory,
} from "../runtime/MemoryRuntime.js";
import * as sp from "../memory/SecretaryProxy.js";
import { saveMemory } from "../memory/MemoryStore.js";
import {
  getHealthMetricsStore,
  setHealthMetricsStoreForTests,
  HealthMetricsStore,
} from "../runtime/ObservabilityRuntime.js";

let origCwd: string;
let tmpDir: string;
before(() => { origCwd = process.cwd(); tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-6c-")); process.chdir(tmpDir); });
after(() => { process.chdir(origCwd); fs.rmSync(tmpDir, { recursive: true, force: true }); });
beforeEach(() => { try { fs.rmSync(path.join(".spawn", "memory"), { recursive: true, force: true }); } catch { /* fresh */ } });

function baseParams(id: string) {
  return {
    agentId: id,
    agentType: "WORKER" as const,
    parentChain: ["pm"],
    depth: 2,
    model: "m",
    roleName: "Worker",
    dispatch: { background: "g", constraints: [], acceptance_criteria: [], stop_conditions: [] },
  };
}

describe("M1-6c MemoryRuntime façade", () => {
  it("§4.1 initSecretary creates a new secretary and registers it", () => {
    const secretaries = new Map<string, SecretaryProxy>();
    let paramsCalled = 0;
    const sec = initSecretary(secretaries, "w1", undefined, () => { paramsCalled++; return baseParams("w1"); });
    assert.equal(paramsCalled, 1, "makeParams called for new memory");
    assert.ok(sec instanceof SecretaryProxy);
    assert.equal(secretaries.get("w1"), sec);
    assert.equal((sec as any).getMemory()?.agent_id ?? "w1", "w1");
  });

  it("§4.2 initSecretary resume path hits loadMemory and skips makeParams", () => {
    // Pre-persist a memory for w2
    const mem = createMemory(baseParams("w2"));
    saveMemory("w2", mem);
    const secretaries = new Map<string, SecretaryProxy>();
    let paramsCalled = 0;
    const sec = initSecretary(secretaries, "w2", "w2", () => { paramsCalled++; return baseParams("w2"); });
    assert.equal(paramsCalled, 0, "makeParams NOT called when resuming");
    assert.ok(sec instanceof SecretaryProxy);
    assert.equal(secretaries.get("w2"), sec);
  });

  it("§4.3 destroySecretary tears down and unregisters", () => {
    const secretaries = new Map<string, SecretaryProxy>();
    let destroyed = 0;
    const fake = { destroy: () => { destroyed++; } } as unknown as SecretaryProxy;
    secretaries.set("w3", fake);
    destroySecretary(secretaries, "w3");
    assert.equal(destroyed, 1);
    assert.equal(secretaries.has("w3"), false);
  });

  it("§4.4a buildResumeContext returns '' and records resume_context_missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-6c-metrics-"));
    setHealthMetricsStoreForTests(new HealthMetricsStore(dir));
    const out = buildResumeContext("nonexistent-id", "a1", "Worker", "goal");
    assert.equal(out, "");
    const metrics = getHealthMetricsStore().readMetrics();
    assert.ok(metrics.some((m) => m.event_type === "resume_context_missing"));
    setHealthMetricsStoreForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("§4.4b buildResumeContext injects facts / todo / pending block", () => {
    const mem = createMemory(baseParams("w4"));
    mem.working_set.facts = [{ text: "已确认事实A", weight: 3 } as any];
    mem.working_set.decisions = [{ text: "决定B" } as any];
    mem.tombstone.last_todo = JSON.stringify([{ state: "run", text: "写文件" }]);
    mem.tombstone.resume_hint = "被中断";
    mem.tombstone.pending_tool_calls = [{ name: "Write", id: "t9", needs_approval: false } as any];
    saveMemory("w4", mem);

    const out = buildResumeContext("w4", "w4", "Worker", "");
    assert.match(out, /## ⚠️ RESUMED CONTEXT/);
    assert.match(out, /已确认事实A/);
    assert.match(out, /\[run\] 写文件/);
    assert.match(out, /中断时未完成的操作/);
    assert.match(out, /Write.*\[id=t9\]/);
    assert.match(out, /第一句必须输出 todo\.set/);
  });

  it("§4.5 façade re-exports memory modules unwrapped", () => {
    assert.equal(SecretaryProxy, sp.SecretaryProxy);
    assert.equal(typeof loadMemory, "function");
    assert.equal(typeof createMemory, "function");
  });
});
