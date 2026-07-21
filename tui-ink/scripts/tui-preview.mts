// Preview the vertical single-main-view TUI (M3-7c). Fills the terminal.
// Usage: npx tsx scripts/tui-preview.mts [home|chat|logs] [plan:0|1|2] [approve]
import { renderFrame, type TuiSnapshot } from "../src/tui/render.js";
import type { ViewState, ViewMode, PlanLevel } from "../src/tui/viewState.js";

const args = process.argv.slice(2);
const mode = (args.find((a) => ["home", "chat", "logs"].includes(a)) ?? "home") as ViewMode;
const planLevel = Number(args.find((a) => a.startsWith("plan:"))?.split(":")[1] ?? 0) as PlanLevel;
const approve = args.includes("approve");
const cols = Math.min(96, process.stdout.columns ?? 96);
const rows = Math.min(30, process.stdout.rows ?? 30);

const snap: TuiSnapshot = {
  model: "claude-sonnet-4-5", webOn: false,
  agents: [
    { id: "pm", depth: 0, last: false, state: "run", sub: "" },
    { id: "tl-frontend", depth: 1, last: false, state: "run", sub: "" },
    { id: "worker-ui", depth: 2, last: false, state: "done", sub: "" },
    { id: "worker-tests", depth: 2, last: true, state: "run", sub: "" },
    { id: "tl-runtime", depth: 1, last: true, state: "waiting", sub: "" },
    { id: "worker-memory", depth: 2, last: true, state: "done", sub: "" },
  ],
  selectedId: mode === "home" ? "pm" : "pm",
  statusLine: "pm running · worker-tests running · 2 done",
  chat: [
    { from: "user", text: "修一下 TUI 卡住的问题" },
    { from: "pm", text: "我会先检查输入层和 tab focus 状态。" },
    { from: "tool", text: 'rg "useInput|focus" src', system: true },
    { from: "pm", text: "定位到 InputBar 在 pending approval 时会锁全局输入焦点，我抽出 focus 状态机来修。" },
  ],
  logs: [
    { time: "12:01:08", agent: "pm", kind: "spawn", summary: "tl-frontend" },
    { time: "12:01:11", agent: "tl-frontend", kind: "spawn", summary: "worker-ui" },
    { time: "12:01:33", agent: "worker-tests", kind: "tool.call", summary: "npm test" },
    { time: "12:01:41", agent: "worker-tests", kind: "metric", summary: "token.usage prompt=12.1k" },
  ],
  todos: [
    { state: "done", text: "读取 TUI 输入层代码" },
    { state: "run", text: "抽离 focus 状态机" },
    { state: "todo", text: "补 tab/esc 回归测试" },
  ],
  planCurrentIdx: 1,
  input: mode === "chat" ? "让 tl-runtime 也看下 memory" : "",
  scrollOffset: 0,
  pendingApproval: approve ? { agent: "worker-tests", tool: "Bash", detail: "rm -rf 构建产物 dist/" } : null,
};

const view: ViewState = { mode, planLevel };
console.log(`\n  ${mode} · plan=${planLevel}${approve ? " · approval" : ""} · ${cols}×${rows}\n`);
console.log(renderFrame(snap, view, cols, rows).join("\n"));
