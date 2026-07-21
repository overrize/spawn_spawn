/**
 * M3-7c · store → snapshot selector, then rendered aligned + filling.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { applyEvent, ensureAgent, selectAgent, getState, _resetForTest } from "../../store.js";
import { buildSnapshot } from "../../tui/snapshot.js";
import { renderFrame } from "../../tui/render.js";
import { displayWidth } from "../../tui/width.js";
import type { TuiEvent } from "../../protocol.js";

beforeEach(() => _resetForTest());

describe("M3-7c · buildSnapshot from live store", () => {
  it("projects agent tree (pre-order + last flag), chat, todos, status, approval", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run", depth: 0 });
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm", depth: 1 });
    ensureAgent({ id: "w-1", name: "w-1", role: "Worker", state: "done", parent: "tl-1", depth: 2 });
    applyEvent({ v: 1, type: "message", agent: "tl-1", to: "user", text: "开始拆分配置" } as TuiEvent);
    applyEvent({ v: 1, type: "todo.set", agent: "tl-1", items: [
      { id: "1", text: "查看配置", state: "done" }, { id: "2", text: "实现", state: "run" },
    ] } as TuiEvent);
    applyEvent({ v: 1, type: "tool.call", agent: "w-1", id: "b1", name: "Bash",
      args: { command: "rm -rf dist" }, needs_approval: true } as TuiEvent);
    selectAgent("tl-1");

    const s = buildSnapshot(getState(), { model: "kimi-k2", webOn: true });
    assert.deepEqual(s.agents.map((a) => a.id), ["pm", "tl-1", "w-1"]);
    assert.equal(s.agents.find((a) => a.id === "w-1")?.last, true);
    assert.equal(s.selectedId, "tl-1");
    assert.ok(s.statusLine.includes("pm running"));
    assert.equal(s.chat.some((m) => m.text.includes("开始拆分配置")), true);
    assert.equal(s.planCurrentIdx, 1);
    assert.equal(s.pendingApproval?.tool, "Bash");
  });

  it("rendered snapshot fills 96x30 exactly with live CJK data", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run", depth: 0, sub: "规划配置拆分" });
    ensureAgent({ id: "技术负责人-1", name: "技术负责人-1", role: "Leader", state: "run", parent: "pm", depth: 1 });
    applyEvent({ v: 1, type: "message", agent: "技术负责人-1", to: "user", text: "config.ts 里 model id 和 baseUrl 还耦合在角色配置里" } as TuiEvent);
    selectAgent("技术负责人-1");

    const s = buildSnapshot(getState(), { model: "kimi-k2" });
    for (const view of [{ mode: "home", planLevel: 0 }, { mode: "chat", planLevel: 0 }] as const) {
      const lines = renderFrame(s, view, 96, 30);
      assert.equal(lines.length, 30);
      lines.forEach((ln, i) => assert.equal(displayWidth(ln), 96, `${view.mode} line ${i}: ${JSON.stringify(ln)}`));
    }
  });

  it("empty store renders without crashing, fills", () => {
    const s = buildSnapshot(getState(), {});
    const lines = renderFrame(s, { mode: "home", planLevel: 0 }, 96, 30);
    assert.equal(lines.length, 30);
    lines.forEach((ln) => assert.equal(displayWidth(ln), 96));
  });
});
