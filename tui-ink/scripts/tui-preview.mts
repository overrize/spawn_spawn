// Preview the new single-main-view TUI with mock data (M3-7b-view).
// Usage: npx tsx scripts/tui-preview.mts [home|chat|logs] [plan:0|1|2] [cn]
import { renderFrame, type TuiSnapshot } from "../src/tui/render.js";
import type { ViewState, ViewMode, PlanLevel } from "../src/tui/viewState.js";

const args = process.argv.slice(2);
const mode = (args.find((a) => ["home", "chat", "logs"].includes(a)) ?? "home") as ViewMode;
const planLevel = (Number(args.find((a) => a.startsWith("plan:"))?.split(":")[1] ?? 0)) as PlanLevel;
const cn = args.includes("cn");
const cols = 88;

const EN: TuiSnapshot = {
  goal: "refactor model/provider config",
  model: "kimi-k2", webOn: true,
  agents: [
    { id: "PM", depth: 0, state: "run", runtime: "02:14", sub: "planning config split" },
    { id: "TL-1", depth: 1, state: "run", runtime: "01:32", sub: "provider/runtime design" },
    { id: "W-1", depth: 2, state: "done", runtime: "00:48", sub: "inspect config.ts" },
    { id: "W-2", depth: 2, state: "run", runtime: "00:59", sub: "update tests" },
    { id: "QA", depth: 1, state: "idle", runtime: "--:--", sub: "waiting for regression" },
  ],
  selectedId: "TL-1",
  running: ["PM", "TL-1", "W-2"],
  chat: [
    { from: "PM", text: "Split model catalog from role assignment config. Roles reference model keys." },
    { from: "TL-1", text: "config.ts still couples model id and baseUrl inside role config. Adding a provider catalog resolver." },
    { from: "W-2", text: "Adding tests for missing modelRef and provider lookup fallback." },
  ],
  logs: [
    { time: "12:01:08", agent: "PM", kind: "spawn", summary: "TL-1 provider/runtime design" },
    { time: "12:01:11", agent: "TL-1", kind: "spawn", summary: "W-1 inspect config.ts" },
    { time: "12:01:33", agent: "W-2", kind: "tool.call", summary: "Read src/config.ts" },
    { time: "12:01:41", agent: "W-2", kind: "metric", summary: "token.usage prompt=12.1k completion=880" },
  ],
  todos: [
    { state: "done", text: "inspect current config" },
    { state: "done", text: "identify model/baseUrl coupling" },
    { state: "run", text: "implement provider catalog resolver" },
    { state: "todo", text: "update config.example.json" },
    { state: "todo", text: "run typecheck and tests" },
  ],
  planCurrentIdx: 2,
  input: mode === "chat" ? "ask TL-1 to check web search config too" : "",
  pendingApproval: null,
};

const CNSNAP: TuiSnapshot = {
  ...EN,
  goal: "重构模型与供应商配置：模型目录和角色分配彻底解耦",
  agents: [
    { id: "PM", depth: 0, state: "run", runtime: "02:14", sub: "规划配置拆分方案" },
    { id: "技术负责人-1", depth: 1, state: "run", runtime: "01:32", sub: "供应商/运行时设计" },
    { id: "工作节点-2", depth: 2, state: "run", runtime: "00:59", sub: "补充缺失 modelRef 的测试用例" },
  ],
  selectedId: "技术负责人-1",
  running: ["PM", "技术负责人-1", "工作节点-2"],
  chat: [
    { from: "PM", text: "把模型目录从角色分配配置里拆出来，角色只引用模型键。" },
    { from: "技术负责人-1", text: "config.ts 里 model id 和 baseUrl 还耦合在角色配置里，我加一个 provider catalog resolver，角色配置只留 model 引用。" },
  ],
  todos: [
    { state: "done", text: "查看当前配置" },
    { state: "run", text: "实现 provider catalog resolver 并保留 baseUrl 解析" },
    { state: "todo", text: "跑 typecheck 和测试" },
  ],
  planCurrentIdx: 1,
  input: mode === "chat" ? "让 技术负责人-1 顺便检查 web 搜索配置" : "",
};

const view: ViewState = { mode, planLevel };
const snap = cn ? CNSNAP : EN;
console.log(`\n  view=${mode} plan=${planLevel} ${cn ? "CN" : "EN"} cols=${cols}\n`);
console.log(renderFrame(snap, view, cols).join("\n"));
console.log("");
