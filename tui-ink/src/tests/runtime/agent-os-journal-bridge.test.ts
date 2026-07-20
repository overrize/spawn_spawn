import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentOSJournalBridge, eventToEnvelopes } from "../../runtime/AgentOSJournalBridge.js";
import type { AgentInfo } from "../../protocol.js";

const agents = new Map<string, AgentInfo>([
  ["pm", { id: "pm", name: "PM", role: "Leader", state: "idle" }],
  ["tl-audit", { id: "tl-audit", name: "TL", role: "Leader", parent: "pm", state: "idle" }],
  ["worker-http", { id: "worker-http", name: "Worker", role: "Worker", parent: "tl-audit", state: "idle" }],
]);

const context = {
  getAgent: (agentId: string) => agents.get(agentId),
  now: () => 1000,
};

describe("AgentOSJournalBridge event mapping", () => {
  it("maps spawn events to agent.spawn envelopes", () => {
    const envs = eventToEnvelopes({
      v: 1,
      type: "spawn",
      parent: "pm",
      child: "tl-audit",
      role: "Leader",
      goal: "审计队列",
    }, context);

    assert.equal(envs.length, 1);
    assert.equal(envs[0]!.cmd, "agent.spawn");
    assert.equal(envs[0]!.from.role, "pm");
    assert.equal(envs[0]!.to.role, "leader");
  });

  it("maps unit.handup to task.result through the parent", () => {
    const envs = eventToEnvelopes({
      v: 1,
      type: "unit.handup",
      agent: "worker-http",
      parent: "tl-audit",
      summary: "发现 send 队列风险",
      artifacts: ["reports/http-agent.md"],
      facts_to_promote: ["queue lacks TTL"],
      decisions: [],
      failed_acceptance: [],
    }, context);

    assert.equal(envs.length, 1);
    assert.equal(envs[0]!.cmd, "task.result");
    assert.equal(envs[0]!.from.role, "worker");
    assert.equal(envs[0]!.to.role, "leader");
    assert.deepEqual(envs[0]!.refs, ["reports/http-agent.md"]);
  });
});

describe("AgentOSJournalBridge persistence", () => {
  it("appends observed events without changing the main runtime path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-os-bridge-"));
    const journalPath = path.join(dir, "journal.json");
    const bridge = new AgentOSJournalBridge({ journalPath });

    bridge.observe({
      v: 1,
      type: "agent.error",
      agent: "worker-http",
      code: "nudge-exhausted",
      detail: "worker stalled",
    }, context);

    assert.equal(bridge.entries().length, 1);
    const raw = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    assert.equal(raw.entries[0].cmd, "exception.report");
    assert.equal(raw.wiki_candidates[0].kind, "exception");
    assert.equal(raw.wiki_candidates[0].title, "nudge-exhausted");
  });
});
