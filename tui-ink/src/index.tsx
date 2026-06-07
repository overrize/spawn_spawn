#!/usr/bin/env node
// Multi-agent TUI · entry
// ─────────────────────────────────────────────────────────────────────────────
// Layout: V1 三栏 inbox
//   ┌───── titlebar ─────┐
//   │  agents │ conv │ todo
//   │  input bar
//   │  status bar
//
// Flags:
//   --demo            don't actually spawn claude; emit fake events so the UI
//                     is testable without an API key. Recommend for first run.
//   --model=<id>      override leader model (default claude-sonnet-4-5)
//   --prompts=<dir>   directory holding _base.md / leader.md / ... (default ../prompts)

import React, { useCallback, useEffect, useRef, useState } from "react";
import { render, useApp, useInput, useStdin, Box, Text } from "ink";
import { PassThrough } from "node:stream";
import { execSync, spawnSync, spawn as nodeSpawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { HttpConvAgent } from "./adapters/httpAgent.js";
import {
  TitleBar, AgentsPane, SessionsPane, ConvPane, TodoPane, StatusBar, InputBar, EffortBar,
  EFFORT_LEVELS, type Effort,
  DagView, VDivider, PaletteContext, PALETTES,
} from "./ui.js";
import {
  applyEvent, ensureAgent, getState, selectAgent, useStore, userMessage,
  approve, reject, abortAgent, setLayout, scrollBy, scrollAgentBy, setMinLevel, setEffort,
  resumeAgent, updateAgentInfo, clearDoneAgents, markPendingInput, pruneAgents, setTokenBudget,
  setPendingRating, clearPendingRating,
} from "./store.js";
import type { TuiEvent, LogLevel } from "./protocol.js";
import { loadConfig, savePalette, saveLayout, saveAgentConfig, PROVIDER_PRESETS } from "./config.js";
import type { PaletteName, ProviderConfig } from "./config.js";
import { SecretaryProxy } from "./memory/SecretaryProxy.js";
import { createMemory, loadMemory, loadMemoryByHash, listUnfinishedAgents, deleteAgentMemory } from "./memory/MemoryStore.js";
import { ProcessManager } from "./pm/ProcessManager.js";
import { executeTool, toolNeedsApproval, buildToolSchemaBlock } from "./tools/registry.js";
import type { AgentRole } from "./tools/registry.js";
import { TestSuite } from "./tests/e2e/runner/TestSuite.js";
import { E2ESuite } from "./tests/e2e/runner/E2ESuite.js";
import { TokenManager } from "./feishu/auth.js";
import { sendTextMessage } from "./feishu/message.js";
import { startFeishuWebSocket } from "./feishu/websocket.js";
import { config as dotenvConfig } from "dotenv";
// Load .env so FEISHU_APP_ID / FEISHU_APP_SECRET are available even without shell export
dotenvConfig();

// ── 路径 ───────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (k: string) => argv.find((a) => a.startsWith(`--${k}`));
const DEMO = !!flag("demo");
const MODEL = flag("model")?.split("=")[1] ?? "claude-sonnet-4-5";
const PROMPTS_DIR = path.resolve(__dirname, "..",
  flag("prompts")?.split("=")[1] ?? "../prompts");


// ── 拼系统 prompt ──────────────────────────────────────────────────────────
function buildSystemPrompt(
  role: "Leader" | "Secretary" | "Worker",
  agentId: string,
  goal?: string,
  resumedMemoryId?: string,
  promptFile?: string, // override default: "pm", "leader", "worker", etc.
): string {
  const base = readIfExists(path.join(PROMPTS_DIR, "_base.md"));
  const rolePrompt = readIfExists(path.join(PROMPTS_DIR, `${promptFile ?? role.toLowerCase()}.md`));
  let tpl = `${base}\n\n---\n\n${rolePrompt}`;

  // S3: inject RESUMED CONTEXT when resuming from memory
  if (resumedMemoryId) {
    const mem = loadMemory(resumedMemoryId);
    if (!mem) {
      process.stderr.write(`[resume] WARN: loadMemory("${resumedMemoryId}") returned null — no context injected\n`);
    }
    if (mem) {
      const budgetKb = mem.dispatch?.memory_quota_kb ?? 60;
      const budgetChars = budgetKb * 512; // rough: ~512 chars per KB in markdown

      // Sort facts by weight desc, then by ts desc (newer first for tie)
      const sorted = [...mem.working_set.facts].sort((a, b) => {
        const wDiff = (b.weight ?? 1) - (a.weight ?? 1);
        if (wDiff !== 0) return wDiff;
        return b.ts - a.ts; // recent first
      });

      // Take top 10 respecting budget
      const topFacts: string[] = [];
      let charsUsed = 0;
      for (const f of sorted.slice(0, 10)) {
        const line = `- [w${f.weight ?? 1}] ${f.text}`;
        if (charsUsed + line.length > budgetChars && topFacts.length > 0) break;
        topFacts.push(line);
        charsUsed += line.length;
      }

      const facts = topFacts.join("\n");
      const decisions = mem.working_set.decisions.map((d) => `- ${d.text}`).join("\n");
      const lastTodo = mem.tombstone.last_todo
        ? JSON.parse(mem.tombstone.last_todo).map((t: {state: string; text: string}) => `  [${t.state}] ${t.text}`).join("\n")
        : "(unknown)";
      process.stderr.write(`[resume] context injected: facts=${topFacts.length}, decisions=${mem.working_set.decisions.length}, hint="${(mem.tombstone.resume_hint ?? "").slice(0, 80)}"\n`);
      tpl += `\n\n---\n\n## ⚠️ RESUMED CONTEXT\n\n你正在从中断恢复。上次中断原因：${mem.tombstone.resume_hint ?? "未知"}\n\nResume budget: ${budgetKb}KB\n\n**上次 TODO 状态：**\n${lastTodo}\n\n**已确认事实（weight top 10，预算内）：**\n${facts || "(无)"}\n\n**关键决定：**\n${decisions || "(无)"}\n\n**第一句必须输出 todo.set 重申当前计划，然后继续推进。**`;
    }
  }

  const cfg = loadConfig();
  return tpl
    .replace(/\{\{AGENT_ID\}\}/g, agentId)
    .replace(/\{\{ROLE\}\}/g, role)
    .replace(/\{\{GOAL\}\}/g, goal ?? "(无，等用户指令)")
    .replace(/\{\{ALLOWED_TOOLS\}\}/g, buildToolSchemaBlock(role as AgentRole))
    .replace(/\{\{PARENT_ID\}\}/g, "—")
    .replace(/\{\{CWD\}\}/g, process.cwd())
    .replace(/\{\{AGENT_LIST\}\}/g, Array.from(agents.keys()).join(", ") || "(仅你自己)")
    .replace(/\{\{WORKER_MODEL\}\}/g, cfg.agents.worker.model)
    .replace(/\{\{LEADER_MODEL\}\}/g, cfg.agents.leader.model)
    .replace(/\{\{SECRETARY_MODEL\}\}/g, cfg.agents.secretary.model);
}
function readIfExists(p: string): string {
  try { return fs.readFileSync(p, "utf8"); } catch { return `(missing: ${p})`; }
}

// ── 全局单例 ───────────────────────────────────────────────────────────────
const agents = new Map<string, HttpConvAgent>();
const secretaries = new Map<string, SecretaryProxy>(); // agentId → Secretary
const pm = new ProcessManager();
// Feishu: open_id → pmId (e.g. "feishu-a1b2c3d4")
const feishuSessions = new Map<string, string>();
let feishuConnected = false;

// Agents that were explicitly killed by the user (ESC) or by a parent agent.kill event.
// Used to suppress child→parent notifications after a kill so the parent isn't restarted.
const killedAgents = new Set<string>();

// Destructive Bash commands from workers are routed to leader for approval instead
// of asking the user directly. Keyed by tool.call id.
const leaderApprovalQueue = new Map<string, {
  workerAgent: HttpConvAgent;
  toolName: string;
  toolArgs: unknown;
  workerChildId: string;
}>();

// PM 事件转发到 TUI
pm.on("event", (ev: TuiEvent) => applyEvent(ev));
pm.on("kill", (agentId: string) => {
  agents.get(agentId)?.kill?.();
  applyEvent({ v: 1, type: "agent.error", agent: agentId, code: "runtime_exceeded", detail: "PM killed: exceeded 60min hard limit" });
});

// dispatch.timeout_ms 软超时：PM 发纠正让 Worker 主动 handup，不直接 kill
pm.on("timeout", (agentId: string) => {
  const worker = agents.get(agentId);
  if (worker instanceof HttpConvAgent) {
    worker.sendCommand({
      type: "user.message",
      text: `[系统-超时] 你的 dispatch.timeout_ms 已到期。立刻输出 unit.handup（说明已完成的工作和未完成原因），然后 agent.done(success:false, reason:"timeout")。不要继续当前任务。`,
    });
  }
});

// ── 通信矩阵检查 — 违规消息替换为 agent.error，不投递给 user ────────────────
function checkMessageLegal(ev: Extract<TuiEvent, { type: "message" }>): boolean {
  const senderRole = getState().agents.get(ev.agent)?.role;
  if (!senderRole) return true; // unknown sender, allow
  const recipientRole = getState().agents.get(ev.to)?.role;

  // Worker → user: block
  if (senderRole === "Worker" && ev.to === "user") {
    applyEvent({ v: 1, type: "agent.error", agent: ev.agent, code: "illegal_message",
      detail: `Worker ${ev.agent} 不能直接 message.to=user（应 message.to=leader）。已拦截。` });
    pm.observe(ev); // still let PM log it
    return false;
  }
  // Worker → Worker: block
  if (senderRole === "Worker" && recipientRole === "Worker") {
    applyEvent({ v: 1, type: "agent.error", agent: ev.agent, code: "illegal_message",
      detail: `Worker ${ev.agent} 不能 message.to=${ev.to}（Worker 间不能直接通信）。已拦截。` });
    return false;
  }
  return true;
}


// ── 找离 childId 最近的 Leader 祖先，用于 Bash 审批路由 ──────────────────────
function findApproverLeader(childId: string): HttpConvAgent | null {
  let cur = childId;
  for (let i = 0; i < 10; i++) {
    const info = getState().agents.get(cur);
    if (!info?.parent) {
      // Reached root without finding a leader parent — PM is the fallback
      const root = agents.get("pm");
      return root instanceof HttpConvAgent ? root : null;
    }
    cur = info.parent;
    const parentAgent = agents.get(cur);
    const parentInfo = getState().agents.get(cur);
    if (parentAgent instanceof HttpConvAgent &&
        (parentInfo?.role === "Leader" || cur === "pm")) {
      return parentAgent;
    }
  }
  return null;
}

// ── 通用 Leader 启动函数（PM depth=0 和 Tech Lead depth≥1 共用）────────────
interface LeaderOpts {
  id: string;
  parentId?: string;
  goal?: string;
  model?: string;
  depth?: number;
  parentChain?: string[];
  dispatch?: Extract<TuiEvent, { type: "spawn" }>["dispatch"];
  resumedMemoryId?: string;
  promptFile?: string;      // "pm" for root, "leader" for tech leads
  firstMessage?: string;    // override initial LLM message (used when PM first starts)
  replyHook?: (text: string) => void; // called when message.to=user (Feishu bridge)
}

function killAgent(id: string, _reason = "interrupted"): void {
  killedAgents.add(id);
  agents.get(id)?.kill?.(); // clears queue, pops unresponded user msg, aborts HTTP
  abortAgent(id);           // clears pending approvals in store
  // Do NOT set state:err — httpAgent emits state:idle after AbortError,
  // which returns the agent to ready state so the user can resend immediately.
}

// ── 飞书桥接 ───────────────────────────────────────────────────────────────
// Starts the Feishu WebSocket and routes messages to per-user PM sessions.
// Safe to call from both useEffect (auto-startup) and /feishu command (runtime).
function connectFeishu(appId: string, appSecret: string): void {
  if (feishuConnected) {
    applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
      text: "⚡ 飞书 WebSocket 已在运行中，无需重复连接。" } as TuiEvent);
    return;
  }
  feishuConnected = true;
  process.env.FEISHU_APP_ID = appId;
  process.env.FEISHU_APP_SECRET = appSecret;
  const tokenManager = new TokenManager();
  const cfg = loadConfig();
  startFeishuWebSocket({
    appId,
    appSecret,
    onStatus: (msg: string) => {
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
        text: `[飞书WS] ${msg}` } as TuiEvent);
    },
    onMessage: (openId: string, text: string, chatId: string, chatType: string) => {
      const pmId = `feishu-${crypto.createHash("sha256").update(openId).digest("hex").slice(0, 8)}`;
      // For group chats reply to the chat; for p2p reply to the user's open_id
      const replyId   = chatType === 'group' ? chatId : openId;
      const replyType = chatType === 'group' ? 'chat_id' : 'open_id';
      if (!feishuSessions.has(openId)) {
        feishuSessions.set(openId, pmId);
        ensureAgent({ id: pmId, name: `飞书:${openId.slice(-4)}`, role: "Leader", state: "idle",
          sub: "飞书会话", model: cfg.agents.leader.model });
        userMessage(pmId, text);
        startLeaderAgent({
          id: pmId,
          firstMessage: text,
          promptFile: "pm",
          replyHook: (replyText: string) => {
            sendTextMessage(replyId, replyType as 'open_id' | 'chat_id', replyText, tokenManager)
              .catch((err) => {
                process.stderr.write(`[FeishuBridge] 回复失败 ${openId.slice(-6)}: ${err instanceof Error ? err.message : String(err)}\n`);
              });
          },
        });
      } else {
        const existingPmId = feishuSessions.get(openId)!;
        const a = agents.get(existingPmId);
        if (a instanceof HttpConvAgent) {
          userMessage(existingPmId, text);
          killedAgents.delete(existingPmId);
          markPendingInput(existingPmId);
          a.sendCommand({ type: "user.message", text });
        } else {
          // PM finished — start a fresh session
          feishuSessions.delete(openId);
          // Re-enter this branch as a new session on next tick
          setImmediate(() => {
            // Synthetic re-dispatch: create new PM for the returning user
            const newPmId = `feishu-${crypto.createHash("sha256").update(openId + Date.now()).digest("hex").slice(0, 8)}`;
            feishuSessions.set(openId, newPmId);
            ensureAgent({ id: newPmId, name: `飞书:${openId.slice(-4)}`, role: "Leader", state: "idle",
              sub: "飞书会话", model: cfg.agents.leader.model });
            userMessage(newPmId, text);
            startLeaderAgent({
              id: newPmId, firstMessage: text, promptFile: "pm",
              replyHook: (replyText: string) => {
                sendTextMessage(replyId, replyType as 'open_id' | 'chat_id', replyText, tokenManager)
                  .catch((err) => {
                    process.stderr.write(`[FeishuBridge] 回复失败 ${openId.slice(-6)}: ${err instanceof Error ? err.message : String(err)}\n`);
                  });
              },
            });
          });
        }
      }
    },
  }).catch((err: unknown) => {
    feishuConnected = false; // allow retry after failure
    applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
      text: `❌ 飞书 WebSocket 连接失败: ${err instanceof Error ? err.message : String(err)}` } as TuiEvent);
    process.stderr.write(`[FeishuWS] 启动失败: ${err instanceof Error ? err.message : String(err)}\n`);
  });
}

function startLeaderAgent(opts: LeaderOpts): void {
  if (DEMO && !opts.parentId) { return runDemo(opts.firstMessage ?? "demo"); }
  if (agents.has(opts.id)) return;

  const cfg = loadConfig();
  const model = opts.model ?? cfg.agents.leader.model ?? MODEL;
  const isRoot = !opts.parentId;
  const promptFile = opts.promptFile ?? (isRoot ? "pm" : "leader");

  // Compute depth and parent chain from store when not provided
  const depth = opts.depth ?? (() => {
    if (isRoot) return 0;
    let d = 0; let cur = opts.parentId!;
    for (let i = 0; i < 10; i++) {
      const info = getState().agents.get(cur);
      if (!info?.parent) break; d++; cur = info.parent;
    }
    return d + 1;
  })();

  const parentChain: string[] = opts.parentChain ?? (() => {
    if (isRoot) return [];
    const chain: string[] = [];
    let cur = opts.parentId!;
    for (let i = 0; i < 10; i++) {
      chain.unshift(cur);
      const info = getState().agents.get(cur);
      if (!info?.parent) break;
      cur = info.parent;
    }
    return chain;
  })();

  const systemPrompt = buildSystemPrompt("Leader", opts.id, opts.goal, opts.resumedMemoryId, promptFile);
  const a = new HttpConvAgent({
    id: opts.id,
    role: "Leader",
    providerCfg: { ...cfg.agents.leader, model },
    systemPrompt,
    resumeFrom: opts.resumedMemoryId,
  });
  agents.set(opts.id, a);

  // Secretary — always auto-created alongside this Leader, lifecycle-bound
  const existingMem = opts.resumedMemoryId ? loadMemory(opts.id) : null;
  const mem = existingMem ?? createMemory({
    agentId: opts.id,
    agentType: isRoot ? "PM" : "LEADER",
    parentChain,
    depth,
    model,
    roleName: isRoot ? "PM" : "Leader",
    dispatch: opts.dispatch ?? {
      background: opts.goal ?? (isRoot ? "Root PM orchestrator" : "Leader orchestrator"),
      constraints: [],
      acceptance_criteria: [],
      stop_conditions: ["user.quit"],
    },
  });
  const secretary = new SecretaryProxy(mem);
  secretaries.set(opts.id, secretary);

  // Per-turn state
  const toolQueue: Array<Extract<TuiEvent, { type: "tool.call" }>> = [];
  let actedThisTurn = false;
  let continuations = 0;
  let gaveUp = false;
  let nudgePending = false; // true when the next run turn is a system-initiated nudge
  let sentToUserThisTurn = false; // true when PM sent message.to=user this turn

  // Quality tracking — emitted as structured stderr log on agent.done
  let qualTurns = 0;
  let qualNudges = 0;
  let qualHandup = false;

  a.on("event", (e: TuiEvent) => {
    // Spawn — pre-check then dispatch to correct handler
    if (e.type === "spawn") {
      const parentRole = getState().agents.get(e.parent)?.role;
      const check = pm.preCheckSpawn(e, parentRole);
      if (!check.ok) {
        applyEvent({ v: 1, type: "agent.error", agent: e.parent, code: check.code, detail: check.detail });
        return;
      }
      actedThisTurn = true;
      applyEvent(e);
      pm.observe(e);
      secretary.observe(e);
      // Register auto-background spawn (foreground tracking)
      if (pm.registerSpawn) pm.registerSpawn(e.child, e.parent);
      startWorker(e); // routes Leader role to startLeaderAgent internally
      return;
    }

    if (e.type === "agent.error") {
      applyEvent(e); pm.observe(e); secretary.observe(e);
      return;
    }

    // PM can kill a child agent via protocol — same effect as ESC on that pane
    if (e.type === "agent.kill") {
      const targetState = getState().agents.get(e.target)?.state;
      if (targetState === "run" || targetState === "idle") {
        killAgent(e.target, e.reason ?? "killed by parent");
        applyEvent({ v: 1, type: "message", agent: opts.id, to: "user",
          text: `⏹ ${opts.id} killed ${e.target}${e.reason ? ": " + e.reason : ""}` });
      }
      return;
    }

    if (e.type === "message" && !checkMessageLegal(e)) return;

    // Approve/reject destructive Bash from a child agent
    if (e.type === "tool.approved" || e.type === "tool.rejected") {
      const pending = leaderApprovalQueue.get(e.id);
      if (pending) {
        leaderApprovalQueue.delete(e.id);
        if (e.type === "tool.approved") {
          executeTool(pending.toolName, pending.toolArgs).then((r) => {
            applyEvent({ v: 1, type: "tool.result", agent: pending.workerChildId, id: e.id, ok: r.ok, output: r.output });
            pending.workerAgent.sendCommand({ type: "tool.result", id: e.id, ok: r.ok, output: r.output });
          });
        } else {
          const reason = e.reason ?? "leader rejected";
          applyEvent({ v: 1, type: "tool.result", agent: pending.workerChildId, id: e.id, ok: false, output: `Rejected: ${reason}` });
          pending.workerAgent.sendCommand({ type: "tool.result", id: e.id, ok: false, output: `Rejected: ${reason}` });
        }
      }
      return;
    }

    applyEvent(e);
    pm.observe(e);
    secretary.observe(e);

    if (e.type === "agent.state" && e.state === "run") {
      actedThisTurn = false;
      sentToUserThisTurn = false;
      if (!nudgePending) { continuations = 0; gaveUp = false; }
      else qualNudges++; // nudgePending=true means this run was system-initiated
      nudgePending = false;
      qualTurns++;
    }

    if (e.type === "tool.call") {
      actedThisTurn = true;
      if (!toolNeedsApproval(e.name, e.args as Record<string, unknown>)) {
        toolQueue.push(e);
      } else {
        // Destructive tool: Leaders route to parent for approval; root PM has no parent
        // so send an error result immediately instead of silently dropping the call.
        // Without this, PM waits forever for a result that never comes.
        setImmediate(() => {
          applyEvent({ v: 1, type: "tool.result", agent: opts.id, id: e.id, ok: false,
            output: `Tool "${e.name}" requires approval. Root leader has no parent to approve — use a non-destructive alternative or rephrase the command.` });
          a.sendCommand({ type: "tool.result", id: e.id, ok: false,
            output: `Tool "${e.name}" requires approval. Root leader has no parent to approve — use a non-destructive alternative or rephrase the command.` });
        });
      }
    }

    if (e.type === "message") {
      actedThisTurn = true;
      if (e.to === "user") {
        sentToUserThisTurn = true;
        if (opts.replyHook) opts.replyHook(e.text);
      }
      if (e.to !== "user") {
        const target = agents.get(e.to);
        if (target instanceof HttpConvAgent) {
          target.sendCommand({ type: "user.message", text: `[${opts.id}] ${e.text}` });
        } else {
          a.sendCommand({
            type: "user.message",
            text: `[系统] 消息无法送达：agent "${e.to}" 不存在或已结束。请重新 spawn，或 message→user 说明情况。`,
          });
        }
      }
    }

    if (e.type === "agent.done") {
      actedThisTurn = true;
      const tok = getState().tokensByAgent.get(opts.id);
      const rejects = (getState().messagesByAgent.get(opts.id) ?? [])
        .filter((m) => m.kind === "tool_result" && m.text.startsWith("Tool rejected")).length;
      const score = Math.max(0, Math.min(100,
        100
        - qualNudges * 8
        - (gaveUp ? 25 : 0)
        - (qualHandup ? 15 : 0)
        - (e.success ? 0 : 20)
        - rejects * 10
        + (e.evidence?.length ? 10 : 0)
        + (qualNudges === 0 ? 10 : 0)
      ));
      const sessionHash = mem.session_hash ?? "?";
      process.stderr.write(
        `[quality] ${opts.id} session=${sessionHash} score=${score}` +
        ` success=${e.success} turns=${qualTurns} nudges=${qualNudges}` +
        ` handup=${qualHandup} gaveUp=${gaveUp} rejects=${rejects}` +
        ` tokens_in=${tok?.prompt ?? 0} tokens_out=${tok?.completion ?? 0}` +
        ` evidence=${e.evidence?.length ?? 0}\n`,
      );
      // Only ask for human rating on root PM sessions (not every sub-leader)
      if (!opts.parentId) setPendingRating(opts.id, sessionHash);
    }
    // Tech Lead completion — notify parent PM + ingest memory upward
    if (e.type === "agent.done" && opts.parentId) {
      const pmSec = secretaries.get("pm");
      if (pmSec) pmSec.ingestChildMemory(secretary.getMemory() as any);
      const parentAgent = agents.get(opts.parentId);
      // Don't wake a killed/finished parent — child completion should not restart it
      if (killedAgents.has(opts.parentId)) return;
      const parentState = getState().agents.get(opts.parentId)?.state;
      if (parentState === "done") return;
      if (parentAgent instanceof HttpConvAgent) {
        if (e.success) {
          const evidenceLines = e.evidence?.length
            ? "\n证据:\n" + e.evidence.map((s) => `  - ${s}`).join("\n") : "";
          parentAgent.sendCommand({
            type: "user.message",
            text: `[系统] ${opts.id} 成功完成${e.reason ? ": " + e.reason : ""}。${evidenceLines}\n请继续推进你的任务。`,
          });
        } else {
          parentAgent.sendCommand({
            type: "user.message",
            text: `[系统-失败] ${opts.id} 任务失败${e.reason ? ": " + e.reason : ""}。\n请立即 message→user 说明情况，并提供选项：\n① 重试 ② 换策略 ③ 放弃 ④ 人工介入`,
          });
        }
      }
      deleteAgentMemory(opts.id);
    }

    if (e.type === "unit.handup") qualHandup = true;

    // unit.handup — forward to parent
    if (e.type === "unit.handup" && opts.parentId) {
      const parentAgent = agents.get(opts.parentId);
      if (parentAgent instanceof HttpConvAgent) {
        const findingLines = e.findings?.length
          ? "\n发现:\n" + e.findings.map((f) => `  [${f.level}] ${f.text}`).join("\n") : "";
        const failedLines = e.failed_acceptance?.length
          ? "\n未达成: " + e.failed_acceptance.join("; ") : "";
        parentAgent.sendCommand({
          type: "user.message",
          text: `[${opts.id} handup] 已完成: ${e.summary}${failedLines}${findingLines}`,
        });
      }
    }

    // Idle — drain tool queue or nudge
    if (e.type === "agent.state" && e.state === "idle") {
      if (getState().agents.get(opts.id)?.state === "done") return;
      if (toolQueue.length > 0) {
        const batch = toolQueue.splice(0);
        setImmediate(async () => {
          const results = await Promise.all(batch.map((c) => executeTool(c.name, c.args)));
          for (let i = 0; i < batch.length; i++) {
            const { id } = batch[i]!;
            const { ok, output } = results[i]!;
            applyEvent({ v: 1, type: "tool.result", agent: opts.id, id, ok, output });
          }
        });
      } else if (actedThisTurn) {
        const todos = getState().todosByAgent.get(opts.id) ?? [];
        const hasRun = todos.some((t) => t.state === "run");
        const hasTodo = todos.some((t) => t.state === "todo");
        // If children are actively running, PM should wait silently — nudging causes
        // PM to reply "waiting for feedback" which burns continuations for nothing.
        const activeChildren = Array.from(getState().agents.values())
          .filter((ag) => ag.parent === opts.id && (ag.state === "run" || ag.state === "idle"));
        if (activeChildren.length > 0) {
          // PM has delegated work; wait for agent.done to come back before doing anything
        } else if (hasRun && !hasTodo) {
          // All items are "run" with nothing pending → auto-close
          const closed = todos.map((t) => ({ ...t, state: t.state === "run" ? "done" : t.state }));
          applyEvent({ v: 1, type: "todo.set", agent: opts.id, items: closed as any });
        } else if (hasTodo && sentToUserThisTurn) {
          // PM already delivered final report and has no active children —
          // stale todos are a known PM protocol bug. Auto-close to stop the loop.
          const closed = todos.map((t) => ({ ...t, state: (t.state === "run" || t.state === "todo") ? "done" : t.state }));
          applyEvent({ v: 1, type: "todo.set", agent: opts.id, items: closed as any });
        } else if (hasTodo && continuations < 3) {
          // Agent replied/acted but still has pending todos — nudge it to continue
          continuations++;
          const pendingTodos = todos.filter((t) => t.state === "todo").map((t) => t.text).join("; ");
          nudgePending = true;
          setImmediate(() => {
            a.sendCommand({
              type: "user.message",
              text: `【系统-自检】你回复了用户但 todo 列表仍有未完成项：${pendingTodos}。\n立刻输出 step + tool.call 执行第一步，不允许回复完就停止。`,
            });
          });
        } else if (hasTodo) {
          gaveUp = true;
          const pendingTodos = todos.filter((t) => t.state === "todo").map((t) => t.text).join("; ");
          applyEvent({
            v: 1, type: "message", agent: opts.id, to: "user",
            text: `⚠ ${opts.id} 回复后 3 次推进仍停滞。未完成项：${pendingTodos}。\n请选择：① 重试  ② 换策略  ③ 放弃`,
          });
        } else if (!hasRun && !hasTodo && continuations < 3) {
          // Agent replied (e.g. after resume) but emitted no todo.set and has no children.
          // Without a todo list the system has no signal to nudge — force one.
          continuations++;
          nudgePending = true;
          setImmediate(() => {
            a.sendCommand({
              type: "user.message",
              text: `【系统】你回复了但没有输出 todo.set。立刻输出 todo.set 列出当前计划，然后执行第一步。`,
            });
          });
        }
      } else if (!actedThisTurn && !gaveUp) {
        const todos = getState().todosByAgent.get(opts.id) ?? [];
        const hasPending = todos.some((t) => t.state === "todo" || t.state === "run");
        // Same guard: if children are running, no nudge needed — they'll call back when done
        const activeChildren2 = Array.from(getState().agents.values())
          .filter((ag) => ag.parent === opts.id && (ag.state === "run" || ag.state === "idle"));
        if (hasPending && activeChildren2.length > 0) {
          // waiting for children — do nothing
        } else if (hasPending && continuations < 3) {
          continuations++;
          nudgePending = true;
          setImmediate(() => {
            a.sendCommand({ type: "user.message", text: `【系统】你有未完成的 todo。立刻执行下一步：输出 step + tool.call 或 spawn，不要只规划。` });
          });
        } else if (hasPending) {
          gaveUp = true;
          const pendingTodos = todos.filter((t) => t.state === "todo" || t.state === "run").map((t) => t.text).join("; ");
          if (opts.parentId) {
            const parentAgent = agents.get(opts.parentId);
            if (parentAgent instanceof HttpConvAgent) {
              parentAgent.sendCommand({
                type: "user.message",
                text: `[系统-卡住] ${opts.id} 经过 3 次推进仍无有效行动。未完成项：${pendingTodos}。\n请立即 message→user 说明情况。`,
              });
            }
          } else {
            applyEvent({
              v: 1, type: "message", agent: opts.id, to: "user",
              text: `⚠ ${opts.id} 经过 3 次推进仍无有效行动。未完成项：${pendingTodos}。\n请选择：\n① 重试 — 输入新指令\n② 换策略 — 描述新方法\n③ 放弃 — 结束当前任务`,
            });
          }
        } else if (continuations < 2) {
          // PM processed a message but produced no output (no message, tool.call, or spawn)
          // and has no pending todos. Nudge it to actually reply.
          continuations++;
          nudgePending = true;
          setImmediate(() => {
            a.sendCommand({
              type: "user.message",
              text: "【系统-回复缺失】你刚才处理了消息但没有输出任何内容（无 message、无 tool.call、无 spawn）。请立刻 message→user 回复用户，或说明你在等待什么。",
            });
          });
        } else {
          continuations = 0;
        }
      }
    }
  });

  secretary.on("event", (e: TuiEvent) => applyEvent(e));

  a.on("_raw_message", (m: { role: "user" | "assistant"; content: string }) => {
    secretary.observeMessage(m.role, m.content);
  });

  // Set depth in store for non-root leaders
  if (!isRoot) {
    updateAgentInfo(opts.id, { depth, model });
  }

  // Build and send initial message
  let initMsg = opts.firstMessage;
  if (!initMsg) {
    if (opts.goal && opts.dispatch) {
      const parts: string[] = [`任务目标：${opts.goal}`];
      if (opts.dispatch.background) parts.push(`背景：${opts.dispatch.background}`);
      if (opts.dispatch.constraints?.length) parts.push(`约束：${opts.dispatch.constraints.join("；")}`);
      if (opts.dispatch.acceptance_criteria?.length) parts.push(`验收标准：${opts.dispatch.acceptance_criteria.join("；")}`);
      initMsg = parts.join("\n");
    } else {
      initMsg = opts.goal ?? "等待用户指令";
    }
  }
  a.sendCommand({ type: "user.message", text: initMsg });
}

function startWorker(e: Extract<TuiEvent, { type: "spawn" }>): void {
  if (agents.has(e.child)) return;

  // Leader role: delegate to startLeaderAgent (Tech Lead pattern)
  if (e.role === "Leader") {
    const parentInfo = getState().agents.get(e.parent);
    const parentDepth = parentInfo?.depth ?? 0;
    const parentChain: string[] = [];
    let cur = e.parent;
    for (let i = 0; i < 10; i++) {
      parentChain.unshift(cur);
      const info = getState().agents.get(cur);
      if (!info?.parent) break;
      cur = info.parent;
    }
    startLeaderAgent({
      id: e.child,
      parentId: e.parent,
      goal: e.goal,
      // Tech Lead always uses the configured leader model — ignore whatever
      // the LLM put in the spawn JSON (models may hallucinate claude model names)
      model: undefined,
      depth: parentDepth + 1,
      parentChain,
      dispatch: e.dispatch,
      promptFile: "leader",
    });
    return;
  }

  const cfg = loadConfig();
  const workerModel = e.model ?? cfg.agents.worker.model;
  if (!workerModel) {
    applyEvent({ v: 1, type: "agent.error", agent: e.parent,
      code: "no_worker_model", detail: "No model configured for worker — use /connect worker <preset> <model> <key>" });
    return;
  }
  const workerProviderCfg = { ...cfg.agents.worker, ...(e.model ? { model: e.model } : {}) };

  // Compute parent depth for child's memory
  const parentDepth = getState().agents.get(e.parent) ?
    (() => {
      let d = 0; let c = e.parent;
      for (let i = 0; i < 10; i++) {
        const info = getState().agents.get(c);
        if (!info?.parent) break; d++; c = info.parent;
      }
      return d;
    })() : 0;

  // Build parent chain
  const parentChain: string[] = [];
  let cur = e.parent;
  for (let i = 0; i < 10; i++) {
    const info = getState().agents.get(cur);
    if (!info) break;
    parentChain.unshift(cur);
    if (!info.parent) break;
    cur = info.parent;
  }

  const systemPrompt = buildSystemPrompt(e.role, e.child, e.goal);
  const a = new HttpConvAgent({ id: e.child, role: e.role, providerCfg: workerProviderCfg, systemPrompt });
  agents.set(e.child, a);

  // S2: Secretary for this Worker
  const dispatch = e.dispatch ?? {
    background: e.goal,
    constraints: [],
    acceptance_criteria: ["agent.done"],
    stop_conditions: ["agent.done"],
  };
  const mem = createMemory({
    agentId: e.child,
    agentType: e.role === "Secretary" ? "SECRETARY" : "WORKER",
    parentChain,
    depth: parentDepth + 1,
    model: workerModel,
    roleName: e.role,
    dispatch,
  });
  const secretary = new SecretaryProxy(mem);
  secretaries.set(e.child, secretary);

  // Pending tool calls emitted during one send() round — batched and executed on idle
  const toolQueue: Array<Extract<TuiEvent, { type: "tool.call" }>> = [];
  let workerActedThisTurn = false;
  let workerContinuations = 0;
  let workerGaveUp = false;
  let workerCorrectedThisTurn = false; // deduplicate illegal_message corrections per turn
  let workerNudgePending = false; // true when the next run turn is a system-initiated nudge

  // Quality tracking for worker
  let wQualTurns = 0;
  let wQualNudges = 0;
  let wQualHandup = false;

  a.on("event", (ev: TuiEvent) => {
    // spawn: pre-check BEFORE applyEvent to prevent ghost agents in store
    if (ev.type === "spawn") {
      const parentRole = getState().agents.get(ev.parent)?.role;
      const check = pm.preCheckSpawn(ev, parentRole);
      if (!check.ok) {
        applyEvent({ v: 1, type: "agent.error", agent: ev.parent, code: check.code, detail: check.detail });
        return;
      }
      workerActedThisTurn = true;
      applyEvent(ev);
      pm.observe(ev);
      secretary.observe(ev);
      startWorker(ev);
      return;
    }

    // Mirror agent.error from child to parent — UI + parent LLM
    if (ev.type === "agent.error") {
      applyEvent(ev);
      pm.observe(ev);
      secretary.observe(ev);
      const parentAgent = agents.get(e.parent);
      if (parentAgent instanceof HttpConvAgent) {
        parentAgent.sendCommand({
          type: "user.message",
          text: `[系统-错误] ${e.child} 发生错误 [${ev.code}]${ev.detail ? ": " + ev.detail : ""}。\n请立即 message→user 说明情况，并提供选项让用户选择：\n① 重试（重新 spawn 同目标 worker）\n② 换策略（spawn 新 worker 用不同方法）\n③ 放弃该子任务，继续其他工作\n④ 人工介入（请用户手动操作后告知你）`,
        });
      }
      return;
    }

    // Block illegal messages before they reach the store
    if (ev.type === "message") {
      const senderRole = getState().agents.get(ev.agent)?.role;
      const recipientRole = ev.to !== "user" ? getState().agents.get(ev.to)?.role : undefined;
      const isWorkerToUser = senderRole === "Worker" && ev.to === "user";
      const isWorkerToWorker = senderRole === "Worker" && recipientRole === "Worker";
      if (isWorkerToUser || isWorkerToWorker) {
        workerActedThisTurn = true; // prevent auto-continuation nudge loop
        // Auto-forward to parent so the report is never lost, then correct.
        const parentAgent = agents.get(e.parent);
        if (parentAgent instanceof HttpConvAgent) {
          const redirected = { ...ev, to: e.parent } as typeof ev;
          applyEvent(redirected);      // store as worker→parent (visible in both panes)
          parentAgent.sendCommand({
            type: "user.message",
            text: `[${e.child}→${e.parent}] ${ev.text}`,
          });
        }
        if (!workerCorrectedThisTurn) {
          workerCorrectedThisTurn = true;
          applyEvent({
            v: 1, type: "agent.error", agent: ev.agent, code: "illegal_message",
            detail: `Worker ${ev.agent} message.to=${ev.to} 违规 — 已自动转发至 ${e.parent} 并纠正。`,
          });
          pm.observe(ev);
          setImmediate(() => {
            a.sendCommand({
              type: "user.message",
              text: `[系统-纠正] message.to=${ev.to} 违规已被自动转发至 ${e.parent}。下次请直接使用 message.to=${e.parent}，然后 agent.done。`,
            });
          });
        }
        return;
      }
    }
    applyEvent(ev);
    pm.observe(ev);
    secretary.observe(ev);

    // ── Forward worker→parent communication to the parent LLM ────────────────
    // Without this, leader spawns a worker but never hears back — hangs forever.
    if (ev.type === "message" && ev.to === e.parent) {
      const parentAgent = agents.get(e.parent);
      if (parentAgent instanceof HttpConvAgent) {
        parentAgent.sendCommand({
          type: "user.message",
          text: `[${e.child}→${e.parent}] ${ev.text}`,
        });
      }
    }
    if (ev.type === "agent.state" && ev.state === "run") {
      if (workerNudgePending) wQualNudges++;
      wQualTurns++;
    }
    if (ev.type === "unit.handup") wQualHandup = true;
    if (ev.type === "agent.done") {
      workerActedThisTurn = true;
      const wTok = getState().tokensByAgent.get(e.child);
      const wScore = Math.max(0, Math.min(100,
        100
        - wQualNudges * 8
        - (workerGaveUp ? 25 : 0)
        - (wQualHandup ? 15 : 0)
        - (ev.success ? 0 : 20)
        + (ev.evidence?.length ? 10 : 0)
        + (wQualNudges === 0 ? 10 : 0)
      ));
      process.stderr.write(
        `[quality] ${e.child} session=${mem.session_hash ?? "?"} score=${wScore}` +
        ` success=${ev.success} turns=${wQualTurns} nudges=${wQualNudges}` +
        ` handup=${wQualHandup} gaveUp=${workerGaveUp}` +
        ` tokens_in=${wTok?.prompt ?? 0} tokens_out=${wTok?.completion ?? 0}` +
        ` evidence=${ev.evidence?.length ?? 0}\n`,
      );
      const parentAgent = agents.get(e.parent);
      // Don't wake a killed/finished parent
      if (killedAgents.has(e.parent)) return;
      const parentSt = getState().agents.get(e.parent)?.state;
      if (parentSt !== "done" && parentAgent instanceof HttpConvAgent) {
        if (ev.success) {
          const evidenceLines = ev.evidence?.length
            ? "\n证据:\n" + ev.evidence.map((s) => `  - ${s}`).join("\n")
            : "";
          parentAgent.sendCommand({
            type: "user.message",
            text: `[系统] ${e.child} 成功完成${ev.reason ? ": " + ev.reason : ""}。${evidenceLines}\n请继续推进你的任务。`,
          });
        } else {
          parentAgent.sendCommand({
            type: "user.message",
            text: `[系统-失败] ${e.child} 任务失败${ev.reason ? ": " + ev.reason : ""}。\n请立即 message→user 说明情况，并提供选项让用户选择：\n① 重试（重新 spawn 同目标 worker）\n② 换策略（spawn 新 worker 用不同方法）\n③ 放弃该子任务，继续其他工作\n④ 人工介入（请用户手动操作后告知你）`,
          });
        }
      }
      deleteAgentMemory(e.child);
    }
    if (ev.type === "unit.handup") {
      const parentAgent = agents.get(e.parent);
      if (parentAgent instanceof HttpConvAgent) {
        const findingLines = ev.findings?.length
          ? "\n发现（按级别）:\n" + ev.findings.map((f) => `  [${f.level}] ${f.text}`).join("\n")
          : "";
        const failedLines = ev.failed_acceptance?.length
          ? "\n未达成: " + ev.failed_acceptance.join("; ")
          : "";
        parentAgent.sendCommand({
          type: "user.message",
          text: `[${e.child} handup] 已完成: ${ev.summary}${failedLines}${findingLines}`,
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Track turn start
    if (ev.type === "agent.state" && ev.state === "run") {
      workerActedThisTurn = false;
      workerCorrectedThisTurn = false;
      if (!workerNudgePending) { workerContinuations = 0; workerGaveUp = false; }
      workerNudgePending = false;
    }

    // Registry is the authority for needsApproval — prevents agent from forging false.
    // Destructive Bash commands are routed to leader instead of asking user directly.
    if (ev.type === "tool.call") {
      workerActedThisTurn = true;
      const mustApprove = toolNeedsApproval(ev.name, ev.args as Record<string, unknown>);
      if (!mustApprove) {
        toolQueue.push(ev);
      } else {
        const cmd = typeof ev.args === "object" && ev.args !== null
          ? String((ev.args as Record<string, unknown>).command ?? (ev.args as Record<string, unknown>).cmd ?? "")
          : "";
        const approverAgent = findApproverLeader(e.child);
        const approverId = getState().agents.get(e.parent)?.id ?? e.parent;
        if (approverAgent) {
          leaderApprovalQueue.set(ev.id, {
            workerAgent: a, toolName: ev.name, toolArgs: ev.args, workerChildId: e.child,
          });
          approverAgent.sendCommand({
            type: "user.message",
            text: `[系统-Bash审批 id=${ev.id}] ${e.child} 请求执行破坏性命令（goal: ${e.goal}）:\n\`${cmd}\`\n\n如在 goal 边界内，回复:\n{"v":1,"type":"tool.approved","id":"${ev.id}"}\n否则:\n{"v":1,"type":"tool.rejected","id":"${ev.id}","reason":"越界原因"}`,
          });
        } else {
          applyEvent({ v: 1, type: "tool.result", agent: e.child, id: ev.id, ok: false, output: `No approver leader found for ${approverId}` });
          a.sendCommand({ type: "tool.result", id: ev.id, ok: false, output: `No approver leader found for ${approverId}` });
        }
      }
    }

    // Sending a message counts as acting — same logic as in startLeader.
    if (ev.type === "message") {
      workerActedThisTurn = true;
    }

    // Agent 变 idle → 批量执行排队的工具并把结果回喂给 agent
    if (ev.type === "agent.state" && ev.state === "idle") {
      if (getState().agents.get(e.child)?.state === "done") return;
      if (toolQueue.length > 0) {
        const batch = toolQueue.splice(0);
        setImmediate(async () => {
          const results = await Promise.all(batch.map((c) => executeTool(c.name, c.args)));
          for (let i = 0; i < batch.length; i++) {
            const { id } = batch[i]!;
            const { ok, output } = results[i]!;
            applyEvent({ v: 1, type: "tool.result", agent: e.child, id, ok, output });
          }
          const combined = batch.map((c, i) =>
            `[tool_result id="${c.id}" ok="${results[i]!.ok}"]\n${results[i]!.output}`
          ).join("\n\n");
          a.sendCommand({ type: "tool.result", id: batch[0]!.id, ok: true, output: combined });
        });
        // Worker acted but may still have pending todos — auto-close or nudge
        const todos = getState().todosByAgent.get(e.child) ?? [];
        const hasRun  = todos.some((t) => t.state === "run");
        const hasTodo = todos.some((t) => t.state === "todo");
        if (hasRun && !hasTodo) {
          const closed = todos.map((t) => ({ ...t, state: t.state === "run" ? "done" : t.state }));
          applyEvent({ v: 1, type: "todo.set", agent: e.child, items: closed as any });
        } else if (hasTodo && workerContinuations < 3) {
          workerContinuations++;
          const pendingTodos = todos.filter((t) => t.state === "todo").map((t) => t.text).join("; ");
          workerNudgePending = true;
          setImmediate(() => {
            a.sendCommand({
              type: "user.message",
              text: `【系统-自检】你执行了部分操作但 todo 列表仍有未完成项：${pendingTodos}。立刻继续执行下一步：输出 step + tool.call。`,
            });
          });
        }
      } else if (!workerActedThisTurn && !workerGaveUp) {
        // Worker planned but didn't act — nudge to continue
        const todos = getState().todosByAgent.get(e.child) ?? [];
        const hasPending = todos.some((t) => t.state === "todo" || t.state === "run");
        if (hasPending && workerContinuations < 3) {
          workerContinuations++;
          workerNudgePending = true;
          setImmediate(() => {
            a.sendCommand({ type: "user.message", text: "【系统】你有未完成的 todo。立刻执行下一步：输出 step + tool.call，不要只规划。" });
          });
        } else if (hasPending) {
          // 3 nudges failed — escalate to parent so leader can decide
          workerGaveUp = true;
          const pendingTodos = todos
            .filter((t) => t.state === "todo" || t.state === "run")
            .map((t) => t.text)
            .join("; ");
          const parentAgent = agents.get(e.parent);
          if (parentAgent instanceof HttpConvAgent) {
            parentAgent.sendCommand({
              type: "user.message",
              text: `[系统-卡住] ${e.child} 经过 3 次推进仍无有效行动，任务可能超出能力范围。未完成项：${pendingTodos}。\n请立即 message→user 说明情况，并提供选项：\n① 重试（重新 spawn 同目标 worker）\n② 换策略（spawn 新 worker 用不同方法）\n③ 放弃该子任务，继续其他工作\n④ 人工介入`,
            });
          }
        } else if (workerContinuations < 2) {
          // Worker processed a message but produced no output, and has no pending todos.
          workerContinuations++;
          workerNudgePending = true;
          setImmediate(() => {
            a.sendCommand({
              type: "user.message",
              text: "【系统-回复缺失】你处理了消息但没有任何输出。请立刻 message→parent 报告当前状态，或继续执行任务。",
            });
          });
        } else {
          workerContinuations = 0;
        }
      }
    }
  });

  secretary.on("event", (ev: TuiEvent) => applyEvent(ev));

  // S2: persist messages
  a.on("_raw_message", (m: { role: "user" | "assistant"; content: string }) => {
    secretary.observeMessage(m.role, m.content);
  });

  // Set depth and resolved model so AgentRow shows the actual model (not "{{WORKER_MODEL}}" or "?")
  updateAgentInfo(e.child, { depth: parentDepth + 1, model: workerModel });

  // Build initial message from goal + dispatch context so worker has full picture
  const dispatchCtx = e.dispatch;
  let initMsg = e.goal;
  if (dispatchCtx) {
    const parts: string[] = [`任务目标：${e.goal}`];
    if (dispatchCtx.background) parts.push(`背景：${dispatchCtx.background}`);
    if (dispatchCtx.constraints?.length) parts.push(`约束：${dispatchCtx.constraints.join("；")}`);
    if (dispatchCtx.acceptance_criteria?.length) parts.push(`验收标准：${dispatchCtx.acceptance_criteria.join("；")}`);
    initMsg = parts.join("\n");
  }
  // Inject parent TL's confirmed facts (Codex fork-spawn pattern):
  // Worker gets cross-task context without needing to re-read parent history.
  const parentSec = secretaries.get(e.parent);
  if (parentSec) {
    const parentFacts = parentSec.getMemory().working_set.facts.slice(-5);
    if (parentFacts.length > 0) {
      const factsBlock = parentFacts.map((f) => `  - ${f.text}`).join("\n");
      initMsg += `\n\n【父级已确认事实 (TL working_set)】\n${factsBlock}`;
    }
  }
  a.sendCommand({ type: "user.message", text: initMsg });

  // ── Auto-background: register foreground spawn for parent → child tracking ──
  const parentInfo = getState().agents.get(e.parent);
  // Only register foreground tracking if parent is a Leader/PM (not worker)
  if (parentInfo && parentInfo.role !== "Worker") {
    const handle = pm.registerSpawn(e.child, e.parent);
    // When the foreground promise resolves (30s sync or 2min bg switch):
    handle.promise.then((syncResult) => {
      if (syncResult === null) {
        // Switched to background: notify parent
        const parentAgent = agents.get(e.parent);
        if (parentAgent instanceof HttpConvAgent) {
          parentAgent.sendCommand({
            type: "user.message",
            text: `[系统] ${e.child} 已超过 2 分钟，自动切换为后台模式。完成时会通过 task-notification 通知你。`,
          });
        }
      }
      // If syncResult !== null, the 30s synchronous completion already happened
      // and the parent was notified directly inside agent.done handler.
    });
  }
}

// ── DEMO 模式 — 不调 claude,假发事件给你看 UI ──────────────────────────────
function runDemo(initialPrompt: string) {
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

function runTestSuite(suite: string): void {
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

function fmtKIndex(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

// ── App ─────────────────────────────────────────────────────────────────────
interface CmdDef {
  name: string;
  desc: string;
  handler: (args: string[]) => void;
}

function App() {
  const { exit } = useApp();
  const { stdin, isRawModeSupported } = useStdin();
  const [input, setInput] = useState("");

  const agentList = useStore((s) =>
    Array.from(s.agents.entries()).filter(([, a]) => !a.hidden).map(([id]) => id));
  const sel = useStore((s) => s.selectedAgent);
  const pending = useStore((s) => s.pendingApprovals);
  const [paletteName, setPaletteName] = useState<PaletteName>(loadConfig().palette);
  const palette = PALETTES[paletteName];
  const layout = useStore((s) => s.layout);
  const scrollOffset     = useStore((s) => s.scrollOffset);
  const agentPaneScroll  = useStore((s) => s.agentPaneScroll);
  const effort           = useStore((s) => s.effort);
  const [effortSelecting, setEffortSelecting] = useState(false);
  const [exitSecsLeft, setExitSecsLeft] = useState(0);
  const exitConfirm                     = exitSecsLeft > 0;
  const exitConfirmTimer                = useRef<ReturnType<typeof setInterval> | null>(null);
  const cmdHistory      = useRef<string[]>([]);
  const historyIdx      = useRef(-1);
  const browsingHistory = useRef(false);
  const completeTick    = useRef(0);
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(-1);

  // ── 消息队列 (agent busy 时暂存输入) ─────────────────────────────────────
  const msgQueue = useRef(new Map<string, string[]>());
  const [queueTick, setQueueTick] = useState(0);
  const bumpQueue = () => setQueueTick((t) => t + 1);

  // 当 agent 变成 idle 时，自动发出排队的消息
  const agentStates = useStore((s) =>
    Array.from(s.agents.entries()).map(([id, a]) => `${id}:${a.state}`).join(","),
  );
  useEffect(() => {
    const st = getState();
    let changed = false;
    for (const [agentId, msgs] of msgQueue.current.entries()) {
      const info = st.agents.get(agentId);
      if (info?.state === "idle" && msgs.length > 0) {
        const next = msgs.shift()!;
        const a = agents.get(agentId);
        if (a) a.sendCommand({ type: "user.message", text: next });
        changed = true;
      }
      if (msgs.length === 0) msgQueue.current.delete(agentId);
    }
    if (changed) bumpQueue();
  }, [agentStates]);

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
      process.stderr.write(
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
    { name: "resume",  desc: "/resume [agentId|hash] — resume from memory", handler: (args) => {
      const input = args[0] ?? "pm";
      const mem = loadMemory(input) ?? loadMemoryByHash(input);
      if (!mem) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: `未找到 "${input}" 的记忆。输入 /sessions 查看可用会话。` });
        return;
      }
      const id = mem.agent_id;
      agents.get(id)?.kill?.();
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
        process.stderr.write(`[resume] starting ${id} — firstMessage: "${resumeHint.slice(0, 200)}"\n`);
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
        startWorker(spawnEv);
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
        startWorker(spawnEv);
      }
    } },
    { name: "palette", desc: "切换配色 paper | green | amber", handler: (args) => { const name = args[0] as PaletteName; if (name && name in PALETTES) { setPaletteName(name); savePalette(name); } } },
    { name: "layout",  desc: "切换布局 v1 | v3",             handler: (args) => { const l = args[0]; if (l === "v1" || l === "v3") { setLayout(l); saveLayout(l); } } },
    { name: "log",     desc: "日志级别 debug | info | warn | error", handler: (args) => { const l = args[0] as LogLevel; if (["debug","info","warn","error"].includes(l)) setMinLevel(l); } },
    { name: "feishu", desc: "/feishu <app_id> <app_secret> — 连接飞书 WebSocket（无参数显示状态）", handler: (args) => {
      const [appId, appSecret] = args;
      if (!appId || !appSecret) {
        const status = feishuConnected ? "✅ 已连接" : "❌ 未连接";
        const sessions = feishuSessions.size;
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
    { name: "connect", desc: "/connect <role> <preset> <model> <apiKey> — preset: anthropic|deepseek|openai|ollama", handler: (args) => {
      const [role, preset, model, apiKey] = args;
      if (!role || !preset || !model || !apiKey) return;
      if (!["leader","secretary","worker"].includes(role)) return;
      const base = PROVIDER_PRESETS[preset] ?? { provider: "openai" as const, baseUrl: preset };
      const cfg: ProviderConfig = { ...base, model, apiKey };
      saveAgentConfig(role as "leader" | "secretary" | "worker", cfg);
      if (role === "leader") updateAgentInfo("pm", { model });
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
        text: `${role} 已连接 ${preset} / ${model} ✓`, } as TuiEvent);
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

  const runCommand = (cmd: string) => {
    const parts = cmd.slice(1).split(/\s+/);
    const head = parts[0]!;
    const c = COMMANDS.find((c) => c.name === head);
    if (c) c.handler(parts.slice(1));
  };

  const slashHead = input.startsWith("/") ? input.slice(1).split(/\s+/)[0]! : "";
  // slashMatches drives Tab completion — stays empty on bare "/" so Tab never
  // triggers completeTick++ (which remounts InputBar and drops the next keystroke).
  const slashMatches = slashHead
    ? COMMANDS.filter((c) => c.name.startsWith(slashHead))
    : [];
  // slashDisplay drives the visible dropdown — shows everything on bare "/"
  const slashDisplay = input === "/" ? COMMANDS : slashMatches;

  // Reset selection when the displayed list changes (user typed another char)
  const prevSlashKey = useRef("");
  const slashKey = slashDisplay.map((c) => c.name).join(",");
  if (prevSlashKey.current !== slashKey) {
    prevSlashKey.current = slashKey;
    if (slashSelectedIdx !== -1) setSlashSelectedIdx(-1);
  }

  const SLASH_MAX_VISIBLE = 8;
  const slashScrollStart = slashSelectedIdx < 0
    ? 0
    : Math.min(Math.max(0, slashSelectedIdx - SLASH_MAX_VISIBLE + 1),
               Math.max(0, slashDisplay.length - SLASH_MAX_VISIBLE));
  const slashVisible = slashDisplay.slice(slashScrollStart, slashScrollStart + SLASH_MAX_VISIBLE);
  // 1 separator + visible items + 1 "N more" line if truncated
  const slashPaneRows = slashDisplay.length > 0
    ? 1 + slashVisible.length + (slashDisplay.length > SLASH_MAX_VISIBLE ? 1 : 0)
    : 0;

  const pmStarted = useRef(false);

  const dispatchUser = (raw: string) => {
    const text = raw.trim();
    if (!text) return;

    if (text.startsWith("/")) {
      // Only treat as a slash command if the first word matches a known command.
      // Paths like /home/user/file.txt should pass through as regular messages.
      const head = text.slice(1).split(/\s+/)[0]!;
      if (COMMANDS.some((c) => c.name === head)) return runCommand(text);
    }

    let target = getState().selectedAgent;
    const m = text.match(/^@(\S+)\s+(.+)$/);
    let body = text;
    if (m) { target = m[1]!; body = m[2]!; selectAgent(target); }

    if (target === "pm" && !pmStarted.current) {
      userMessage("pm", body);
      pmStarted.current = true;
      startLeaderAgent({ id: "pm", firstMessage: body, promptFile: "pm" });
      return;
    }

    // New PM message: clear done agents and any pending rating from the previous task.
    if (target === "pm") { clearDoneAgents(); clearPendingRating(); }
    userMessage(target, body);
    const a = agents.get(target);
    if (!a) return;

    // Mark pending so the UI shows activity even if the agent is busy and
    // queues the message. Cleared automatically when agent.state:run fires.
    markPendingInput(target);

    // If user re-engages a killed agent, clear its killed status so dead-parent
    // guards don't block any child agents it spawns next.
    killedAgents.delete(target);

    // HttpConvAgent has its own internal _queue and drains one message per turn,
    // so we always call sendCommand immediately — no React-level blocking needed.
    a.sendCommand({ type: "user.message", text: body });
  };

  // 启动: 注册 PM + process-monitor 占位，检查未完成会话
  useEffect(() => {
    const cfg = loadConfig();
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "idle", sub: "waiting for first message", model: cfg.agents.leader.model });
    // process-monitor: visual representation of the TypeScript ProcessManager in the agent tree
    ensureAgent({ id: "process-monitor", name: "monitor", role: "Secretary", parent: "pm", state: "idle", sub: "", model: "internal" });

    // On startup: if there's an unfinished PM session, prompt the user to decide.
    // Do NOT auto-resume — the user may want to start a fresh session instead.
    const pmMem = loadMemory("pm");
    if (pmMem && pmMem.tombstone?.final_status === null && !pmStarted.current) {
      const hash = pmMem.session_hash ? pmMem.session_hash.slice(0, 8) : "?";
      const hint = (pmMem.tombstone.resume_hint ?? "(无记录)").slice(0, 120);
      const deadWorkers = listUnfinishedAgents()
        .filter((m) => m.parent_chain?.includes("pm") && m.agent_id !== "pm")
        .map((m) => m.agent_id);
      const deadNote = deadWorkers.length > 0
        ? `\n⚠ 上次存在子 agent：${deadWorkers.join(", ")}`
        : "";
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
        text: `🔔 检测到上次未完成的会话 (${hash})\n上次状态：${hint}${deadNote}\n\n/resume — 继续上次任务\n直接发消息 — 开始新会话（上次记录保留，可稍后 /resume）` });
    }

    // Auto-connect Feishu if credentials are present in .env
    const feishuAppId = process.env.FEISHU_APP_ID;
    const feishuAppSecret = process.env.FEISHU_APP_SECRET;
    if (feishuAppId && feishuAppSecret) {
      connectFeishu(feishuAppId, feishuAppSecret);
    }
  }, []);

  // 鼠标滚轮 + 粘贴处理:
  //   \x1b[?1000h\x1b[?1006h — SGR 鼠标上报
  //   \x1b[?2004h            — bracketed paste mode
  //
  // Monkey-patch process.stdin.emit so escape sequences are consumed BEFORE
  // Ink's input handler sees them (Ink would otherwise print them as garbage).
  //
  // Paste problem: in raw mode each \r/\n fires as Enter → only the last line
  // survives. Bracketed paste wraps content in \x1b[200~...\x1b[201~; we
  // collapse newlines to spaces. Long pastes can arrive in multiple chunks, so
  // we accumulate with a stateful buffer rather than hoping for a single chunk.
  //
  // X10 mouse fallback: if the terminal downgrades from SGR (\x1b[<...M) to
  // X10 format (\x1b[M + 3 raw bytes), strip those too.
  useEffect(() => {
    if (!isRawModeSupported) return;
    process.stdout.write("\x1b[?1000h\x1b[?1006h\x1b[?2004h");
    const MOUSE_SGR_RE = /\x1b\[<(\d+);(\d+);\d+[Mm]/g; // groups: btn, col
    // X10: \x1b[M + exactly 3 bytes (button, col, row — all offset by 32)
    const MOUSE_X10_RE = /\x1b\[M[\x00-\xff]{3}/g;

    // Stateful paste accumulator — handles paste split across data chunks
    let inPaste = false;
    let pasteBuf = "";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const origEmit = (process.stdin as any).emit as (...a: unknown[]) => boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdin as any).emit = function (event: string, ...args: unknown[]) {
      if (event === "data") {
        const chunk = args[0] as Buffer | string;
        const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        const utf8 = raw.toString("utf8");
        const bin  = raw.toString("binary"); // for ANSI escape matching

        // ── Bracketed paste ───────────────────────────────────────────────
        if (inPaste || utf8.includes("\x1b[200~")) {
          if (!inPaste) {
            // First chunk: skip past the opening marker
            pasteBuf = utf8.slice(utf8.indexOf("\x1b[200~") + 6);
            inPaste = true;
          } else {
            pasteBuf += utf8;
          }
          const endIdx = pasteBuf.indexOf("\x1b[201~");
          if (endIdx !== -1) {
            // End marker arrived — flush
            const pasted = pasteBuf.slice(0, endIdx).replace(/[\r\n]+/g, " ").trimEnd();
            inPaste = false;
            pasteBuf = "";
            if (!pasted) return false;
            return origEmit.call(process.stdin, event, Buffer.from(pasted, "utf8"));
          }
          // End marker not yet seen — swallow this chunk and wait for more
          return false;
        }

        // ── SGR mouse ─────────────────────────────────────────────────────
        MOUSE_SGR_RE.lastIndex = 0;
        let hasMouse = false;
        let m: RegExpExecArray | null;
        // AgentsPane occupies the leftmost ~22 columns (FIXED_COLS comment in ui.tsx)
        const AGENT_PANE_COLS = 23;
        while ((m = MOUSE_SGR_RE.exec(bin)) !== null) {
          hasMouse = true;
          const btn = m[1];
          const col = parseInt(m[2] ?? "999", 10);
          const isAgentPane = col <= AGENT_PANE_COLS;
          if (btn === "64") {
            // wheel up → scroll toward older/higher items
            if (isAgentPane) {
              const total = getState().agents.size;
              const maxVis = Math.max(3, Math.floor(Math.max(6, (process.stdout.rows ?? 24) - 5) / 3));
              scrollAgentBy(-1, total, maxVis);
            } else {
              scrollBy(3);
            }
          }
          if (btn === "65") {
            // wheel down → scroll toward newer/lower items
            if (isAgentPane) {
              const total = getState().agents.size;
              const maxVis = Math.max(3, Math.floor(Math.max(6, (process.stdout.rows ?? 24) - 5) / 3));
              scrollAgentBy(1, total, maxVis);
            } else {
              scrollBy(-3);
            }
          }
        }
        if (hasMouse) {
          const filtered = bin.replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, "");
          if (!filtered) return false;
          return origEmit.call(process.stdin, event, Buffer.from(filtered, "binary"));
        }

        // ── X10 mouse fallback ────────────────────────────────────────────
        if (MOUSE_X10_RE.test(bin)) {
          const filtered = bin.replace(MOUSE_X10_RE, "");
          if (!filtered) return false;
          return origEmit.call(process.stdin, event, Buffer.from(filtered, "binary"));
        }
      }
      return origEmit.call(process.stdin, event, ...args);
    };
    return () => {
      process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?2004l");
      inPaste = false; pasteBuf = "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdin as any).emit = origEmit;
    };
  }, [isRawModeSupported]);

  const EFFORT_DESC_SHORT: Record<Effort, string> = {
    min:  "PM 优先自理，仅复杂多文件任务才 spawn TL",
    mid:  "默认平衡，对话/单文件自理，其余 spawn TL",
    high: "激进派发，任何工具调用都优先 spawn TL",
    max:  "全双工，spawn 后立即回待命，不等 TL 完成",
  };

  const confirmEffort = (e: Effort) => {
    setEffort(e);
    setEffortSelecting(false);
    // Notify PM so it can adjust spawning strategy immediately
    const pm = agents.get("pm");
    if (pm) {
      pm.sendCommand({
        type: "user.message",
        text: `[系统-effort] effort 已调整为 "${e}"。${EFFORT_DESC_SHORT[e]}。请根据新等级调整后续 spawn 决策。`,
      });
    }
    applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
      text: `⚡ effort → ${e}  (${EFFORT_DESC_SHORT[e]})` });
  };

  // Restore last user message to input box (shared by ESC-run and ESC-idle paths)
  const restoreLastUserMessage = (agentId: string) => {
    const msgs = getState().messagesByAgent.get(agentId);
    if (!msgs) return;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.agent === "user") {
        const text = msgs[i]!.text ?? "";
        setInput(text);
        if (!cmdHistory.current.length || cmdHistory.current[cmdHistory.current.length - 1] !== text) {
          cmdHistory.current.push(text);
          historyIdx.current = -1;
          browsingHistory.current = false;
        }
        return;
      }
    }
  };

  const handleESCInterrupt = () => {
    const selId = getState().selectedAgent;
    const selState = getState().agents.get(selId)?.state;
    if (selState === "run" || selState === "idle") {
      killAgent(selId);
      applyEvent({ v: 1, type: "message", agent: selId, to: "user",
        text: `⏹ interrupted — edit your message above and resend` });
      // Load the last user message back into the input box, just like Claude Code:
      // user can immediately edit and resend without retyping from scratch.
      restoreLastUserMessage(selId);
    } else {
      // Agent not running — ESC loads last message for re-editing
      restoreLastUserMessage(selId);
    }
  };

  const requestExit = () => {
    if (exitConfirm) {
      if (exitConfirmTimer.current) clearInterval(exitConfirmTimer.current);
      exit();
      return;
    }
    setExitSecsLeft(3);
    exitConfirmTimer.current = setInterval(() => {
      setExitSecsLeft((s) => {
        if (s <= 1) {
          clearInterval(exitConfirmTimer.current!);
          exitConfirmTimer.current = null;
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  };

  // 全局快捷键
  useInput((char, key) => {
    if (key.ctrl && char === "c") { requestExit(); return; }
    if (char === "q" && !input) { requestExit(); return; }
    // Only handle ESC here when InputBar is NOT focused (pending approvals).
    // When InputBar is focused (pending.length===0), it handles ESC itself via onESC prop.
    // Handling it in both places caused double "⏹ interrupted by ESC" messages.
    if (key.escape && pending.length > 0) { handleESCInterrupt(); return; }

    // 待审批时 y/n 接管
    if (pending.length > 0) {
      if (char === "y") {
        const m = pending[0]!;
        const toolId = m.tool_id!;
        approve(toolId);
        const agentInst = agents.get(m.agent);
        if (agentInst) {
          executeTool(m.tool_name ?? "", m.tool_args).then((r) => {
            applyEvent({ v: 1, type: "tool.result", agent: m.agent, id: toolId, ok: r.ok, output: r.output });
            agentInst.sendCommand({ type: "tool.result", id: toolId, ok: r.ok, output: r.output });
          });
        }
        return;
      }
      if (char === "n") {
        const m = pending[0]!;
        const toolId = m.tool_id!;
        reject(toolId);
        const agentInst = agents.get(m.agent);
        if (agentInst) {
          const errMsg = "Tool rejected by user";
          applyEvent({ v: 1, type: "tool.result", agent: m.agent, id: toolId, ok: false, output: errMsg });
          agentInst.sendCommand({ type: "tool.result", id: toolId, ok: false, output: errMsg });
        }
        return;
      }
    }

    // Scroll shortcuts — [ scroll up (older), ] scroll down (newer), when input empty
    if (!input) {
      if (char === "[") { scrollBy(3);  return; } // older = hide 3 recent msgs
      if (char === "]") { scrollBy(-3); return; } // newer = unhide 3 recent msgs
    }

    // P/F/C/E shortcuts — only when not typing and no pending approvals
    if (!input && !pending.length) {
      // E — open effort selector (ESC/Enter handled inside EffortBar's own useInput)
      if (char === "E" && !effortSelecting) { setEffortSelecting(true); return; }
      if (key.escape && effortSelecting)    { setEffortSelecting(false); return; }
      if (char === "P") {
        const id = getState().selectedAgent;
        agents.get(id)?.kill?.();
        applyEvent({ v: 1, type: "message", agent: id, to: "user", text: `⏸ paused by user` });
        return;
      }
      if (char === "F") {
        const selId = getState().selectedAgent;
        const selInfo = getState().agents.get(selId);
        // F forks a Tech Lead from PM, or a Worker from a Tech Lead
        const isLeaderLevel = !selInfo?.parent || selId === "pm";
        const child = isLeaderLevel
          ? `tl-${Date.now().toString(36).slice(-4)}`
          : `worker-${Date.now().toString(36).slice(-4)}`;
        const role: "Leader" | "Worker" = isLeaderLevel ? "Leader" : "Worker";
        const spawnEv: Extract<TuiEvent, { type: "spawn" }> = {
          v: 1, type: "spawn", parent: selId, child, role,
          goal: "(awaiting instructions — type your task)",
          dispatch: { background: `Forked from ${selId} by user`, constraints: [],
            acceptance_criteria: ["agent.done"], stop_conditions: ["agent.done"] },
        };
        const parentRole = getState().agents.get(selId)?.role;
        const check = pm.preCheckSpawn(spawnEv, parentRole);
        if (!check.ok) {
          applyEvent({ v: 1, type: "agent.error", agent: selId, code: check.code, detail: check.detail });
          return;
        }
        applyEvent(spawnEv);
        pm.observe(spawnEv);
        startWorker(spawnEv);
        return;
      }
      if (char === "C") {
        const id = getState().selectedAgent;
        const info = getState().agents.get(id);
        applyEvent({ v: 1, type: "message", agent: id, to: "user",
          text: `⚙ ${info?.name ?? id}\nrole: ${info?.role ?? "?"}\nmodel: ${info?.model ?? "?"}\nparent: ${info?.parent ?? "-"}\nstate: ${info?.state ?? "?"}`,
        });
        return;
      }
    }

    // 斜杠补全选择 — ↑/↓ 在列表中移动，优先于历史导航
    if (input.startsWith("/") && slashDisplay.length > 0) {
      if (key.upArrow) {
        setSlashSelectedIdx((p) => (p <= 0 ? slashDisplay.length - 1 : p - 1));
        return;
      }
      if (key.downArrow) {
        setSlashSelectedIdx((p) => (p >= slashDisplay.length - 1 ? 0 : p + 1));
        return;
      }
    }

    // 命令历史 — ↑ 回溯, ↓ 前进
    if (key.upArrow && (input === "" || browsingHistory.current)) {
      if (cmdHistory.current.length === 0) return;
      browsingHistory.current = true;
      const idx = Math.min(historyIdx.current + 1, cmdHistory.current.length - 1);
      historyIdx.current = idx;
      setInput(cmdHistory.current[cmdHistory.current.length - 1 - idx]!);
      return;
    }
    if (key.downArrow && browsingHistory.current) {
      if (historyIdx.current > 0) {
        historyIdx.current--;
        setInput(cmdHistory.current[cmdHistory.current.length - 1 - historyIdx.current]!);
      } else {
        historyIdx.current = -1;
        browsingHistory.current = false;
        setInput("");
      }
      return;
    }

    if (key.tab) {
      if (input.startsWith("/")) {
        // 斜杠模式：有选中项则补全选中，否则 LCP 补全
        const selected = slashSelectedIdx >= 0 ? slashDisplay[slashSelectedIdx] : undefined;
        if (selected) {
          setInput("/" + selected.name + " ");
          setSlashSelectedIdx(-1);
          completeTick.current++;
        } else if (slashMatches.length === 1) {
          setInput("/" + slashMatches[0]!.name + " ");
          completeTick.current++;
        } else if (slashMatches.length > 1) {
          const commonPrefix = lcp(slashMatches.map((m) => m.name));
          const newInput = "/" + commonPrefix;
          if (newInput !== input) { setInput(newInput); completeTick.current++; }
        }
        return;
      }
      // agent 切换 — 仅在非斜杠模式
      const ids = agentList;
      if (!ids.length) return;
      const idx = ids.indexOf(sel);
      selectAgent(ids[(idx + 1) % ids.length]!);
    }
  });

  return (
    <PaletteContext.Provider value={palette}>
      <Box flexDirection="column" height={process.stdout.rows ?? 24}>
        <TitleBar />
        {layout === "v3" ? (
          <Box flexDirection="column" flexGrow={1}>
            <DagView maxHeight={12} />
            <ConvPane scrollOffset={scrollOffset} completionRows={slashPaneRows} />
          </Box>
        ) : (
          // Responsive sidebar widths: shrink panes on narrow terminals so
          // ConvPane always gets enough columns for readable text.
          // At termCols=89: normal(22+32)→conv=30; responsive(14+22)→conv=48
          (() => {
            const tc = process.stdout.columns ?? 80;
            const agW = tc >= 120 ? 22 : tc >= 90 ? 18 : 14;
            const toW = tc >= 120 ? 32 : tc >= 90 ? 24 : 18;
            return (
              <Box flexGrow={1}>
                <AgentsPane width={agW} scroll={agentPaneScroll} />
                <VDivider />
                <ConvPane scrollOffset={scrollOffset} completionRows={slashPaneRows} />
                <VDivider />
                <TodoPane width={toW} />
              </Box>
            );
          })()
        )}
        {effortSelecting
          ? <EffortBar current={effort} onConfirm={confirmEffort} onCancel={() => setEffortSelecting(false)} />
          : <>
              {slashDisplay.length > 0 && (
                <>
                  <Box>
                    <Text dimColor>{"─".repeat(process.stdout.columns ?? 80)}</Text>
                  </Box>
                  <Box paddingX={2} flexDirection="column" flexShrink={1}>
                    {slashVisible.map((c, i) => {
                      const absIdx = slashScrollStart + i;
                      const selected = absIdx === slashSelectedIdx;
                      return (
                        <Box key={c.name}>
                          <Text color="cyan" inverse={selected}>{`/${c.name}`.padEnd(12)}</Text>
                          <Text dimColor={!selected}> {c.desc}</Text>
                        </Box>
                      );
                    })}
                    {slashDisplay.length > SLASH_MAX_VISIBLE && (
                      <Text dimColor>  {"·".repeat(3)} {slashDisplay.length - SLASH_MAX_VISIBLE} more</Text>
                    )}
                  </Box>
                </>
              )}
              <InputBar
                key={completeTick.current}
                focused={pending.length === 0}
                value={input}
                onChange={setInput}
                onESC={handleESCInterrupt}
                onSubmit={(v) => {
                  if (v.trim()) {
                    cmdHistory.current.push(v.trim());
                    historyIdx.current = -1;
                    browsingHistory.current = false;
                  }
                  dispatchUser(v);
                  setInput("");
                }}
                hint={
                  pending.length > 0
                    ? `[${pending[0]!.agent}] ${pending[0]!.tool_name ?? ""} — y approve · n reject`
                    : getState().pendingRating
                    ? "Session done — /rate good [comment] or /rate bad [comment] to rate"
                    : (() => {
                        const sel = getState().selectedAgent;
                        const selState = getState().agents.get(sel)?.state;
                        const hasPendingInput = getState().pendingInputAgents.has(sel);
                        if (selState === "run") return "working… (ESC to interrupt)";
                        if (hasPendingInput)    return "message queued, waiting for agent…";
                        return undefined;
                      })()
                }
              />
            </>
        }
        <StatusBar demo={DEMO} exitConfirm={exitConfirm} exitSecsLeft={exitSecsLeft} effort={effort} />
      </Box>
    </PaletteContext.Provider>
  );
}

// ── utils ────────────────────────────────────────────────────────────────────
function lcp(strs: string[]): string {
  if (!strs.length) return "";
  let prefix = strs[0]!;
  for (const s of strs.slice(1)) {
    while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (!prefix) break;
  }
  return prefix;
}

// ── boot ────────────────────────────────────────────────────────────────────
// Windows cmd/PowerShell defaults to GBK; force UTF-8 so Chinese log lines
// written to stderr are not garbled. No-op on Linux/macOS.
if (process.platform === "win32") {
  process.stderr.setEncoding("utf8");
  try { execSync("chcp 65001", { stdio: "ignore" }); } catch { /* best-effort */ }
}

const banner = DEMO
  ? "running in --demo mode (no real claude subprocess; fake events on first message)"
  : `live mode — will spawn 'claude' on first message (model=${MODEL})`;

console.log(`\nmulti-agent TUI · ${banner}\n`);

// ── rg (ripgrep) probe — Grep/Glob tools require it ─────────────────────────
// spawnSync accepts shell: boolean; execSync only accepts shell: string.
// Full command in string — do NOT split args when shell:true (shell receives them as $0/$1).
const _rgCheck = spawnSync("rg --version", [], { stdio: "ignore", shell: true });
if (_rgCheck.error || _rgCheck.status !== 0) {
  console.warn("⚠  ripgrep (rg) not found — Grep/Glob tools will be unavailable.");
  console.warn("   Install: apt install ripgrep  |  brew install ripgrep  |  cargo install ripgrep\n");
}

// ── stdin passthrough (no mouse interception) ───────────────────────────────
// 关掉所有鼠标追踪，还给终端原生文字选中能力。
// 滚动改用键盘（[ / ]，见 useInput 处理）。
process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l");

const filteredStdin = new PassThrough();
process.stdin.pipe(filteredStdin, { end: false });

Object.defineProperties(filteredStdin, {
  isTTY: { get: () => process.stdin.isTTY },
  setRawMode: { value: (mode: boolean) => { try { process.stdin.setRawMode(mode); } catch { /* non-TTY fallback */ } } },
  ref: { value: () => process.stdin.ref() },
  unref: { value: () => process.stdin.unref() },
});

// Re-disable on exit — covers clean exit, SIGINT (Ctrl+C), and SIGTERM
const TERM_RESET = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h";
process.on("exit", () => { process.stdout.write(TERM_RESET); });
process.on("SIGINT", () => { process.stdout.write(TERM_RESET); process.exit(130); });
process.on("SIGTERM", () => { process.stdout.write(TERM_RESET); process.exit(143); });

// ── Synchronized output — prevent lower-half flicker ───────────────────────
// Ink's log-update writes each frame as one stream.write() call:
//   stream.write(eraseLines(N) + newContent)
// The terminal renders lines as they arrive, so the user sees old content
// being erased top-to-bottom before new content fills in → visible flicker.
//
// DEC private mode 2026 (supported by Windows Terminal, kitty, iTerm2, etc.)
// tells the terminal to buffer the entire write and flip the frame atomically.
// Unknown terminals silently ignore the sequence, so this is safe everywhere.
{
  const _orig = process.stdout.write.bind(process.stdout);
  let _inside = false;
  // @ts-ignore — intentional write shim
  process.stdout.write = function (chunk: any, ...rest: any[]): boolean {
    if (_inside) return _orig(chunk, ...rest);
    const s: string = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    // Ink frame writes always contain eraseLines (\x1b[1A\x1b[2K) or
    // clearTerminal (\x1b[2J\x1b[H). Wrap those — and only those — in
    // synchronized-output begin/end markers.
    if (s.includes("\x1b[1A") || s.includes("\x1b[2J")) {
      _inside = true;
      const r = _orig(`\x1b[?2026h${s}\x1b[?2026l`, ...rest);
      _inside = false;
      return r;
    }
    return _orig(chunk, ...rest);
  };
}

render(<App />, { stdin: filteredStdin as any, exitOnCtrlC: false });
