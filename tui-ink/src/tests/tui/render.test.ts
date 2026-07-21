/**
 * M3-7c · render alignment matrix. Single vertical main view: EVERY line of
 * EVERY view is exactly `cols` wide AND the frame is exactly `rows` tall
 * (fills the terminal), across English / CJK-heavy content.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { displayWidth } from "../../tui/width.js";
import { renderFrame, type TuiSnapshot } from "../../tui/render.js";
import { initialViewState, reduce, type ViewState } from "../../tui/viewState.js";

function snap(overrides: Partial<TuiSnapshot> = {}): TuiSnapshot {
  return {
    model: "kimi-k2", webOn: true,
    agents: [
      { id: "pm", depth: 0, last: false, state: "run", sub: "" },
      { id: "tl-1", depth: 1, last: false, state: "run", sub: "" },
      { id: "w-2", depth: 2, last: true, state: "run", sub: "" },
    ],
    selectedId: "tl-1",
    statusLine: "pm running · w-2 running · 1 done",
    chat: [{ from: "pm", text: "Split model catalog from role config." }],
    logs: [{ time: "12:01", agent: "pm", kind: "spawn", summary: "tl-1" }],
    todos: [{ state: "done", text: "inspect" }, { state: "run", text: "implement" }],
    planCurrentIdx: 1, input: "", scrollOffset: 0, pendingApproval: null,
    ...overrides,
  };
}

const CN = "把配置文件里的模型目录和角色分配彻底拆开，角色只引用模型键，避免 baseUrl 和 model 耦合导致切换供应商出错";

const VIEWS: ViewState[] = [
  { mode: "home", planLevel: 0 },
  { mode: "chat", planLevel: 0 },
  { mode: "chat", planLevel: 2 },
  { mode: "logs", planLevel: 0 },
];

function check(lines: string[], cols: number, rows: number, label: string) {
  assert.equal(lines.length, rows, `${label}: ${lines.length} rows ≠ ${rows}`);
  lines.forEach((ln, i) => assert.equal(displayWidth(ln), cols, `${label} line ${i} w=${displayWidth(ln)}≠${cols}: ${JSON.stringify(ln)}`));
}

describe("M3-7c · fills terminal, every line exactly cols, no misalignment", () => {
  for (const [cols, rows] of [[96, 30], [120, 40]] as const) {
    for (const view of VIEWS) {
      it(`${view.mode}/plan${view.planLevel} @${cols}x${rows} — English`, () => {
        check(renderFrame(snap(), view, cols, rows), cols, rows, view.mode);
      });
      it(`${view.mode}/plan${view.planLevel} @${cols}x${rows} — CJK-heavy`, () => {
        const s = snap({
          agents: [{ id: "技术负责人-1", depth: 0, last: true, state: "waiting", sub: CN }],
          chat: [{ from: "技术负责人-1", text: CN }, { from: "系统", text: CN, system: true }],
          logs: [{ time: "12:01", agent: "工作", kind: "tool.call", summary: CN }],
          todos: [{ state: "run", text: CN }],
          statusLine: "技术负责人-1 running · 2 done",
          input: CN,
        });
        check(renderFrame(s, view, cols, rows), cols, rows, `${view.mode}-CN`);
      });
    }
  }

  it("approval drawer renders aligned, still fills", () => {
    const s = snap({ pendingApproval: { agent: "w-2", tool: "Bash", detail: "rm -rf 构建产物 dist/" } });
    check(renderFrame(s, { mode: "chat", planLevel: 0 }, 96, 30), 96, 30, "approval");
  });

  it("scroll window: offset shows older lines, still fills", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ from: "pm", text: `line ${i}` }));
    check(renderFrame(snap({ chat: many, scrollOffset: 10 }), { mode: "chat", planLevel: 0 }, 96, 24), 96, 24, "scroll");
  });
});

describe("M3-7c · view state machine", () => {
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
    v = reduce(v, "esc"); assert.deepEqual(v, { mode: "chat", planLevel: 0 });
    v = reduce(v, "esc"); assert.equal(v.mode, "home");
  });
  it("Ctrl+L toggles chat/logs; home→logs", () => {
    assert.equal(reduce({ mode: "home", planLevel: 0 }, "ctrl+l").mode, "logs");
    assert.equal(reduce({ mode: "logs", planLevel: 0 }, "ctrl+l").mode, "chat");
  });
});
