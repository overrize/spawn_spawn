import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentOSJournal, validateRoute, type AgentOSEnvelope } from "../../runtime/AgentOSJournal.js";

const pm = { id: "pm", role: "pm" as const };
const tl = { id: "tl-audit", role: "leader" as const };
const worker = { id: "worker-http", role: "worker" as const };
const user = { id: "rex", role: "user" as const };

function baseEnvelope(overrides: Partial<AgentOSEnvelope> = {}): AgentOSEnvelope {
  return {
    id: "cmd-test",
    trace_id: "trace-test",
    task_id: "task-test",
    from: pm,
    to: tl,
    cmd: "task.assign",
    seq: 1,
    priority: "normal",
    scope: "repo:tui-ink",
    visibility: "task",
    payload: { objective: "audit queue" },
    refs: [],
    created_at: 1,
    ...overrides,
  };
}

describe("AgentOSJournal routing", () => {
  it("allows PM to assign a task to a Leader", () => {
    const decision = validateRoute(baseEnvelope());
    assert.equal(decision.ok, true);
  });

  it("blocks Worker from sending directly to user", () => {
    const decision = validateRoute(baseEnvelope({
      from: worker,
      to: user,
      cmd: "task.result",
    }));

    assert.equal(decision.ok, false);
    assert.equal(decision.code, "worker_to_user_blocked");
  });

  it("blocks Worker from bypassing Leader to report to PM", () => {
    const decision = validateRoute(baseEnvelope({
      from: worker,
      to: pm,
      cmd: "finding.report",
    }));

    assert.equal(decision.ok, false);
    assert.equal(decision.code, "worker_to_pm_blocked");
  });

  it("allows Worker to report findings to its Leader", () => {
    const decision = validateRoute(baseEnvelope({
      from: worker,
      to: tl,
      cmd: "finding.report",
      payload: { claim: "queue has no TTL" },
    }));

    assert.equal(decision.ok, true);
  });
});

describe("AgentOSJournal persistence and wiki candidates", () => {
  it("appends envelopes and extracts secretary-maintained wiki candidates", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-os-journal-"));
    const journalPath = path.join(dir, "journal.json");
    const journal = new AgentOSJournal(journalPath);

    const assignment = journal.create({
      trace_id: "trace-1",
      task_id: "task-1",
      from: pm,
      to: tl,
      cmd: "task.assign",
      scope: "repo:tui-ink",
      payload: {
        objective: "审计 feishuBusy 释放逻辑",
        acceptance: ["列出风险点", "给出文件位置"],
      },
    });
    assert.equal(journal.append(assignment).ok, true);

    const finding = journal.create({
      trace_id: "trace-1",
      task_id: "task-1",
      parent_id: assignment.id,
      from: worker,
      to: tl,
      cmd: "finding.report",
      scope: "repo:tui-ink",
      refs: ["tui-ink/src/index.tsx:734"],
      payload: {
        claim: "feishuBusy release must be centralized",
        evidence: [{ path: "tui-ink/src/index.tsx", line: 734 }],
        confidence: "confirmed",
      },
    });
    assert.equal(journal.append(finding).ok, true);

    const reloaded = new AgentOSJournal(journalPath);
    assert.equal(reloaded.entries().length, 2);
    assert.equal(reloaded.wikiCandidates().length, 1);
    assert.equal(reloaded.wikiCandidates()[0]!.kind, "finding");
    assert.equal(reloaded.wikiCandidates()[0]!.title, "feishuBusy release must be centralized");
    assert.deepEqual(reloaded.wikiCandidates()[0]!.refs, ["tui-ink/src/index.tsx:734"]);
  });
});
