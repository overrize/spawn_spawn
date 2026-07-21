/**
 * M3-7b-view · store → snapshot selector, then rendered aligned.
 * Drives the REAL store (applyEvent) → buildSnapshot → renderFrame, proving
 * the new TUI reads live store state and stays perfectly aligned.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { applyEvent, ensureAgent, selectAgent, getState, _resetForTest } from "../../store.js";
import { buildSnapshot } from "../../tui/snapshot.js";
import { renderFrame } from "../../tui/render.js";
import { displayWidth } from "../../tui/width.js";
import type { TuiEvent } from "../../protocol.js";

beforeEach(() => _resetForTest());

describe("M3-7b-view · buildSnapshot from live store", () => {
  it("projects agent tree, chat, todos, approval from store", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run", goal: "重构配置", depth: 0 });
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm", depth: 1, sub: "供应商设计" });
    ensureAgent({ id: "w-1", name: "w-1", role: "Worker", state: "done", parent: "tl-1", depth: 2 });
    applyEvent({ v: 1, type: "message", agent: "tl-1", to: "user", text: "开始拆分配置" } as TuiEvent);
    applyEvent({ v: 1, type: "todo.set", agent: "tl-1", items: [
      { id: "1", text: "查看配置", state: "done" }, { id: "2", text: "实现 resolver", state: "run" },
    ] } as TuiEvent);
    applyEvent({ v: 1, type: "tool.call", agent: "w-1", id: "b1", name: "Bash",
      args: { command: "rm -rf dist" }, needs_approval: true } as TuiEvent);
    selectAgent("tl-1");

    const snap = buildSnapshot(getState(), { model: "kimi-k2", webOn: true });

    assert.deepEqual(snap.agents.map((a) => a.id), ["pm", "tl-1", "w-1"]);   // pre-order tree
    assert.equal(snap.agents.find((a) => a.id === "w-1")?.depth, 2);
    assert.equal(snap.selectedId, "tl-1");
    assert.equal(snap.running.includes("pm") && snap.running.includes("tl-1"), true);
    assert.equal(snap.chat.some((m) => m.text.includes("开始拆分配置")), true);
    assert.equal(snap.todos.length, 2);
    assert.equal(snap.planCurrentIdx, 1);           // the "run" todo
    assert.equal(snap.pendingApproval?.tool, "Bash");
    assert.equal(snap.goal, "重构配置");
  });

  it("rendered snapshot stays exactly cols wide (live CJK data)", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run", goal: "重构模型与供应商配置：彻底解耦模型目录与角色分配", depth: 0 });
    ensureAgent({ id: "技术负责人-1", name: "技术负责人-1", role: "Leader", state: "run", parent: "pm", depth: 1, sub: "供应商/运行时设计，补充缺失 modelRef 的测试" });
    applyEvent({ v: 1, type: "message", agent: "技术负责人-1", to: "user", text: "config.ts 里 model id 和 baseUrl 还耦合在角色配置里，我加一个 provider catalog resolver" } as TuiEvent);
    selectAgent("技术负责人-1");

    const snap = buildSnapshot(getState(), { model: "kimi-k2", webOn: true });
    for (const view of [{ mode: "home", planLevel: 0 }, { mode: "chat", planLevel: 1 }] as const) {
      const lines = renderFrame(snap, view, 88);
      lines.forEach((ln, i) => assert.equal(displayWidth(ln), 88, `${view.mode} line ${i}: ${JSON.stringify(ln)}`));
    }
  });

  it("empty store renders without crashing, still aligned", () => {
    const snap = buildSnapshot(getState(), {});
    const lines = renderFrame(snap, { mode: "home", planLevel: 0 }, 88);
    lines.forEach((ln) => assert.equal(displayWidth(ln), 88));
  });
});
