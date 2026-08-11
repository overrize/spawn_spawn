/**
 * DevHarness — CLI-only demo + in-TUI test-runner entry points (spawn-1.0 M1-6e).
 * Extracted verbatim from the god-file: not part of the live agent/render hot path
 * (runDemo fires on `--demo`, runTestSuite on `/test`). Kept behaviour-identical.
 */

import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { TuiEvent } from "../protocol.js";
import type { HttpConvAgent } from "../adapters/httpAgent.js";
import { applyEvent, selectAgent } from "../store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function runDemo(initialPrompt: string, deps: { agents: Map<string, HttpConvAgent>; MODEL: string }): void {
  const { agents, MODEL } = deps;
  void initialPrompt;
  const id = "pm";
  const ev = (e: Partial<TuiEvent> & { type: TuiEvent["type"] }) =>
    applyEvent({ v: 1, agent: id, ...(e as any) });

  // 注册一个假 agent，让后续消息不被静默丢弃
  agents.set(id, {
    sendCommand(cmd: { type: string; text?: string }) {
      if (cmd.type === "user.message") {
        applyEvent({
          v: 1, type: "message", agent: id, to: "user",
          text: "[DEMO] 这是演示模式，消息不会发送到真实 API。运行 'npm run dev'（不带 --demo）并配置 API key 来使用真实 agent。",
        } as TuiEvent);
      }
    },
  } as any);

  // 完整演示序列: Leader spawn → Worker 执行 → agent.done → Leader 汇总
  // Phase 1: Leader 初始化
  setTimeout(() => ev({
    type: "todo.set",
    items: [
      { id: "l1", state: "run",  text: "spawn worker-1 读配置文件" },
      { id: "l2", state: "todo", text: "spawn worker-2 改配置" },
      { id: "l3", state: "todo", text: "汇总结果" },
    ],
  } as any), 200);
  setTimeout(() => ev({ type: "step", text: "启动两个 worker" } as any), 400);

  // spawn tech-lead (PM → TL → workers pattern)
  setTimeout(() => ev({
    type: "spawn", parent: "pm", child: "tl-demo",
    role: "Leader", goal: "管理配置文件读取和修改任务", model: MODEL,
  } as any), 600);

  // TL spawns workers
  setTimeout(() => applyEvent({
    v: 1, type: "spawn", agent: "tl-demo", parent: "tl-demo", child: "worker-1",
    role: "Worker", goal: "读取 src/config.json 并报告配置含义", model: MODEL,
  } as any), 900);

  setTimeout(() => applyEvent({
    v: 1, type: "spawn", agent: "tl-demo", parent: "tl-demo", child: "worker-2",
    role: "Worker", goal: "修改 src/config.json 中 mode 字段为 production", model: MODEL,
  } as any), 1100);

  // Phase 2: worker-1 执行
  setTimeout(() => applyEvent({
    v: 1, type: "todo.set", agent: "worker-1",
    items: [
      { id: "w1a", state: "run",  text: "读取 config.json" },
      { id: "w1b", state: "todo", text: "分析并报告" },
    ],
  } as any), 1200);
  setTimeout(() => applyEvent({
    v: 1, type: "step", agent: "worker-1", text: "读取配置文件"
  } as any), 1400);
  setTimeout(() => applyEvent({
    v: 1, type: "tool.call", agent: "worker-1", id: "tc-w1", name: "Read",
    args: { path: "src/config.json" }, needs_approval: false,
  } as any), 1600);
  setTimeout(() => applyEvent({
    v: 1, type: "tool.result", agent: "worker-1", id: "tc-w1",
    ok: true, output: '{"mode":"development","port":3000,"debug":true}'
  } as any), 2200);
  setTimeout(() => applyEvent({
    v: 1, type: "agent.done", agent: "worker-1", success: true,
    reason: "成功读取配置：mode=development, port=3000, debug=true",
  } as any), 2500);

  // Phase 3: worker-2 执行
  setTimeout(() => applyEvent({
    v: 1, type: "todo.set", agent: "worker-2",
    items: [
      { id: "w2a", state: "run",  text: "修改 mode 为 production" },
    ],
  } as any), 2800);
  setTimeout(() => applyEvent({
    v: 1, type: "step", agent: "worker-2", text: "编辑 config.json"
  } as any), 3000);
  setTimeout(() => applyEvent({
    v: 1, type: "tool.call", agent: "worker-2", id: "tc-w2", name: "Edit",
    args: { path: "src/config.json", old_string: '"mode":"development"', new_string: '"mode":"production"' },
    needs_approval: true,
  } as any), 3200);
  setTimeout(() => applyEvent({
    v: 1, type: "tool.result", agent: "worker-2", id: "tc-w2",
    ok: true, output: "替换成功"
  } as any), 3800);
  setTimeout(() => applyEvent({
    v: 1, type: "agent.done", agent: "worker-2", success: true,
    reason: "成功将 mode 从 development 改为 production",
  } as any), 4100);

  // Phase 4: Leader 汇总
  setTimeout(() => ev({
    type: "todo.set",
    items: [
      { id: "l1", state: "done", text: "spawn worker-1 读配置文件" },
      { id: "l2", state: "done", text: "spawn worker-2 改配置" },
      { id: "l3", state: "run",  text: "汇总结果", progress: 50 },
    ],
  } as any), 4400);
  setTimeout(() => ev({ type: "step", text: "汇总两个 worker 结果" } as any), 4600);
  setTimeout(() => ev({
    type: "message", agent: "pm", to: "user",
    text: `✅ 并行任务完成\n` +
      `- worker-1: 读取 src/config.json 成功（mode=development, port=3000, debug=true）\n` +
      `- worker-2: 已将 mode 修改为 production\n` +
      `\n配置已从开发模式切换为生产模式，端口 3000 不变，debug 标记仍为 true（可自行关闭）。`,
  } as any), 4800);
  setTimeout(() => ev({
    type: "agent.done", success: true,
    reason: "完整演示了 Leader→spawn→Worker→tool→agent.done→汇总 流程",
  } as any), 5100);
}

// ── In-TUI test runner ──────────────────────────────────────────────────────
const HEADLESS_SUITES: Record<string, string[]> = {
  headless: [
    "src/tests/e2e/headless/store-events.test.ts",
    "src/tests/e2e/headless/protocol-parsing.test.ts",
    "src/tests/e2e/headless/pm-rules.test.ts",
  ],
  unit: [
    "src/tests/smoke.test.ts",
    "src/tests/integration.test.ts",
    "src/tests/pm-hierarchy.test.ts",
    "src/tests/registry.test.ts",
    "src/tests/registry-enoent.test.ts",
    "src/tests/cache-prefix.test.ts",
  ],
};

export function runTestSuite(suite: string): void {
  const TUI_ROOT = path.resolve(__dirname, "..");
  const files = HEADLESS_SUITES[suite];
  if (!files) {
    const suites = Object.keys(HEADLESS_SUITES).join(" | ");
    applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
      text: `未知测试套件 "${suite}"。可用: ${suites}` });
    return;
  }
  const absPaths = files.map((f) => path.join(TUI_ROOT, f));

  // Switch to PM so the user sees the output
  selectAgent("pm");
  applyEvent({ v: 1, type: "agent.state", agent: "pm", state: "run", sub: `🧪 ${suite} (0 passed)` } as any);
  applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
    text: `🧪 /test ${suite} — ${files.length} 文件，启动中…` });

  const proc = nodeSpawn(
    "node",
    ["--import", "tsx/esm", "--test", ...absPaths],
    { cwd: TUI_ROOT, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } },
  );

  let passCount = 0;
  let failCount = 0;
  let lineBuf = "";
  // Accumulate failure context (the lines immediately after "not ok")
  let failContext: string[] = [];
  let capturingFail = false;

  const updateSub = () =>
    applyEvent({ v: 1, type: "agent.state", agent: "pm", state: "run",
      sub: `🧪 ${suite}: ${passCount} passed${failCount ? `, ${failCount} FAILED` : ""}` } as any);

  const handleLine = (line: string) => {
    const s = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!s) return;

    if (/^ok \d+/.test(s)) {
      passCount++;
      updateSub();
      capturingFail = false;
      failContext = [];
      return;
    }
    if (/^not ok \d+/.test(s)) {
      failCount++;
      updateSub();
      capturingFail = true;
      failContext = [s];
      return;
    }
    // YAML block under a failure — collect up to 6 lines then flush
    if (capturingFail) {
      // Stop at blank line or next TAP line
      if (!s || /^(ok|not ok|#|\d+\.\.)/.test(s)) {
        if (failContext.length) {
          applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
            text: failContext.join("\n") });
          failContext = [];
        }
        capturingFail = false;
      } else if (failContext.length < 8) {
        failContext.push(s);
      }
    }
  };

  proc.stdout.on("data", (chunk: Buffer) => {
    lineBuf += chunk.toString();
    const parts = lineBuf.split("\n");
    lineBuf = parts.pop() ?? "";
    parts.forEach(handleLine);
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString().replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (text) applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
      text: `[stderr] ${text.slice(0, 400)}` });
  });

  proc.on("close", (code) => {
    if (lineBuf.trim()) handleLine(lineBuf);
    if (failContext.length) {
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
        text: failContext.join("\n") });
    }
    const total = passCount + failCount;
    const ok = code === 0 || failCount === 0;
    const summary = ok
      ? `✅ ${suite}: ${passCount}/${total} 全部通过`
      : `❌ ${suite}: ${failCount} 失败 / ${passCount} 通过 (共 ${total})`;
    applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: summary });
    applyEvent({ v: 1, type: "agent.state", agent: "pm", state: "idle", sub: "" } as any);
  });

  proc.on("error", (err) => {
    applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
      text: `⚠ 无法启动测试进程: ${err.message}` });
    applyEvent({ v: 1, type: "agent.state", agent: "pm", state: "idle", sub: "" } as any);
  });
}
