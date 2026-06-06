/**
 * 5-phase in-process test suite.
 *
 * Runs entirely headless — no tmux, no LLM calls, no HTTP.
 * Results stream in real-time to the "test-monitor" agent conversation pane.
 *
 * Phases:
 *   1. 安装检查  — runtime env, binaries, prompt files
 *   2. 指令测试  — all slash-command backing functions
 *   3. Fork 测试 — PM → TL → Worker spawn chain via store + ProcessManager
 *   4. 长周期测试 — 2 TLs × 2 Workers, multi-turn messages, agent completion
 *   5. Token 统计 — accumulation, budget thresholds, reset
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ProcessManager } from "../../../pm/ProcessManager.js";
import {
  applyEvent,
  ensureAgent,
  getState,
  pruneAgents,
  selectAgent,
  setEffort,
  setLayout,
  setMinLevel,
  setTokenBudget,
  getSessionTokens,
  _resetForTest,
} from "../../../store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TUI_ROOT  = path.resolve(__dirname, "../../../..");

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PhaseResult {
  name:       string;
  passed:     number;
  failed:     number;
  errors:     string[];
  tokenDelta: number;
}

export type CheckFn = (label: string, cond: boolean, detail?: string) => void;

// ─── TestSuite ───────────────────────────────────────────────────────────────

export class TestSuite {
  protected readonly monitorId: string;
  protected pm: ProcessManager;
  protected phases: PhaseResult[] = [];
  protected startTokens = 0;

  constructor(monitorId = "test-monitor") {
    this.monitorId = monitorId;
    this.pm = new ProcessManager();
  }

  // ── Public entry point ────────────────────────────────────────────────────

  async run(): Promise<void> {
    ensureAgent({ id: this.monitorId, name: "test-monitor", role: "Leader", state: "run" });
    selectAgent(this.monitorId);

    this.startTokens = getSessionTokens().total;

    this.emit("═══════════════════════════════════════════════════");
    this.emit("  MULTI-AGENT TUI — 全套测试 (5 阶段)");
    this.emit("═══════════════════════════════════════════════════");

    await this.runPhase("1. 安装检查",              (chk) => this.phaseInstall(chk));
    await this.runPhase("2. 指令测试",              (chk) => this.phaseCommands(chk));
    await this.runPhase("3. Fork 测试 (PM→TL→Worker)", (chk) => this.phaseFork(chk));
    await this.runPhase("4. 长周期多 Agent 测试",   (chk) => this.phaseLongSession(chk));
    await this.runPhase("5. Token 统计验证",        (chk) => this.phaseTokens(chk));

    this.outputReport();
    applyEvent({
      v: 1, type: "agent.done",
      agent: this.monitorId,
      success: this.phases.every((p) => p.failed === 0),
      reason:  "测试完成",
    });
  }

  // ── Phase runner ──────────────────────────────────────────────────────────

  async runPhase(
    name: string,
    fn: (check: CheckFn) => void | Promise<void>,
  ): Promise<void> {
    const before = getSessionTokens().total;
    const result: PhaseResult = { name, passed: 0, failed: 0, errors: [], tokenDelta: 0 };
    this.phases.push(result);

    const check: CheckFn = (label, cond, detail) => {
      if (cond) {
        result.passed++;
        this.emit(`  ✓ ${label}`);
      } else {
        result.failed++;
        const msg = detail ? `${label}: ${detail}` : label;
        result.errors.push(msg);
        this.emit(`  ✗ ${label}${detail ? " — " + detail : ""}`);
      }
    };

    this.emit(`\n▶ ${name}`);
    try {
      await fn(check);
    } catch (e) {
      result.failed++;
      const msg = String(e);
      result.errors.push(msg);
      this.emit(`  ✗ 阶段崩溃: ${msg}`);
    }

    result.tokenDelta = getSessionTokens().total - before;
    const pass = result.failed === 0;
    this.emit(
      `  ${pass ? "✅ 通过" : `❌ ${result.failed} 失败`}` +
      ` (${result.passed + result.failed} 项检查, token Δ +${result.tokenDelta})`,
    );
  }

  // ── Phase 1: 安装检查 ─────────────────────────────────────────────────────

  phaseInstall(check: CheckFn): void {
    // Node version ≥ 18
    const major = parseInt(process.version.slice(1).split(".")[0], 10);
    check("Node.js ≥ 18", major >= 18, `found ${process.version}`);

    // tsx binary
    const tsx = spawnSync("tsx", ["--version"], { encoding: "utf8", shell: true });
    check("tsx 可用", tsx.status === 0, tsx.stderr?.trim() || tsx.error?.message);

    // ripgrep
    const rg = spawnSync("rg", ["--version"], { encoding: "utf8", shell: true });
    check("ripgrep (rg) 可用", rg.status === 0, rg.error?.message);

    // prompt files
    const prompts = ["pm.md", "leader.md", "worker.md"];
    for (const f of prompts) {
      const p = path.join(TUI_ROOT, "prompts", f);
      check(`prompts/${f} 存在`, fs.existsSync(p));
    }

    // package.json readable
    const pkgPath = path.join(TUI_ROOT, "package.json");
    let pkgOk = false;
    try {
      JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      pkgOk = true;
    } catch { /* parse error */ }
    check("package.json 可解析", pkgOk);

    // node_modules present
    check(
      "node_modules 已安装",
      fs.existsSync(path.join(TUI_ROOT, "node_modules")),
    );

    // src/store.ts exists (basic code integrity)
    check(
      "src/store.ts 存在",
      fs.existsSync(path.join(TUI_ROOT, "src", "store.ts")),
    );
  }

  // ── Phase 2: 指令测试 ─────────────────────────────────────────────────────

  phaseCommands(check: CheckFn): void {
    // /effort
    setEffort("min");
    check("/effort min → state.effort=min", getState().effort === "min");
    setEffort("max");
    check("/effort max → state.effort=max", getState().effort === "max");
    setEffort("mid"); // restore

    // /layout
    setLayout("v3");
    check("/layout v3 → state.layout=v3", getState().layout === "v3");
    setLayout("v1");
    check("/layout v1 → state.layout=v1", getState().layout === "v1");

    // /budget
    setTokenBudget(100_000);
    check("/budget 100k → tokenBudget=100000", getState().tokenBudget === 100_000);
    setTokenBudget(0);
    check("/budget off → tokenBudget=0 (unlimited)", getState().tokenBudget === 0);

    // /log (setMinLevel)
    setMinLevel("debug");
    check("/log debug → minLevel=debug", getState().minLevel === "debug");
    setMinLevel("info");
    check("/log info → minLevel=info", getState().minLevel === "info");

    // /fanout (ProcessManager)
    this.pm.setFanout(3);
    check("/fanout 3 → pm.maxFanout=3", (this.pm as any).maxFanout === 3);
    this.pm.setFanout(4); // restore

    // /prune — create a temp agent, prune it, verify hidden
    ensureAgent({ id: "prune-test", name: "prune-test", role: "Worker", state: "done" });
    pruneAgents("prune-test");
    check("/prune <id> → agent hidden", getState().agents.get("prune-test")?.hidden === true);

    // pruneAgents global (done agents hidden, run agents not)
    ensureAgent({ id: "prune-run",  name: "prune-run",  role: "Leader", state: "run"  });
    ensureAgent({ id: "prune-done", name: "prune-done", role: "Leader", state: "done" });
    pruneAgents();
    check("/prune (global) done → hidden",   getState().agents.get("prune-done")?.hidden === true);
    check("/prune (global) run  → not hidden", !getState().agents.get("prune-run")?.hidden);

    // selectAgent
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });
    selectAgent("pm");
    check("/select pm → selectedAgent=pm", getState().selectedAgent === "pm");
  }

  // ── Phase 3: Fork 测试 ────────────────────────────────────────────────────

  phaseFork(check: CheckFn): void {
    const pm2 = new ProcessManager();

    // Bootstrap PM
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });

    // PM → TL spawn validation
    const dispatch = {
      background: "test bg",
      constraints: [],
      acceptance_criteria: ["task complete"],
      stop_conditions: ["user.quit"],
    };
    const spawnTlEv = {
      v: 1 as const, type: "spawn" as const,
      parent: "pm", child: "fork-tl-01", role: "Leader" as const,
      goal: "write fork test", dispatch,
    };
    const tlCheck = pm2.preCheckSpawn(spawnTlEv, "Leader");
    check("PM→TL preCheckSpawn ok", tlCheck.ok, !tlCheck.ok ? (tlCheck as any).code : undefined);

    // Apply spawn event
    applyEvent(spawnTlEv);
    const tl = getState().agents.get("fork-tl-01");
    check("TL 已创建 (fork-tl-01)", !!tl);
    check("TL role=Leader",         tl?.role === "Leader");
    check("TL parent=pm",           tl?.parent === "pm");
    check("TL goal 已保存",          tl?.goal === "write fork test");
    check("TL state=idle/run",      tl?.state === "idle" || tl?.state === "run");

    // Set TL depth for further checks
    ensureAgent({ id: "fork-tl-01", name: "fork-tl-01", role: "Leader", state: "run", parent: "pm", depth: 1, goal: "write fork test" });

    // Worker spawn by TL
    const spawnWorkerEv = {
      v: 1 as const, type: "spawn" as const,
      parent: "fork-tl-01", child: "fork-worker-01", role: "Worker" as const,
      goal: "implement feature", dispatch,
    };
    const wCheck = pm2.preCheckSpawn(spawnWorkerEv, "Leader");
    check("TL→Worker preCheckSpawn ok", wCheck.ok, !wCheck.ok ? (wCheck as any).code : undefined);

    applyEvent(spawnWorkerEv);
    const worker = getState().agents.get("fork-worker-01");
    check("Worker 已创建 (fork-worker-01)", !!worker);
    check("Worker role=Worker",             worker?.role === "Worker");
    check("Worker parent=fork-tl-01",       worker?.parent === "fork-tl-01");

    // Worker cannot spawn
    const badSpawnEv = {
      v: 1 as const, type: "spawn" as const,
      parent: "fork-worker-01", child: "fork-worker-02", role: "Worker" as const,
      goal: "illegal", dispatch,
    };
    ensureAgent({ id: "fork-worker-01", name: "fork-worker-01", role: "Worker", state: "run", parent: "fork-tl-01" });
    const workerSpawnCheck = pm2.preCheckSpawn(badSpawnEv, "Worker");
    check("Worker→Worker spawn is blocked", !workerSpawnCheck.ok);
    check("blocked code=worker_cannot_spawn", (workerSpawnCheck as any).code === "worker_cannot_spawn");

    // Worker completes
    applyEvent({ v: 1, type: "agent.done", agent: "fork-worker-01", success: true, reason: "done" });
    check("Worker state → done", getState().agents.get("fork-worker-01")?.state === "done");

    // TL completes
    applyEvent({ v: 1, type: "agent.done", agent: "fork-tl-01", success: true, reason: "done" });
    check("TL state → done", getState().agents.get("fork-tl-01")?.state === "done");

    // Spawn message appears in PM conv
    const pmMsgs = getState().messagesByAgent.get("pm") ?? [];
    const hasSpawnMsg = pmMsgs.some((m) => m.text.includes("fork-tl-01"));
    check("spawn 消息出现在 PM 对话", hasSpawnMsg);
  }

  // ── Phase 4: 长周期多 Agent 测试 ─────────────────────────────────────────

  private phaseLongSession(check: CheckFn): void {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });

    const dispatch = {
      background: "long session bg",
      constraints: [],
      acceptance_criteria: ["done"],
      stop_conditions: ["user.quit"],
    };

    // Spawn 2 TLs
    const tls = ["ls-tl-01", "ls-tl-02"];
    for (const tlId of tls) {
      applyEvent({ v: 1, type: "spawn", parent: "pm", child: tlId, role: "Leader", goal: `task-${tlId}`, dispatch });
      ensureAgent({ id: tlId, name: tlId, role: "Leader", state: "run", parent: "pm", depth: 1, goal: `task-${tlId}` });
    }
    check("2 TL 已创建", tls.every((id) => !!getState().agents.get(id)));

    // Each TL spawns 2 Workers
    const workers: string[] = [];
    for (const tlId of tls) {
      for (let i = 1; i <= 2; i++) {
        const wId = `${tlId}-worker-${i}`;
        applyEvent({ v: 1, type: "spawn", parent: tlId, child: wId, role: "Worker", goal: `subtask-${wId}`, dispatch });
        ensureAgent({ id: wId, name: wId, role: "Worker", state: "run", parent: tlId, depth: 2, goal: `subtask-${wId}` });
        workers.push(wId);
      }
    }
    check("4 Worker 已创建", workers.every((id) => !!getState().agents.get(id)));

    // Simulate 5 message turns per agent (messages to user)
    const allAgents = ["pm", ...tls, ...workers];
    for (const agId of allAgents) {
      for (let turn = 1; turn <= 5; turn++) {
        applyEvent({ v: 1, type: "message", agent: agId, to: "user", text: `turn ${turn} from ${agId}` });
      }
    }

    // Verify messages accumulated
    for (const agId of allAgents) {
      const msgs = getState().messagesByAgent.get(agId) ?? [];
      check(`${agId} 有消息`, msgs.length >= 5, `实际 ${msgs.length}`);
    }

    // Complete all workers
    for (const wId of workers) {
      applyEvent({ v: 1, type: "agent.done", agent: wId, success: true, reason: "完成" });
    }
    check("所有 Worker 已 done", workers.every((id) => getState().agents.get(id)?.state === "done"));

    // TLs report to PM
    for (const tlId of tls) {
      applyEvent({ v: 1, type: "message", agent: tlId, to: "pm", text: `${tlId} 汇报：任务完成` });
    }
    for (const tlId of tls) {
      applyEvent({ v: 1, type: "agent.done", agent: tlId, success: true, reason: "TL 完成" });
    }
    check("所有 TL 已 done", tls.every((id) => getState().agents.get(id)?.state === "done"));

    // No ls-* agent stuck in run (only check agents created in this phase)
    const phaseAgents = new Set([...tls, ...workers]);
    const stuckAgents = [...getState().agents.entries()]
      .filter(([id, a]) => phaseAgents.has(id) && a.state === "run")
      .map(([id]) => id);
    check("无僵尸 Agent (stuck run)", stuckAgents.length === 0, stuckAgents.join(", "));

    // Prune cascade: prune a TL hides its workers
    const pruneTarget = tls[0];
    const pruneChildren = workers.filter((w) => w.startsWith(pruneTarget));
    pruneAgents(pruneTarget);
    check(
      `prune ${pruneTarget} → hidden`,
      getState().agents.get(pruneTarget)?.hidden === true,
    );
    for (const wId of pruneChildren) {
      check(`  cascade: ${wId} → hidden`, getState().agents.get(wId)?.hidden === true);
    }
  }

  // ── Phase 5: Token 统计验证 ───────────────────────────────────────────────

  private phaseTokens(check: CheckFn): void {
    _resetForTest();

    // Accumulation per agent
    applyEvent({ v: 1, type: "token.usage", agent: "tok-pm", prompt: 100, completion: 50 });
    applyEvent({ v: 1, type: "token.usage", agent: "tok-pm", prompt: 200, completion: 80 });
    const bucket = getState().tokensByAgent.get("tok-pm");
    check("token.usage 累加 prompt",     bucket?.prompt === 300,     `got ${bucket?.prompt}`);
    check("token.usage 累加 completion", bucket?.completion === 130,  `got ${bucket?.completion}`);

    // Session totals across agents
    applyEvent({ v: 1, type: "token.usage", agent: "tok-tl", prompt: 400, completion: 100 });
    const session = getState().sessionTokens;
    check("sessionTokens.prompt 正确",     session.prompt     === 700, `got ${session.prompt}`);
    check("sessionTokens.completion 正确", session.completion === 230, `got ${session.completion}`);

    // getSessionTokens helper
    const snap = getSessionTokens();
    check("getSessionTokens().total 正确", snap.total === 930, `got ${snap.total}`);

    // Budget = 0 → unlimited (no warnings)
    setTokenBudget(0);
    check("tokenBudget=0 为无限制", getState().tokenBudget === 0);
    applyEvent({ v: 1, type: "token.usage", agent: "tok-pm", prompt: 9_000_000, completion: 0 });
    const warnMsgs = (getState().messagesByAgent.get("tok-pm") ?? [])
      .filter((m) => m.text.includes("预算"));
    check("budget=0 时无预算警告", warnMsgs.length === 0, `got ${warnMsgs.length} warnings`);

    // 80% warning threshold — budget warnings go to "pm" (store hard-codes this)
    _resetForTest();
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });
    ensureAgent({ id: "budget-ag", name: "budget-ag", role: "Worker", state: "run" });
    setTokenBudget(1_000);
    applyEvent({ v: 1, type: "token.usage", agent: "budget-ag", prompt: 850, completion: 0 });
    const warnAt80 = (getState().messagesByAgent.get("pm") ?? [])
      .find((m) => m.text.includes("预算"));
    check("超过 80% 触发预算警告", !!warnAt80);

    // 95% warning threshold
    _resetForTest();
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });
    ensureAgent({ id: "budget-ag", name: "budget-ag", role: "Worker", state: "run" });
    setTokenBudget(1_000);
    applyEvent({ v: 1, type: "token.usage", agent: "budget-ag", prompt: 960, completion: 0 });
    const warnAt95 = (getState().messagesByAgent.get("pm") ?? [])
      .find((m) => m.text.includes("预算"));
    check("超过 95% 触发严重预算警告", !!warnAt95);

    // _resetForTest clears everything
    _resetForTest();
    check("_resetForTest 清空 sessionTokens.prompt",     getState().sessionTokens.prompt     === 0);
    check("_resetForTest 清空 sessionTokens.completion", getState().sessionTokens.completion === 0);
    check("_resetForTest 清空 tokensByAgent",            getState().tokensByAgent.size       === 0);
    check("_resetForTest 清空 tokenBudget",              getState().tokenBudget              === 0);
  }

  // ── Report ────────────────────────────────────────────────────────────────

  protected outputReport(): void {
    const totalPassed = this.phases.reduce((s, p) => s + p.passed, 0);
    const totalFailed = this.phases.reduce((s, p) => s + p.failed, 0);
    const totalTokens = getSessionTokens().total - this.startTokens;
    const allPassed   = totalFailed === 0;

    this.emit("\n═══════════════════════════════════════════════════");
    this.emit(`  测试报告 — ${allPassed ? "✅ 全部通过" : `❌ ${totalFailed} 项失败`}`);
    this.emit("═══════════════════════════════════════════════════");

    for (const p of this.phases) {
      const icon = p.failed === 0 ? "✅" : "❌";
      this.emit(`  ${icon} ${p.name}: ${p.passed} 通过, ${p.failed} 失败 (+${p.tokenDelta} tokens)`);
      for (const err of p.errors) {
        this.emit(`       → ${err}`);
      }
    }

    this.emit("───────────────────────────────────────────────────");
    this.emit(`  总计: ${totalPassed} 通过 / ${totalFailed} 失败`);
    this.emit(`  本次测试 token 用量: ${totalTokens.toLocaleString()}`);
    this.emit("═══════════════════════════════════════════════════");
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  protected emit(text: string): void {
    applyEvent({ v: 1, type: "message", agent: this.monitorId, to: "user", text });
  }
}
