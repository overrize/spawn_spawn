/**
 * commands.ts — the slash-command table, extracted from App() (spawn-1.0 M1-6e).
 * buildCommands(ctx) returns the CmdDef[]; cross-module deps are imported directly,
 * App-local state/handlers come in via ctx. Body kept verbatim. App-layer, no golden
 * coverage → smoke every command (docs/spawn-1.0/SMOKE-6e.md §2).
 */

import path from "node:path";
import fs from "node:fs";
import type { MutableRefObject } from "react";

import type { TuiEvent, LogLevel } from "../protocol.js";
import type { HttpConvAgent } from "../adapters/httpAgent.js";
import type { ProcessManager } from "../pm/ProcessManager.js";
import type { TaskScheduler } from "../runtime/TaskScheduler.js";
import type { SecretaryProxy } from "../memory/SecretaryProxy.js";
import type { LeaderOpts } from "../runtime/AgentRuntime.js";
import { EFFORT_LEVELS, type Effort, PALETTES } from "../ui.js";
import type { PaletteName } from "../config.js";
import { applyEvent, getState, selectAgent, setMinLevel, setTokenBudget, clearPendingRating, pruneAgents } from "../store.js";
import { savePalette, loadConfig, getAgentProviderConfig } from "../config.js";
import { loadMemory, loadMemoryByHash, listUnfinishedAgents, topFactsByWeight, loadSessions } from "../runtime/MemoryRuntime.js";
import { formatMetricsReport, getHealthMetricsStore } from "../runtime/ObservabilityRuntime.js";
import { logDiag } from "../runtime/ObservabilityRuntime.js";
import { replaceAgentForResume } from "../runtime/OrchestratorRuntime.js";
import { connectFeishu, isFeishuConnected, feishuSessionCount } from "../runtime/FeishuBridge.js";
import { runTestSuite } from "../runtime/DevHarness.js";
import { globalBus } from "../bus/Bus.js";
import { TestSuite } from "../tests/e2e/runner/TestSuite.js";
import { E2ESuite } from "../tests/e2e/runner/E2ESuite.js";

export interface CmdDef {
  name: string;
  desc: string;
  handler: (args: string[]) => void;
}

export interface CommandCtx {
  agents: Map<string, HttpConvAgent>;
  secretaries: Map<string, SecretaryProxy>;
  pm: ProcessManager;
  scheduledTasks: TaskScheduler;
  killedAgents: Set<string>;
  startLeaderAgent: (opts: LeaderOpts) => void;
  startWorker: (ev: Extract<TuiEvent, { type: "spawn" }>, opts?: { resumedMemoryId?: string; firstMessage?: string }) => void;
  pmStarted: MutableRefObject<boolean>;
  confirmEffort: (e: Effort) => void;
  requestExit: () => void;
  setEffortSelecting: (v: boolean) => void;
  setModelSelecting: (v: boolean) => void;
  setPaletteName: (name: PaletteName) => void;
  setZenMode: (fn: (v: boolean) => boolean) => void;
  setStatusMode: (fn: (v: boolean) => boolean) => void;
  showModelConfig: () => void;
  switchModelCommand: (role: string | undefined, modelName?: string) => void;
  registerModelCommand: (name: string | undefined, preset: string | undefined, modelOrKey: string | undefined, maybeApiKey: string | undefined) => void;
  showWebConfig: () => void;
  connectWebProviderCommand: (args: string[]) => void;
  switchWebProviderCommand: (name: string | undefined) => void;
  emitCommandMessage: (text: string) => void;
}

function parseScheduleDelay(raw: string, now = Date.now()): number | null {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (m[2] ?? "ms").toLowerCase();
  const mult = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  return now + Math.round(n * mult);
}

function fmtKIndex(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export function buildCommands(ctx: CommandCtx): CmdDef[] {
  const {
    agents, secretaries, pm, scheduledTasks, killedAgents,
    startLeaderAgent, startWorker, pmStarted,
    confirmEffort, requestExit, setEffortSelecting, setModelSelecting,
    setPaletteName, setZenMode, setStatusMode,
    showModelConfig, switchModelCommand, registerModelCommand,
    showWebConfig, connectWebProviderCommand, switchWebProviderCommand,
    emitCommandMessage,
  } = ctx;
  const feishuConnected = isFeishuConnected();
  const feishuSessions = { size: feishuSessionCount() };
  const __dirname = path.dirname(new URL(import.meta.url).pathname);
  const COMMANDS: CmdDef[] = [
    { name: "pause",   desc: "kill the selected agent",     handler: () => { const sel = getState().selectedAgent; agents.get(sel)?.kill(); } },
    { name: "effort",  desc: "/effort [min|mid|high|max] — set or open effort selector", handler: (args) => {
      const lvl = args[0] as Effort | undefined;
      if (lvl && (EFFORT_LEVELS as readonly string[]).includes(lvl)) {
        confirmEffort(lvl);
      } else {
        setEffortSelecting(true);
      }
    } },
    { name: "prune",   desc: "/prune [agentId] — hide done agents; with id: hide that subtree", handler: (args) => {
      const target = args[0];
      if (target) {
        // Validate: must exist and not be permanent
        const info = getState().agents.get(target);
        if (!info) {
          applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
            text: `未找到 agent "${target}"` });
          return;
        }
        if (target === "pm" || target === "process-monitor") {
          applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
            text: `pm 和 process-monitor 不能被 prune` });
          return;
        }
        const n = pruneAgents(target);
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: `🧹 已隐藏 ${target} 及其 ${n - 1} 个子 agent（共 ${n} 个）` });
      } else {
        const n = pruneAgents();
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: n > 0 ? `🧹 已隐藏 ${n} 个已完成的 agent` : "没有可隐藏的已完成 agent" });
      }
    } },
    { name: "rate", desc: "/rate good|bad [comment] — rate the last completed session", handler: (args) => {
      const rating = getState().pendingRating;
      const verdict = args[0]?.toLowerCase();
      if (!verdict || (verdict !== "good" && verdict !== "bad")) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: "用法：/rate good [说明]  或  /rate bad [说明]" });
        return;
      }
      const comment = args.slice(1).join(" ");
      const human = verdict === "good" ? 1 : -1;
      const agentId = rating?.agentId ?? "pm";
      const sessionHash = rating?.sessionHash ?? "?";
      logDiag(
        `[rating] ${agentId} session=${sessionHash} human=${human}` +
        (comment ? ` comment="${comment}"` : "") + "\n",
      );
      clearPendingRating();
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
        text: `评分已记录：${verdict === "good" ? "👍" : "👎"}${comment ? `  "${comment}"` : ""}` });
    } },
    { name: "sessions", desc: "列出所有未完成会话及 session hash", handler: () => {
      const sessions = listUnfinishedAgents();
      if (sessions.length === 0) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: "✅ 无未完成会话" });
        return;
      }
      const lines = sessions.map((m) => {
        const id = m.session_hash ?? m.agent_id.slice(0, 7);
        const when = new Date(m.created_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
        const goal = m.dispatch.background.slice(0, 55) || m.agent_id;
        return `[${id}] ${m.agent_id.slice(0, 20)} | ${goal} | ${when}`;
      }).join("\n");
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: `📋 未完成会话 (${sessions.length}):\n${lines}\n\n/resume <agentId|hash> 恢复` });
    } },
    { name: "memory", desc: "/memory [agentId] — 查看 Secretary 记录的 facts / decisions / 子节点", handler: (args) => {
      const targetId = args[0] ?? getState().selectedAgent ?? "pm";
      const sec = secretaries.get(targetId);
      const mem = sec?.getMemory() ?? loadMemory(targetId);
      if (!mem) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: `未找到 "${targetId}" 的 memory。可用 agent: ${[...secretaries.keys()].join(", ") || "无"}` });
        return;
      }
      const facts = topFactsByWeight(mem, 10);
      const decisions = mem.working_set.decisions.slice(-5);
      const children = mem.child_handles;
      const sessions = loadSessions(targetId);
      const sizeByes = JSON.stringify(mem).length;

      const logCursor = sec?.getLogCursor() ?? mem.tombstone.log_cursor ?? 0;
      const busStats = globalBus.logStats();
      const lines: string[] = [
        `── memory: ${targetId} (${(sizeByes / 1024).toFixed(1)} KB) ──`,
        `sessions: ${sessions.length}/${5}  |  facts: ${mem.working_set.facts.length}  |  decisions: ${mem.working_set.decisions.length}`,
        `log_cursor: ${logCursor}  |  bus_head: ${busStats.headOffset}  |  ring: ${busStats.size} (oldest offset: ${busStats.oldestOffset})`,
      ];
      if (facts.length > 0) {
        lines.push("\n【facts · top-10 by weight】");
        facts.forEach((f, i) => lines.push(`  ${i + 1}. [w=${f.weight ?? 1}] ${f.text.slice(0, 120)}`));
      } else {
        lines.push("\n【facts】(空)");
      }
      if (decisions.length > 0) {
        lines.push("\n【decisions · 最近 5 条】");
        decisions.forEach((d) => lines.push(`  · ${d.text.slice(0, 120)}`));
      }
      if (children.length > 0) {
        lines.push("\n【child_handles】");
        children.forEach((c) => lines.push(`  ${c.status === "running" ? "◐" : c.status === "done" ? "✓" : "✗"} ${c.agent_id.slice(0, 20)} — ${c.goal?.slice(0, 60) ?? ""}`));
      }
      if (mem.tombstone.compact_summary) {
        lines.push(`\n【tombstone】${mem.tombstone.compact_summary.slice(0, 200)}`);
      }
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: lines.join("\n") });
    } },
    { name: "fanout", desc: "/fanout [N] — 查看/设置最大并发子节点数 (1-16)", handler: (args) => {
      if (!args[0]) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: `当前 maxFanout=${pm.getMaxFanout()}，用 /fanout <N> 修改（1-16）` });
        return;
      }
      const n = parseInt(args[0], 10);
      if (isNaN(n) || n < 1 || n > 16) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: "maxFanout 必须在 1-16 之间" });
        return;
      }
      pm.setFanout(n);
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: `maxFanout 已更新为 ${n}` });
    } },
    { name: "schedule", desc: "/schedule <10s|5m|2h> <task> — schedule a PM task", handler: (args) => {
      const delay = args[0];
      const text = args.slice(1).join(" ").trim();
      if (!delay || !text) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: "用法：/schedule <10s|5m|2h> <任务>，如 /schedule 10s 检查构建状态" });
        return;
      }
      const runAt = parseScheduleDelay(delay);
      if (runAt === null) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: "时间格式支持：500ms / 10s / 5m / 2h" });
        return;
      }
      const ev = scheduledTasks.schedule({ conversationId: "tui:pm", text, runAt });
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
        text: `已安排 ${ev.task.id}：${new Date(runAt).toLocaleString()} 执行\n${text}` });
    } },
    { name: "metrics", desc: "/metrics [event_type|agentId] — 查看最近 HealthMetric", handler: (args) => {
      const filter = args[0]?.trim();
      const text = formatMetricsReport(getHealthMetricsStore().readMetrics(), filter);
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text });
    } },
    { name: "tasks", desc: "/tasks [cancel <id>] — list or cancel scheduled tasks", handler: (args) => {
      if (args[0] === "cancel" && args[1]) {
        const ev = scheduledTasks.cancel(args[1]);
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: ev ? `已取消 ${ev.task.id}` : `无法取消 ${args[1]}（不存在或已结束）` });
        return;
      }
      const tasks = scheduledTasks.list();
      const active = tasks.filter((t) => t.state === "scheduled" || t.state === "running" || t.state === "waiting_user");
      const lines = active.map((t) =>
        `[${t.state}] ${t.id} @ ${new Date(t.runAt).toLocaleString()} — ${t.text.slice(0, 80)}`
      );
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
        text: lines.length
          ? `计划任务：\n${lines.join("\n")}\n\n/tasks cancel <id> 取消`
          : "暂无计划任务。用 /schedule <10s|5m|2h> <task> 新建。" });
    } },
    { name: "resume",  desc: "/resume [agentId|hash] — resume from memory", handler: (args) => {
      const input = args[0] ?? "pm";
      const mem = loadMemory(input) ?? loadMemoryByHash(input);
      if (!mem) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: `未找到 "${input}" 的记忆。输入 /sessions 查看可用会话。` });
        return;
      }
      const id = mem.agent_id;
      replaceAgentForResume(id, { agents, secretaries, killedAgents });
      selectAgent(id);
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
        text: `Resuming ${id} (hash: ${mem.session_hash ?? "?"}) from last checkpoint` });
      const isRootAgent = mem.agent_type === "PM" || id === "pm";
      if (isRootAgent) {
        const deadWorkers = listUnfinishedAgents()
          .filter((m) => m.parent_chain?.includes(id))
          .map((m) => m.agent_id)
          .filter((wid) => !agents.has(wid));
        const deadNote = deadWorkers.length > 0
          ? `\n\n⚠️ 以下 agent 在上次会话中存在，当前已不在线：${deadWorkers.join(", ")}。请重新 spawn 或调整计划。`
          : "";
        const hint = mem.tombstone.resume_hint ?? "上次会话中断";
        const lastTodoLines = (() => {
          try {
            return mem.tombstone.last_todo
              ? (JSON.parse(mem.tombstone.last_todo) as Array<{state: string; text: string}>)
                  .map((t) => `  [${t.state}] ${t.text}`).join("\n")
              : "  (无记录)";
          } catch { return "  (无法解析)"; }
        })();
        const resumeHint = [
          `[系统-恢复指令] 上次中断：${hint}${deadNote}`,
          ``,
          `上次 TODO 状态：`,
          lastTodoLines,
          ``,
          `**立刻输出 todo.set**，把上次已完成的项标为 done，把需要继续的项标为 todo/run，然后直接继续执行。不要等待确认，不要只说"收到"。`,
        ].join("\n");
        logDiag(`[resume] starting ${id} — firstMessage: "${resumeHint.slice(0, 200)}"\n`);
        pmStarted.current = false;
        startLeaderAgent({ id, firstMessage: resumeHint, resumedMemoryId: id, promptFile: isRootAgent ? "pm" : "leader" });
        pmStarted.current = true;
      } else if (mem.agent_type === "LEADER") {
        const parentId = mem.parent_chain[mem.parent_chain.length - 1] ?? "pm";
        const spawnEv: Extract<TuiEvent, { type: "spawn" }> = {
          v: 1, type: "spawn", parent: parentId, child: id,
          role: "Leader", goal: mem.dispatch.background, dispatch: mem.dispatch,
        };
        applyEvent(spawnEv);
        const hint = mem.tombstone.resume_hint ?? "上次 TL 会话中断";
        const resumeHint = [
          `[系统-恢复指令] 上次中断：${hint}`,
          `任务背景：${mem.dispatch.background}`,
          `请先输出 todo.set 恢复计划，然后继续推进。不要等待确认。`,
        ].join("\n");
        startLeaderAgent({
          id,
          parentId,
          goal: mem.dispatch.background,
          dispatch: mem.dispatch,
          resumedMemoryId: id,
          promptFile: "leader",
          firstMessage: resumeHint,
        });
      } else {
        const parentId = mem.parent_chain[mem.parent_chain.length - 1] ?? "pm";
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: `Resuming worker ${id} (parent: ${parentId}, goal: ${mem.dispatch.background.slice(0, 80)})` });
        const spawnEv: Extract<TuiEvent, { type: "spawn" }> = {
          v: 1, type: "spawn", parent: parentId, child: id,
          role: mem.identity.role_name === "SECRETARY" ? "Secretary" : "Worker",
          goal: mem.dispatch.background, dispatch: mem.dispatch,
        };
        applyEvent(spawnEv);
        const hint = mem.tombstone.resume_hint ?? "上次 worker 会话中断";
        const resumeHint = [
          `[系统-恢复指令] 上次中断：${hint}`,
          `任务目标：${mem.dispatch.background}`,
          `请先输出 todo.set 恢复计划，然后继续执行未完成步骤。不要等待确认。`,
        ].join("\n");
        startWorker(spawnEv, { resumedMemoryId: id, firstMessage: resumeHint });
      }
    } },
    { name: "palette", desc: "切换配色 paper | green | amber", handler: (args) => { const name = args[0] as PaletteName; if (name && name in PALETTES) { setPaletteName(name); savePalette(name); } } },
    { name: "zen",     desc: "切换 Zen 模式（隐藏左右面板，只留中间文本方便复制）", handler: () => { setZenMode((v) => !v); } },
    { name: "status",  desc: "切换 Status 模式（只显示左侧 agents 状态面板）", handler: () => { setStatusMode((v) => !v); } },
    { name: "log",     desc: "日志级别 debug | info | warn | error", handler: (args) => { const l = args[0] as LogLevel; if (["debug","info","warn","error"].includes(l)) setMinLevel(l); } },
    { name: "feishu", desc: "/feishu <app_id> <app_secret> — 连接飞书 WebSocket（无参数显示状态）", handler: (args) => {
      const [appId, appSecret] = args;
      if (!appId || !appSecret) {
        const status = isFeishuConnected() ? "✅ 已连接" : "❌ 未连接";
        const sessions = feishuSessionCount();
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: `飞书状态: ${status}  活跃会话: ${sessions} 个\n用法: /feishu <app_id> <app_secret>` } as TuiEvent);
        return;
      }
      // Persist to .env for next startup
      const envPath = path.join(__dirname, "..", ".env");
      try {
        let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
        const set = (key: string, val: string) => {
          const re = new RegExp(`^${key}=.*$`, "m");
          return re.test(envContent) ? envContent.replace(re, `${key}=${val}`) : envContent + `\n${key}=${val}`;
        };
        envContent = set("FEISHU_APP_ID", appId);
        envContent = set("FEISHU_APP_SECRET", appSecret);
        fs.writeFileSync(envPath, envContent.trimStart(), "utf-8");
        process.env.FEISHU_APP_ID = appId;
        process.env.FEISHU_APP_SECRET = appSecret;
      } catch { /* non-fatal */ }
      connectFeishu(appId, appSecret);
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
        text: `飞书连接中... (${appId}) 凭证已保存到 .env` } as TuiEvent);
    } },
    { name: "model", desc: "/model [role name] — 查看/切换 leader|worker|secretary 使用的已注册模型", handler: (args) => {
      const [role, modelName] = args;
      if (!role) {
        setModelSelecting(true);
        return;
      }
      if (role === "show" || role === "status" || role === "ls") {
        showModelConfig();
        return;
      }
      switchModelCommand(role, modelName);
    } },
    { name: "connect", desc: "/connect <name> <preset|baseUrl> [modelId] <apiKey> — 注册/更新模型连接", handler: (args) => {
      const [name, preset, modelOrKey, maybeApiKey] = args;
      registerModelCommand(name, preset, modelOrKey, maybeApiKey);
    } },
    { name: "web", desc: "/web show|provider <name>|connect <name> <serper|brave> <apiKey> [hl] [gl] — 配置 WebSearch", handler: (args) => {
      const [sub, ...rest] = args;
      if (!sub || sub === "show" || sub === "status" || sub === "ls") {
        showWebConfig();
        return;
      }
      if (sub === "connect") {
        connectWebProviderCommand(rest);
        return;
      }
      if (sub === "provider") {
        switchWebProviderCommand(rest[0]);
        return;
      }
      emitCommandMessage("用法: /web show | /web connect <name> <serper|brave> <apiKey> [hl] [gl] | /web provider <name>");
    } },
    { name: "alerts",  desc: "/alerts [ack <code>] — PM 告警面板", handler: (args) => {
      if (args[0] === "ack" && args[1]) { pm.ackAlert(args[1]); return; }
      const alerts = pm.getUnacked();
      if (alerts.length === 0) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: "✅ 无未确认告警" });
        return;
      }
      const text = alerts.map((a) => `[${a.severity}] ${a.code} @ ${a.agent}: ${a.detail}`).join("\n");
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: `📊 告警 (${alerts.length} 条):\n${text}\n\n/alerts ack <code> 确认` });
    } },
    { name: "quit",    desc: "exit the TUI",                handler: () => requestExit() },
    { name: "budget", desc: "/budget [Nk|N|off] — set/clear token budget", handler: (args) => {
      const raw = args[0];
      if (!raw || raw === "off") {
        setTokenBudget(0);
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: "💰 token 预算已清除" });
        return;
      }
      const lower = raw.toLowerCase();
      const multiplier = lower.endsWith("k") ? 1_000 : lower.endsWith("m") ? 1_000_000 : 1;
      const n = parseFloat(lower) * multiplier;
      if (isNaN(n) || n <= 0) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: "用法: /budget 100k  /budget 50000  /budget off" });
        return;
      }
      setTokenBudget(Math.round(n));
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
        text: `💰 token 预算已设为 ${fmtKIndex(Math.round(n))} tokens（超过 80%/95% 时会警告）` });
    } },
    { name: "test", desc: "/test [headless|unit|full|e2e] — run test suite inside TUI", handler: (args) => {
      const suite = args[0] ?? "headless";
      if (suite === "full") {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: "🧪 /test full 启动 — 结果在 test-monitor 面板" });
        new TestSuite().run().catch((e) => {
          applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
            text: `⚠ TestSuite 崩溃: ${String(e)}` });
        });
      } else if (suite === "e2e") {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: "🧪 /test e2e 启动 — 结果在 e2e-monitor 面板" });
        new E2ESuite().run().catch((e) => {
          applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
            text: `⚠ E2ESuite 崩溃: ${String(e)}` });
        });
      } else {
        runTestSuite(suite);
      }
    } },
  ];
  return COMMANDS;
}
