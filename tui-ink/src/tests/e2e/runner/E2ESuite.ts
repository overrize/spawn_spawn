/**
 * E2E test suite — runs inside the TUI via `/test e2e`.
 *
 * Extends the headless TestSuite (phases 1-3) with three HTTP phases
 * that drive real HttpConvAgent instances against a local MockLLMServer:
 *
 *   Phase H1: 安装检查         (headless, from TestSuite)
 *   Phase H2: 指令测试         (headless, from TestSuite)
 *   Phase H3: Fork 逻辑检查    (headless, from TestSuite)
 *   Phase E1: HTTP 基础通信    (MockLLMServer 启动 + 单次 HTTP 调用验证)
 *   Phase E2: Agent HTTP 链路  (HttpConvAgent → mock → parseAgentOutput → store)
 *   Phase E3: 自动话题长周期   (PM→TL→2×Worker 完整链，2 轮对话)
 *
 * Results stream to "e2e-monitor" agent pane in real-time.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { TestSuite, type PhaseResult, type CheckFn } from "./TestSuite.js";
import { MockLLMServer } from "./MockLLMServer.js";
import { HttpConvAgent } from "../../../adapters/httpAgent.js";
import type { ProviderConfig } from "../../../config.js";
import type { TuiEvent } from "../../../protocol.js";
import {
  applyEvent, ensureAgent, getState, selectAgent,
  getSessionTokens, _resetAgents, _deleteAgents,
} from "../../../store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TUI_ROOT  = path.resolve(__dirname, "../../../..");

const TOPICS = [
  "分析 src/store.ts 的架构，提出 3 个改进建议",
  "用 TypeScript 实现一个带过期时间的 LRU 缓存",
  "制定一个代码重构计划，分为调研、实施、验证三个阶段",
  "为 multi-agent TUI 设计一套错误恢复机制",
];

// ── Helper: build a scripted agent response ───────────────────────────────

const DISPATCH = {
  background: "e2e test",
  constraints: [],
  acceptance_criteria: ["完成"],
  stop_conditions: ["quit"],
};

function spawnLine(parent: string, child: string, role: "Leader" | "Worker", goal: string): string {
  return JSON.stringify({ v: 1, type: "spawn", parent, child, role, goal, dispatch: DISPATCH });
}

function msgLine(agent: string, to: string, text: string): string {
  return JSON.stringify({ v: 1, type: "message", agent, to, text });
}

function doneLine(agent: string): string {
  return JSON.stringify({ v: 1, type: "agent.done", agent, success: true, reason: "done" });
}

// ── E2ESuite ─────────────────────────────────────────────────────────────────

export class E2ESuite extends TestSuite {
  private server: MockLLMServer = new MockLLMServer();
  private workspaceDir = "";
  private e2ePhases: PhaseResult[] = [];

  constructor() {
    super("e2e-monitor");
  }

  override async run(): Promise<void> {
    ensureAgent({ id: this.monitorId, name: "e2e-monitor", role: "Leader", state: "run" });
    selectAgent(this.monitorId);

    this.startTokens = getSessionTokens().total;
    this.workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-e2e-"));

    this.emit("═══════════════════════════════════════════════════");
    this.emit("  MULTI-AGENT TUI — E2E 测试");
    this.emit(`  工作目录: ${this.workspaceDir}`);
    this.emit("═══════════════════════════════════════════════════");

    // Headless phases (reuse TestSuite logic) ─────────────────────────────
    await this.runPhase("H1. 安装检查",           (chk) => this.phaseInstall(chk));
    await this.runPhase("H2. 指令测试",           (chk) => this.phaseCommands(chk));
    await this.runPhase("H3. Fork 逻辑检查",      (chk) => this.phaseFork(chk));

    // HTTP phases ────────────────────────────────────────────────────────
    const port = await this.server.start();
    this.emit(`\n✦ MockLLMServer 已启动 → 127.0.0.1:${port}`);

    try {
      await this.runPhase("E1. HTTP 基础通信",    (chk) => this.phaseHttpBasics(chk, port));
      await this.runPhase("E2. Agent HTTP 链路",  (chk) => this.phaseAgentHttp(chk, port));

      const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)]!;
      this.emit(`\n✦ 自动话题: 「${topic}」`);
      await this.runPhase("E3. 长周期多 Agent",   (chk) => this.phaseE2ELongSession(chk, port, topic));
    } finally {
      await this.server.stop();
    }

    this.outputReport();

    // Clean up all transient test agents so they don't pollute the Tab list.
    _deleteAgents([
      // H2 phaseCommands
      "prune-test", "prune-run", "prune-done",
      // H3 phaseFork
      "fork-tl-01", "fork-worker-01",
      // E2 phaseAgentHttp
      "http-pm", "http-tl",
      // E3 phaseE2ELongSession
      "ls-pm", "ls-tl", "ls-w1", "ls-w2",
    ]);

    applyEvent({
      v: 1, type: "agent.done",
      agent: this.monitorId,
      success: this.phases.every((p) => p.failed === 0),
      reason:  "E2E 完成",
    });
  }

  // ── Phase E1: HTTP 基础通信 ───────────────────────────────────────────────

  private async phaseHttpBasics(check: CheckFn, port: number): Promise<void> {
    const baseUrl = `http://127.0.0.1:${port}`;

    // Health check GET
    let healthOk = false;
    try {
      const r = await fetch(`${baseUrl}/`);
      healthOk = r.ok;
    } catch { /* not ok */ }
    check("MockLLMServer GET / 响应 200", healthOk);

    // POST /v1/chat/completions — verify SSE response
    const content = doneLine("http-test-agent");
    this.server.enqueue(content);

    let sseText = "";
    try {
      const r = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer mock" },
        body: JSON.stringify({ model: "mock", messages: [], stream: true }),
      });
      check("POST /v1/chat/completions → 200", r.ok);
      sseText = await r.text();
    } catch (e) {
      check("POST /v1/chat/completions → 200", false, String(e));
    }

    check("SSE 响应包含 data:", sseText.includes("data:"));
    check("SSE 结尾包含 [DONE]", sseText.includes("[DONE]"));

    // Verify delta content round-trips correctly
    const deltaMatch = sseText.match(/"content":"([^"]+)"/);
    check("delta content 未被截断", !!deltaMatch);

    check("callCount 正确 (2 calls: GET + POST)", this.server.callCount === 2);
  }

  // ── Phase E2: Agent HTTP 链路 ─────────────────────────────────────────────

  private async phaseAgentHttp(check: CheckFn, port: number): Promise<void> {
    _resetAgents(["http-pm", "http-tl"]);

    const providerCfg: ProviderConfig = {
      provider:  "openai",
      baseUrl:   `http://127.0.0.1:${port}`,
      apiKey:    "mock-key",
      model:     "mock-model",
    };

    ensureAgent({ id: "http-pm", name: "http-pm", role: "Leader", state: "run" });

    // Enqueue: PM responds by spawning a TL
    this.server.enqueue(spawnLine("http-pm", "http-tl", "Leader", "http 测试任务"));

    const agent = new HttpConvAgent({ id: "http-pm", role: "Leader", providerCfg });
    const events: TuiEvent[] = [];
    agent.on("event", (ev: TuiEvent) => {
      applyEvent(ev);
      events.push(ev);
    });

    await agent.send("请 spawn 一个 TL 来处理 http 测试任务");

    check("HttpConvAgent 发出事件", events.length > 0);

    const spawnEv = events.find((e) => e.type === "spawn");
    check("HTTP 响应包含 spawn 事件",    !!spawnEv);
    check("spawn child = http-tl",       (spawnEv as any)?.child === "http-tl");
    check("spawn role  = Leader",        (spawnEv as any)?.role  === "Leader");
    check("spawn 已写入 store",          !!getState().agents.get("http-tl"));

    const tokenEv = events.find((e) => e.type === "token.usage");
    check("token.usage 事件已发出",      !!tokenEv);
    check("token.usage prompt > 0",      ((tokenEv as any)?.prompt ?? 0) > 0);

    check("sessionTokens 已累加",        getState().sessionTokens.prompt > 0);
  }

  // ── Phase E3: 长周期多 Agent（自动话题）─────────────────────────────────

  private async phaseE2ELongSession(check: CheckFn, port: number, topic: string): Promise<void> {
    _resetAgents(["ls-pm", "ls-tl", "ls-w1", "ls-w2"]);

    const providerCfg: ProviderConfig = {
      provider: "openai",
      baseUrl:  `http://127.0.0.1:${port}`,
      apiKey:   "mock-key",
      model:    "mock-model",
    };

    const agentEvents: Map<string, TuiEvent[]> = new Map();
    const mkAgent = (id: string, role: string) => {
      const a = new HttpConvAgent({ id, role, providerCfg });
      a.on("event", (ev: TuiEvent) => {
        applyEvent(ev);
        const bucket = agentEvents.get(id) ?? [];
        bucket.push(ev);
        agentEvents.set(id, bucket);
      });
      return a;
    };
    const hasDone = (id: string) =>
      (agentEvents.get(id) ?? []).some((e) => e.type === "agent.done" && (e as any).success === true);

    // ── Turn 1: PM → spawn TL ──────────────────────────────────────────────
    ensureAgent({ id: "ls-pm", name: "ls-pm", role: "Leader", state: "run" });
    const pmAgent = mkAgent("ls-pm", "Leader");

    this.server.enqueue(spawnLine("ls-pm", "ls-tl", "Leader", topic));
    await pmAgent.send(`你是 PM。话题：${topic}。请 spawn 一个 TL。`);

    check("PM 轮次 1: spawn TL 事件",    !!getState().agents.get("ls-tl"));
    ensureAgent({ id: "ls-tl", name: "ls-tl", role: "Leader", state: "run",
                  parent: "ls-pm", depth: 1, goal: topic });

    // ── Turn 2: TL → spawn 2 Workers ──────────────────────────────────────
    const tlAgent = mkAgent("ls-tl", "Leader");
    this.server.enqueue(
      spawnLine("ls-tl", "ls-w1", "Worker", "子任务 A") + "\n" +
      spawnLine("ls-tl", "ls-w2", "Worker", "子任务 B"),
    );
    await tlAgent.send(`你是 TL。话题：${topic}。请 spawn 两个 Worker。`);

    const w1 = getState().agents.get("ls-w1");
    const w2 = getState().agents.get("ls-w2");
    check("TL 轮次 1: spawn Worker-1",   !!w1);
    check("TL 轮次 1: spawn Worker-2",   !!w2);
    ensureAgent({ id: "ls-w1", name: "ls-w1", role: "Worker", state: "run", parent: "ls-tl", depth: 2, goal: "子任务 A" });
    ensureAgent({ id: "ls-w2", name: "ls-w2", role: "Worker", state: "run", parent: "ls-tl", depth: 2, goal: "子任务 B" });

    // ── Turn 3-4: Workers 完成 ────────────────────────────────────────────
    const w1Agent = mkAgent("ls-w1", "Worker");
    this.server.enqueue(
      msgLine("ls-w1", "user", "子任务 A 分析完成，发现 2 个优化点") + "\n" +
      doneLine("ls-w1"),
    );
    await w1Agent.send("开始执行子任务 A");

    check("Worker-1: 发出 message 事件",
      (getState().messagesByAgent.get("ls-w1") ?? []).some((m) => m.text.includes("子任务 A")));
    check("Worker-1: 发出 agent.done 事件", hasDone("ls-w1"));

    const w2Agent = mkAgent("ls-w2", "Worker");
    this.server.enqueue(
      msgLine("ls-w2", "user", "子任务 B 实现完成") + "\n" +
      doneLine("ls-w2"),
    );
    await w2Agent.send("开始执行子任务 B");

    check("Worker-2: 发出 agent.done 事件", hasDone("ls-w2"));

    // ── Turn 5: TL 汇总 → message to PM + done ────────────────────────────
    this.server.enqueue(
      msgLine("ls-tl", "ls-pm", "两个子任务均完成，结果已汇总") + "\n" +
      doneLine("ls-tl"),
    );
    await tlAgent.send("两个 Worker 都完成了，请汇总");

    check("TL: message → PM",
      (getState().messagesByAgent.get("ls-pm") ?? []).some((m) => m.text.includes("汇总")));
    check("TL: 发出 agent.done 事件", hasDone("ls-tl"));

    // ── Turn 6: PM 最终回复 ────────────────────────────────────────────────
    this.server.enqueue(
      msgLine("ls-pm", "user", `任务「${topic}」已完成`) + "\n" +
      doneLine("ls-pm"),
    );
    await pmAgent.send("TL 说任务完成了，请给用户汇报");

    check("PM: 最终 message → user",
      (getState().messagesByAgent.get("ls-pm") ?? []).some((m) => m.text.includes("完成")));

    // ── Token summary ─────────────────────────────────────────────────────
    const sess = getState().sessionTokens;
    check("session prompt tokens > 0",     sess.prompt > 0);
    check("session completion tokens > 0", sess.completion > 0);
    this.emit(`  📊 本阶段 tokens: prompt=${sess.prompt}, completion=${sess.completion}`);

    // ── Workspace artifact: write brief report ────────────────────────────
    try {
      const report = {
        topic,
        agents: ["ls-pm", "ls-tl", "ls-w1", "ls-w2"].map((id) => ({
          id, state: getState().agents.get(id)?.state,
        })),
        sessionTokens: sess,
      };
      fs.writeFileSync(
        path.join(this.workspaceDir, "e2e-report.json"),
        JSON.stringify(report, null, 2),
      );
      this.emit(`  📁 报告已写入: ${this.workspaceDir}/e2e-report.json`);
    } catch { /* non-fatal */ }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  protected override outputReport(): void {
    const totalPassed = this.phases.reduce((s, p) => s + p.passed, 0);
    const totalFailed = this.phases.reduce((s, p) => s + p.failed, 0);
    const totalTokens = getSessionTokens().total - this.startTokens;
    const allPassed   = totalFailed === 0;

    this.emit("\n═══════════════════════════════════════════════════");
    this.emit(`  E2E 测试报告 — ${allPassed ? "✅ 全部通过" : `❌ ${totalFailed} 项失败`}`);
    this.emit("═══════════════════════════════════════════════════");

    for (const p of this.phases) {
      const icon = p.failed === 0 ? "✅" : "❌";
      this.emit(`  ${icon} ${p.name}: ${p.passed} 通过, ${p.failed} 失败`);
      for (const err of p.errors) {
        this.emit(`       → ${err}`);
      }
    }

    this.emit("───────────────────────────────────────────────────");
    this.emit(`  总计: ${totalPassed} 通过 / ${totalFailed} 失败`);
    this.emit(`  测试 token 用量: ${totalTokens.toLocaleString()}`);
    this.emit(`  工作目录: ${this.workspaceDir}`);
    this.emit("═══════════════════════════════════════════════════");
  }
}
