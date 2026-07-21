/**
 * M3-7b-view · render alignment matrix.
 *
 * The whole point of the single-main-view redesign: no vertical dividers to
 * misalign. This test proves it — EVERY line of EVERY view has display width
 * exactly === cols, across English / CJK-heavy / mixed-overlong content.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { displayWidth } from "../../tui/width.js";
import { renderFrame, type TuiSnapshot } from "../../tui/render.js";
import { initialViewState, reduce, type ViewState } from "../../tui/viewState.js";

function baseSnapshot(overrides: Partial<TuiSnapshot> = {}): TuiSnapshot {
  return {
    goal: "refactor model/provider config",
    model: "kimi-k2",
    webOn: true,
    agents: [
      { id: "PM", depth: 0, state: "run", runtime: "02:14", sub: "planning config split" },
      { id: "TL-1", depth: 1, state: "run", runtime: "01:32", sub: "provider/runtime design" },
      { id: "W-2", depth: 2, state: "run", runtime: "00:59", sub: "update tests" },
    ],
    selectedId: "TL-1",
    running: ["PM", "TL-1", "W-2"],
    chat: [
      { from: "PM", text: "Split model catalog from role assignment config." },
      { from: "TL-1", text: "I found config.ts still couples model id and baseUrl." },
    ],
    logs: [
      { time: "12:01:08", agent: "PM", kind: "spawn", summary: "TL-1 provider/runtime design" },
    ],
    todos: [
      { state: "done", text: "inspect current config" },
      { state: "run", text: "implement provider catalog resolver" },
      { state: "todo", text: "run typecheck and tests" },
    ],
    planCurrentIdx: 1,
    input: "",
    pendingApproval: null,
    ...overrides,
  };
}

const CN = "把配置文件里的模型目录和角色分配彻底拆开，角色只引用模型键，避免 baseUrl 和 model 耦合在一起导致切换供应商时出错";

const VIEWS: ViewState[] = [
  { mode: "home", planLevel: 0 },
  { mode: "home", planLevel: 1 },
  { mode: "chat", planLevel: 0 },
  { mode: "chat", planLevel: 2 },
  { mode: "logs", planLevel: 0 },
];

function assertAllExact(lines: string[], cols: number, label: string) {
  lines.forEach((ln, i) => {
    assert.equal(displayWidth(ln), cols, `${label} line ${i} width ${displayWidth(ln)}≠${cols}: ${JSON.stringify(ln)}`);
  });
}

describe("M3-7b-view · every line is exactly cols wide (no divider misalignment)", () => {
  for (const cols of [88, 100]) {
    for (const view of VIEWS) {
      it(`${view.mode}/plan${view.planLevel} @${cols} — English`, () => {
        assertAllExact(renderFrame(baseSnapshot(), view, cols), cols, `${view.mode}`);
      });

      it(`${view.mode}/plan${view.planLevel} @${cols} — CJK-heavy + overlong`, () => {
        const snap = baseSnapshot({
          goal: CN,
          agents: [
            { id: "PM", depth: 0, state: "run", runtime: "02:14", sub: CN },
            { id: "技术负责人-1", depth: 1, state: "run", runtime: "01:32", sub: CN },
          ],
          chat: [{ from: "TL-1", text: CN }, { from: "系统", text: CN, system: true }],
          logs: [{ time: "12:01:08", agent: "工作", kind: "tool.call", summary: CN }],
          todos: [{ state: "run", text: CN }, { state: "todo", text: CN }],
          planCurrentIdx: 0,
          input: CN,
        });
        assertAllExact(renderFrame(snap, view, cols), cols, `${view.mode}-CN`);
      });
    }
  }

  it("approval overlay renders and stays aligned (CJK detail)", () => {
    const snap = baseSnapshot({ pendingApproval: { agent: "W-2", tool: "Bash", detail: "rm -rf 构建产物目录 dist/" } });
    assertAllExact(renderFrame(snap, { mode: "chat", planLevel: 0 }, 88), 88, "approval");
  });
});

describe("M3-7b-view · view state machine", () => {
  it("Ctrl+T cycles plan 0→1→2→0", () => {
    let v = initialViewState;
    v = reduce(v, "ctrl+t"); assert.equal(v.planLevel, 1);
    v = reduce(v, "ctrl+t"); assert.equal(v.planLevel, 2);
    v = reduce(v, "ctrl+t"); assert.equal(v.planLevel, 0);
  });

  it("Enter home→chat; Esc collapses plan then returns home", () => {
    let v: ViewState = { mode: "home", planLevel: 0 };
    v = reduce(v, "enter"); assert.equal(v.mode, "chat");
    v = reduce(v, "ctrl+t"); assert.equal(v.planLevel, 1);
    v = reduce(v, "esc"); assert.deepEqual(v, { mode: "chat", planLevel: 0 }); // plan collapses first
    v = reduce(v, "esc"); assert.equal(v.mode, "home");                        // then home
  });

  it("Ctrl+L toggles chat/logs; from home enters logs", () => {
    assert.equal(reduce({ mode: "home", planLevel: 0 }, "ctrl+l").mode, "logs");
    assert.equal(reduce({ mode: "logs", planLevel: 0 }, "ctrl+l").mode, "chat");
    assert.equal(reduce({ mode: "chat", planLevel: 0 }, "ctrl+l").mode, "logs");
  });

  it("selection keys don't change view state", () => {
    const v: ViewState = { mode: "chat", planLevel: 1 };
    for (const k of ["up", "down", "tab", "shift+tab"] as const) {
      assert.strictEqual(reduce(v, k), v);
    }
  });
});
