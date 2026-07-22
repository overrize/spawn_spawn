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
import { Transform } from "node:stream";
import { execSync, spawnSync, spawn as nodeSpawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { HttpConvAgent } from "../adapters/httpAgent.js";
import { startHttpServer } from "../server/httpServer.js";
import {
  TitleBar, AgentsPane, SessionsPane, ConvPane, TodoPane, StatusBar, InputBar, EffortBar, ModelBar,
  EFFORT_LEVELS, type Effort,
  DagView, VDivider, PaletteContext, PALETTES,
} from "../ui.js";
import {
  applyEvent, ensureAgent, getState, selectAgent, useStore, userMessage,
  approve, reject, abortAgent, setLayout, scrollBy, scrollAgentBy, setMinLevel, setEffort,
  resumeAgent, updateAgentInfo, clearDoneAgents, markPendingInput, pruneAgents, setTokenBudget,
  selectAgentVisible,
  setPendingRating, clearPendingRating,
  setFeishuConnection,
} from "../store.js";
import type { TuiEvent, LogLevel } from "../protocol.js";
import {
  loadConfig,
  savePalette,
  saveLayout,
  getAgentProviderConfig,
  isAgentConfigRole,
  resolveModelConfigInput,
  saveAgentModel,
  saveModelConfig,
  saveWebSearchProvider,
  saveWebSearchSelection,
} from "../config.js";
import type { PaletteName, AgentConfigRole, WebSearchProviderType } from "../config.js";
import { createRuntimeContext } from "./RuntimeContext.js";
import { SecretaryProxy } from "./MemoryRuntime.js";
import { createMemory, loadMemory, loadMemoryByHash, listUnfinishedAgents, deleteAgentMemory, topFactsByWeight, loadSessions } from "./MemoryRuntime.js";
import { executeTool, toolNeedsApproval, buildToolSchemaBlock } from "./ToolRuntime.js";
import type { AgentRole } from "./ToolRuntime.js";
import { TestSuite } from "../tests/e2e/runner/TestSuite.js";
import { E2ESuite } from "../tests/e2e/runner/E2ESuite.js";
import { TokenManager } from "../feishu/auth.js";
import {
  sendTextMessage, addProcessingReaction, deleteProcessingReaction,
  patchCardMessage, replyToMessageWithText,
} from "../feishu/message.js";
import { feishuLog } from "../feishu/debug.js";
import { taskRegistry, cardIndex, pmCurrentTask } from "../feishu/session.js";
import { PMBridgeBase } from "../feishu/pm-bridge.js";
import { createTask, createCardRenderer } from "../feishu/card-renderer.js";
import { startFeishuWebSocket } from "../feishu/websocket.js";
import { FeishuReplyAggregator } from "../feishu/replyAggregator.js";
import { FeishuInputWindowManager } from "../feishu/input-window.js";
import { globalBus } from "../bus/Bus.js";
import { OutboundGateway } from "../feishu/outbound/OutboundGateway.js";
import { ConversationRuntime, TurnController, classifyFollowup, isStatusQuery } from "./OrchestratorRuntime.js";
import { getCursorAnchorSequence } from "./CursorAnchor.js";
import { formatMetricsReport, getHealthMetricsStore, recordHealthMetric } from "./ObservabilityRuntime.js";
import { Transcript } from "../tui/Transcript.js";
import { config as dotenvConfig } from "dotenv";
// Load .env so FEISHU_APP_ID / FEISHU_APP_SECRET are available even without shell export
dotenvConfig();

// ── 路径 ───────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (k: string) => argv.find((a) => a.startsWith(`--${k}`));
const DEMO = !!flag("demo");
const MODEL = flag("model")?.split("=")[1] ?? "claude-sonnet-4-5";
const PROMPTS_DIR = path.resolve(__dirname, "..", "..",
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
      recordHealthMetric({
        agent_id: agentId,
        event_type: "resume_context_missing",
        severity: "warn",
        reason: `loadMemory("${resumedMemoryId}") returned null`,
        meta: {
          resumedMemoryId,
          role,
          goal: goal?.slice(0, 300),
        },
      });
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
  const leaderCfg = getAgentProviderConfig(cfg, "leader");
  const workerCfg = getAgentProviderConfig(cfg, "worker");
  const secretaryCfg = getAgentProviderConfig(cfg, "secretary");
  return tpl
    .replace(/\{\{AGENT_ID\}\}/g, agentId)
    .replace(/\{\{ROLE\}\}/g, role)
    .replace(/\{\{GOAL\}\}/g, goal ?? "(无，等用户指令)")
    .replace(/\{\{ALLOWED_TOOLS\}\}/g, buildToolSchemaBlock(role as AgentRole))
    .replace(/\{\{PARENT_ID\}\}/g, "—")
    .replace(/\{\{CWD\}\}/g, process.cwd())
    .replace(/\{\{AGENT_LIST\}\}/g, Array.from(agents.keys()).join(", ") || "(仅你自己)")
    .replace(/\{\{WORKER_MODEL\}\}/g, workerCfg.model)
    .replace(/\{\{LEADER_MODEL\}\}/g, leaderCfg.model)
    .replace(/\{\{SECRETARY_MODEL\}\}/g, secretaryCfg.model);
}
function readIfExists(p: string): string {
  try { return fs.readFileSync(p, "utf8"); } catch { return `(missing: ${p})`; }
}

// ── 全局单例 ───────────────────────────────────────────────────────────────
const runtimeContext = createRuntimeContext();
const { agents, secretaries, pm, scheduledTasks, killedAgents, feishuBusy, pmPendingArtifacts, leaderApprovalQueue } = runtimeContext;
// Start HTTP REST API server (configurable via .env or default port 3001)
const serverPort = parseInt(process.env.SERVER_PORT ?? "3001", 10);
const serverEnabled = process.env.SERVER_ENABLED !== "false";
startHttpServer({ port: serverPort, enabled: serverEnabled });
// Feishu: open_id → pmId (e.g. "feishu-a1b2c3d4")
const feishuSessions = new Map<string, string>();
let feishuConnected = false;
// Per-PM message queue: messages that arrived while the agent was mid-turn.
// Stores { text, messageId } so the dequeue path can anchor the reply card correctly.
const feishuMsgQueue = new Map<string, Array<{ text: string; messageId: string }>>();
// Set of PM IDs currently processing a turn (busy = don't inject new messages)
// Where to reply: stored per-PM so queued delivery can route correctly
const feishuReplyTarget = new Map<string, { replyId: string; replyType: 'open_id' | 'chat_id' }>();
// Shared tokenManager + event bridge (set once in connectFeishu)
let feishuTokenManager: TokenManager | null = null;
const feishuBridge = new PMBridgeBase();
// Dedup: 5s same-content guard per user (catches rapid re-sends / UI double-taps)
// Event-ID dedup is already handled at the WS layer (websocket.ts seenEventIds, 500-entry LRU)
const feishuRecentTexts = new Map<string, { text: string; time: number }>(); // openId → last msg
// Per-PM reply aggregator: coalesces N fallback fragments into one Feishu send per turn
const feishuAggregators = new Map<string, FeishuReplyAggregator>(); // pmId → aggregator
// Input merge window: silence gap (ms) before flushing buffered consecutive messages
const FEISHU_INPUT_WINDOW_MS = 1500;
// Phase B: concurrent task tracking
// feishuForks: openId → Set of forked PM' ids currently running (excludes the base session PM)
const feishuForks = new Map<string, Set<string>>();
// feishuPendingQueue: messages that arrived when all concurrent slots were full
const feishuPendingQueue = new Map<string, Array<{ text: string; anchorMsgId: string; chatId: string; chatType: string }>>();
// feishuCheckpoints: pmId → last confirmed-clean message history (captured after each base-PM turn).
// Fork tasks use this snapshot instead of live messages to prevent cross-contamination with
// in-flight sibling turns (Bug 1 fix).
const feishuCheckpoints = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();
// feishuForkBuffer: completed fork Q/As awaiting merge into base PM history on the next
// base PM turnEnd. Keyed by openId; entries carry arrival seq for stable ordering.
let feishuForkSeq = 0;
const feishuForkBuffer = new Map<string, Array<{
  seq: number;
  anchorMsgId: string;
  question: string;
  answer: string;
}>>();
// max total concurrent tasks per openId (base PM + forks)
const FEISHU_MAX_CONCURRENT = 3;

// Agents that were explicitly killed by the user (ESC) or by a parent agent.kill event.
// Used to suppress child→parent notifications after a kill so the parent isn't restarted.

// Artifact files reported by TL children (message.to=parent or unit.handup) that PM
// must inject as full document content before its next onTurnEnd flush.
// Keyed by PM agent ID; values are absolute file paths to read.

// Destructive Bash commands from workers are routed to leader for approval instead
// of asking the user directly. Keyed by tool.call id.
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
  replyHook?: (text: string, format?: "text" | "document", meta?: { _fallback?: boolean; agentId?: string }) => void; // called when message.to=user (Feishu bridge)
  turnEndHook?: () => void;            // called when Feishu PM turn ends — flushes aggregator
  conversationMode?: boolean;          // if true: stop after each user reply, no auto-nudge
  // Phase B: forked task options
  sharedSystemPrompt?: string;         // exact system prompt from base PM (enables cache reuse)
  initialMessages?: Array<{ role: "user" | "assistant"; content: string }>; // history snapshot
  isForkedTask?: boolean;              // skip secretary/memory; lightweight single-task mode
}

function killAgent(id: string, _reason = "interrupted"): void {
  killedAgents.add(id);
  agents.get(id)?.kill?.(); // clears queue, pops unresponded user msg, aborts HTTP
  abortAgent(id);           // clears pending approvals in store
  globalBus.unregisterAgent(id);
  // Release feishu serial lock so the next message for this PM isn't queued forever.
  feishuBusy.delete(id);
  // Phase B: remove from fork tracking so capacity count stays correct.
  for (const pmIds of feishuForks.values()) {
    if (pmIds.has(id)) { pmIds.delete(id); break; }
  }
  // Do NOT set state:err — httpAgent emits state:idle after AbortError,
  // which returns the agent to ready state so the user can resend immediately.
}

function replaceAgentForResume(id: string): void {
  agents.get(id)?.kill?.();
  agents.delete(id);
  globalBus.unregisterAgent(id);
  secretaries.get(id)?.destroy();
  secretaries.delete(id);
  killedAgents.delete(id);
}

// ── 飞书桥接 ───────────────────────────────────────────────────────────────
// Starts the Feishu WebSocket and routes messages to per-user PM sessions.
// Safe to call from both useEffect (auto-startup) and /feishu command (runtime).
function connectFeishu(appId: string, appSecret: string): void {
  if (feishuConnected) {
    setFeishuConnection({ enabled: true, connected: true, status: "已连接" });
    return;
  }
  feishuConnected = true;
  setFeishuConnection({ enabled: true, connected: false, status: "连接中" });
  process.env.FEISHU_APP_ID = appId;
  process.env.FEISHU_APP_SECRET = appSecret;
  const tokenManager = new TokenManager();
  feishuTokenManager = tokenManager;
  tokenManager.getToken().catch(() => { /* pre-warm; will retry on first send */ });

  // Wire card renderer to the bridge (one-time subscription per connection)
  feishuBridge.subscribe(createCardRenderer(tokenManager));

  const cfg = loadConfig();
  const leaderProviderCfg = getAgentProviderConfig(cfg, "leader");
  const conversationRuntimeShadow = new ConversationRuntime({
    maxConcurrent: FEISHU_MAX_CONCURRENT,
    autoDrainOnComplete: false,
    makeBasePmId: (openId) => `feishu-${crypto.createHash("sha256").update(openId).digest("hex").slice(0, 8)}`,
  });
  const shadowForkByAnchor = new Map<string, string>();
  const shadowLog = (label: string, actions: unknown[]): void => {
    if (process.env.SPAWN_SHADOW_RUNTIME !== "1") return;
    feishuLog(`[ConversationRuntime:shadow] ${label} ${JSON.stringify(actions).slice(0, 1000)}`);
  };
  const shadowAccept = (openId: string, text: string, messageId: string): void => {
    const actions = conversationRuntimeShadow.accept({ conversationId: openId, text, messageId });
    for (const action of actions) {
      if (action.type === "fork_start") shadowForkByAnchor.set(messageId, action.forkId);
    }
    shadowLog("accept", actions);
  };
  const shadowCompleteFork = (openId: string, messageId: string, answer: string): void => {
    const forkId = shadowForkByAnchor.get(messageId);
    if (!forkId) return;
    const actions = conversationRuntimeShadow.completeFork(openId, forkId, answer);
    shadowLog("completeFork", actions);
  };
  const shadowCompleteBase = (openId: string, pmId: string): void => {
    const bpm = agents.get(pmId);
    if (!(bpm instanceof HttpConvAgent)) return;
    const actions = conversationRuntimeShadow.completeBase(openId, bpm.getMessages());
    shadowLog("completeBase", actions);
  };

  // Helper: start a new task for pmId, emit task_spawned, send placeholder card
  const startTask = (pmId: string, rt: { replyId: string; replyType: 'open_id' | 'chat_id' }, msgId: string): void => {
    const task = createTask({ pmId, ...rt, rootMessageId: msgId }, tokenManager);
    taskRegistry.set(task.taskId, task);
    pmCurrentTask.set(pmId, task.taskId);
    feishuBridge.emit({ type: 'task_spawned', taskId: task.taskId, agentPath: 'PM', title: '🦞 PM' });
    // Reaction-only indicator — reply card is created on first PM response (no placeholder)
    if (msgId) {
      addProcessingReaction(msgId, tokenManager)
        .then((rid) => { task.reactionId = rid; })
        .catch(() => {});
    }
  };

  const buildBusyStatusReply = (openIdLocal: string, pmId: string): string => {
    const state = getState();
    const base = state.agents.get(pmId);
    const queueLen = feishuMsgQueue.get(pmId)?.length ?? 0;
    const overflowLen = feishuPendingQueue.get(openIdLocal)?.length ?? 0;
    const forkIds = Array.from(feishuForks.get(openIdLocal) ?? []);
    const descendants = Array.from(state.agents.values())
      .filter((agent) => agent.parent === pmId || forkIds.includes(agent.id))
      .filter((agent) => agent.state === "run" || agent.state === "idle")
      .slice(0, 4);
    const activeText = descendants.length > 0
      ? descendants.map((agent) => `${agent.id}(${agent.state}${agent.sub ? `: ${agent.sub}` : ""})`).join(" / ")
      : "暂无子任务";
    const taskId = pmCurrentTask.get(pmId);
    const lines = [
      "当前还在处理上一轮任务，我先给你状态，不把这条插进业务队列。",
      `base: ${base?.name ?? pmId} ${base?.state ?? "unknown"}${base?.sub ? ` - ${base.sub}` : ""}`,
      `活跃子任务: ${activeText}`,
      `base 追问队列: ${queueLen} 条；并发溢出队列: ${overflowLen} 条；并发 fork: ${forkIds.length} 个`,
    ];
    if (taskId) lines.push(`当前任务 ID: ${taskId}`);
    lines.push("建议：要开新工作请用「新任务 ...」；要追问上一轮可继续短句。");
    return lines.join("\n");
  };

  // createAggregator: one aggregator per PM session.
  // sendBubble → format=text: reply as text bubble anchored under the user's message.
  // sendCard   → format=document: route to card renderer for a structured card.
  // Note: text arrives pre-sanitized from the OutboundGateway (markdown stripped for text,
  // kept for document). The aggregator only needs to route, not re-sanitize.
  const finalSentByRootMessage = new Set<string>();
  const finalGuardKey = (taskId: string, pmIdLocal: string): string | null => {
    const task = taskRegistry.get(taskId);
    if (!task) return null;
    return task.rootMessageId || `${pmIdLocal}:${taskId}`;
  };
  const hasFinalSent = (taskId: string, pmIdLocal: string): boolean => {
    const task = taskRegistry.get(taskId);
    const key = finalGuardKey(taskId, pmIdLocal);
    if (!task || !key) return true;
    if (finalSentByRootMessage.has(key) || task.status === "done") {
      feishuLog(`[FeishuFinalGuard] suppressed duplicate final task=${taskId} pm=${pmIdLocal} root=${key}`);
      return true;
    }
    return false;
  };
  const markFinalSent = (taskId: string, pmIdLocal: string): void => {
    const key = finalGuardKey(taskId, pmIdLocal);
    if (key) finalSentByRootMessage.add(key);
  };
  const claimFinalSend = (taskId: string, pmIdLocal: string): boolean => {
    if (hasFinalSent(taskId, pmIdLocal)) {
      return false;
    }
    markFinalSent(taskId, pmIdLocal);
    return true;
  };
  const displayAgentName = (agentId?: string): string => {
    if (!agentId) return "PM";
    if (agentId === "pm" || /^feishu-[0-9a-f]{8}$/.test(agentId)) return `PM ${agentId}`;
    if (agentId.startsWith("feishu-fork-")) return `Fork ${agentId}`;
    const info = getState().agents.get(agentId);
    const role = info?.role ?? "Agent";
    return `${role} ${agentId}`;
  };
  const appendResponderNote = (text: string, agentId?: string, taskId?: string): string => {
    const taskNote = taskId ? `\n任务 ID：${taskId}` : "";
    return `${text.trim()}\n\n回答 agent：${displayAgentName(agentId)}${taskNote}`;
  };
  const createAggregator = (pmIdLocal: string): FeishuReplyAggregator =>
    new FeishuReplyAggregator(
      // sendBubble
      async (text: string, meta?: { agentId?: string }) => {
        const taskId = pmCurrentTask.get(pmIdLocal);
        if (!taskId) return;
        if (hasFinalSent(taskId, pmIdLocal)) return;
        const task = taskRegistry.get(taskId);
        if (!task) return;
        const elapsedSec = ((Date.now() - task.startedAt) / 1000).toFixed(1);
        const withTiming = `${appendResponderNote(text, meta?.agentId, taskId)}\n⏱ ${elapsedSec}s`;
        if (task.rootMessageId) {
          await replyToMessageWithText(task.rootMessageId, withTiming, tokenManager);
        } else {
          await sendTextMessage(task.replyId, task.replyType, withTiming, tokenManager);
        }
        if (task.reactionId && task.rootMessageId) {
          deleteProcessingReaction(task.rootMessageId, task.reactionId, tokenManager);
        }
        markFinalSent(taskId, pmIdLocal);
        task.status = 'done';
      },
      // sendCard
      async (text: string, meta?: { agentId?: string }) => {
        const taskId = pmCurrentTask.get(pmIdLocal);
        if (!taskId) return;
        if (!claimFinalSend(taskId, pmIdLocal)) return;
        const finalText = appendResponderNote(text, meta?.agentId, taskId);
        feishuBridge.emit({ type: 'agent_done', taskId, agentPath: 'PM', finalText });
        feishuBridge.emit({ type: 'task_done', taskId, summary: finalText });
      },
    );

  // Unified outbound gateway — all message.to=user content flows through this.
  const outboundGateway = new OutboundGateway(
    (pmId) => feishuAggregators.get(pmId),
    (pmId) => pmPendingArtifacts.get(pmId),
    (pmId) => { pmPendingArtifacts.delete(pmId); },
  );

  // makeGatewayHook: factory for the replyHook option passed to startLeaderAgent.
  // Computes dynamic context (active children) and routes into the OutboundGateway.
  const makeGatewayHook = (pmIdLocal: string) =>
    (replyText: string, format?: "text" | "document", meta?: { _fallback?: boolean; agentId?: string }): void => {
      const activeChildren = Array.from(getState().agents.values()).filter(
        (ag) => ag.parent === pmIdLocal && (ag.state === "run" || ag.state === "idle"),
      );
      outboundGateway.accept(
        { text: replyText, format, _fallback: meta?._fallback ?? false, agentId: meta?.agentId ?? pmIdLocal },
        { pmId: pmIdLocal, conversationMode: true, hasActiveChildren: activeChildren.length > 0 },
      );
    };

  // drainPendingQueue: when a task slot frees up, try to start the oldest pending message.
  const drainPendingQueue = (openId: string): void => {
    const pending = feishuPendingQueue.get(openId);
    if (!pending || pending.length === 0) return;
    const forkCount = feishuForks.get(openId)?.size ?? 0;
    const baseBusy = feishuBusy.has(
      `feishu-${crypto.createHash("sha256").update(openId).digest("hex").slice(0, 8)}`
    );
    const totalRunning = (baseBusy ? 1 : 0) + forkCount;
    if (totalRunning >= FEISHU_MAX_CONCURRENT) return;
    const next = pending.shift();
    if (!next) return;
    feishuLog(`[FeishuConcurrent] draining pending for openId=...${openId.slice(-6)}, remaining=${pending.length}`);
    dispatchMessage(openId, next.text, next.anchorMsgId, next.chatId, next.chatType);
  };

  // flushForkBufferToBase: call ONLY when base PM is idle (about to receive a new message).
  // Injects all completed fork Q/As from the buffer into base PM's live messages[] and
  // updates the checkpoint so the new message's context contains full fork history.
  const flushForkBufferToBase = (openId: string, pmId: string): void => {
    const buf = feishuForkBuffer.get(openId);
    if (!buf || buf.length === 0) return;
    const bpm = agents.get(pmId);
    if (!(bpm instanceof HttpConvAgent)) return;
    buf.sort((a, b) => a.seq - b.seq);
    const forkEntries = buf.flatMap(c => ([
      { role: "user"      as const, content: c.question },
      { role: "assistant" as const, content: c.answer   },
    ]));
    bpm.appendHistory(forkEntries);
    feishuCheckpoints.set(pmId, bpm.getMessages());
    feishuForkBuffer.delete(openId);
    feishuLog(`[FeishuConcurrent] pre-dispatch flush: ${buf.length} fork Q/As → ${pmId}`);
  };

  // startConcurrentTask: fork a new lightweight PM' for a concurrent task.
  // The fork shares the base PM's exact systemPrompt (Anthropic cache hit) and
  // gets a compacted snapshot of the base PM's current message history.
  const startConcurrentTask = (
    openId: string,
    sessionPmId: string,
    text: string,
    anchorMsgId: string,
    chatId: string,
    chatType: string,
  ): void => {
    const replyId   = chatType === 'group' ? chatId : openId;
    const replyType: 'open_id' | 'chat_id' = chatType === 'group' ? 'chat_id' : 'open_id';
    const rt = { replyId, replyType };

    // Create a Feishu task for this fork (anchored at anchorMsgId, NOT sessionPmId's current task).
    const task = createTask({ pmId: sessionPmId, ...rt, rootMessageId: anchorMsgId }, tokenManager);
    taskRegistry.set(task.taskId, task);

    const forkId = `feishu-fork-${task.taskId.slice(-8)}`;
    pmCurrentTask.set(forkId, task.taskId);

    // Record arrival order so the buffer can be merged in question-arrival order
    // rather than completion order (multiple forks completing out of order).
    const forkArrivalSeq = ++feishuForkSeq;

    // Capture the fork's reply text so we can merge Q/A back into base PM history.
    let forkAnswer = "";
    const forkReplyHook = (replyText: string, format?: "text" | "document", meta?: { _fallback?: boolean; agentId?: string }): void => {
      // Only accumulate non-fallback text into history
      if (!meta?._fallback) {
        forkAnswer += (forkAnswer ? "\n" : "") + replyText;
      }
      makeGatewayHook(forkId)(replyText, format, meta);
    };

    // Snapshot: use the last confirmed-clean checkpoint (captured after the previous base-PM
    // turn completed) rather than live getMessages(). The live array is dirty — it already
    // contains the in-flight Q that base PM is currently processing, which would make the
    // fork repeat the sibling answer before answering its own question (Bug 1 fix).
    const sessionPm = agents.get(sessionPmId);
    const rawCheckpoint = feishuCheckpoints.get(sessionPmId) ?? [];
    // Phase E: peek at any fork Q/As buffered but not yet merged into checkpoint.
    // Buffer is NOT consumed — base-idle flush or turnEnd will do that.
    // This ensures a new fork sees all completed concurrent work as context.
    const bufPeek = feishuForkBuffer.get(openId);
    const pendingForkMsgs: Array<{ role: "user" | "assistant"; content: string }> =
      bufPeek && bufPeek.length > 0
        ? [...bufPeek].sort((a, b) => a.seq - b.seq).flatMap(c => ([
            { role: "user"      as const, content: c.question },
            { role: "assistant" as const, content: c.answer   },
          ]))
        : [];
    const snapshot = HttpConvAgent.compactHistoryByTokens([...rawCheckpoint, ...pendingForkMsgs], 10_000);
    const sharedSysPrompt = sessionPm instanceof HttpConvAgent
      ? sessionPm.getSystemPrompt()
      : undefined;

    // Register fork in tracking set.
    const forks = feishuForks.get(openId) ?? new Set<string>();
    forks.add(forkId);
    feishuForks.set(openId, forks);

    feishuBusy.add(forkId);
    feishuAggregators.set(forkId, createAggregator(forkId));
    ensureAgent({
      id: forkId,
      name: `飞书:${openId.slice(-4)}↳${task.taskId.slice(-4)}`,
      role: "Leader",
      state: "idle",
      sub: "并发任务",
      model: leaderProviderCfg.model,
    });

    feishuBridge.emit({ type: 'task_spawned', taskId: task.taskId, agentPath: 'PM', title: '🔀 PM fork' });
    if (anchorMsgId) {
      addProcessingReaction(anchorMsgId, tokenManager)
        .then((rid) => { task.reactionId = rid; })
        .catch(() => {});
    }

    userMessage(forkId, text);
    startLeaderAgent({
      id: forkId,
      promptFile: "pm",
      conversationMode: true,
      isForkedTask: true,
      sharedSystemPrompt: sharedSysPrompt,
      initialMessages: snapshot,
      firstMessage: text,
      replyHook: forkReplyHook,
      turnEndHook: () => {
        outboundGateway.flush(forkId);
        feishuBusy.delete(forkId);
        shadowCompleteFork(openId, anchorMsgId, forkAnswer);
        // Buffer Q/A for merge back into base PM history on next base PM turnEnd.
        // Only buffer when the fork actually produced a reply (skip silent failures).
        if (forkAnswer) {
          const buf = feishuForkBuffer.get(openId) ?? [];
          buf.push({ seq: forkArrivalSeq, anchorMsgId, question: text, answer: forkAnswer });
          feishuForkBuffer.set(openId, buf);
          feishuLog(`[FeishuConcurrent] fork ${forkId} buffered Q/A (seq=${forkArrivalSeq})`);
        }
        feishuForks.get(openId)?.delete(forkId);
        if (feishuForks.get(openId)?.size === 0) feishuForks.delete(openId);
        drainPendingQueue(openId);
      },
    });
    feishuLog(
      `[FeishuConcurrent] forked ${forkId} for openId=...${openId.slice(-6)}` +
      ` forks=${feishuForks.get(openId)?.size ?? 0}/${FEISHU_MAX_CONCURRENT - 1}`,
    );
  };

  // dispatchMessage: inner function called by the input-window manager after the
  // silence gap expires. anchorMsgId is the FIRST fragment's message ID and is
  // used as the Feishu reaction / reply-card anchor for the whole merged turn.
  let inputMgr!: FeishuInputWindowManager; // assigned below; safe in closures

  const dispatchMessage = (
    openId: string,
    text: string,
    anchorMsgId: string,
    chatId: string,
    chatType: string,
  ): void => {
    // Safety net: websocket.ts already filters empty messages, but guard here too
    // so non-WS callers (tests, direct invocations) can't accidentally spawn PM with empty input.
    if (!text.trim()) {
      feishuLog(`[FeishuBridge] empty text from ...${openId.slice(-6)}, skipped`);
      return;
    }
    shadowAccept(openId, text, anchorMsgId);
    const pmId = `feishu-${crypto.createHash("sha256").update(openId).digest("hex").slice(0, 8)}`;
    const replyId   = chatType === 'group' ? chatId : openId;
    const replyType: 'open_id' | 'chat_id' = chatType === 'group' ? 'chat_id' : 'open_id';
    const rt = { replyId, replyType };

    if (!feishuSessions.has(openId)) {
      // ── New session ────────────────────────────────────────────────────────
      // Guard: if the PM with this deterministic ID already exists (e.g. session
      // map was cleared but agent survived), reconnect instead of re-spawning.
      if (agents.has(pmId)) {
        feishuLog(`[FeishuBridge] reconnect: PM ${pmId} alive but session lost — re-wiring`);
        feishuSessions.set(openId, pmId);
        if (!feishuBusy.has(pmId)) {
          feishuBusy.add(pmId);
          feishuReplyTarget.set(pmId, rt);
          startTask(pmId, rt, anchorMsgId);
          userMessage(pmId, text);
          killedAgents.delete(pmId);
          feishuLog(`[feishu-pm-inject] reconnect → PM ${pmId} text="${text.slice(0, 120)}" (len=${text.length})`);
          agents.get(pmId)!.sendCommand({ type: "user.message", text });
        } else {
          const q = feishuMsgQueue.get(pmId) ?? [];
          q.push({ text, messageId: anchorMsgId });
          feishuMsgQueue.set(pmId, q);
          feishuLog(`[FeishuBridge] reconnect-busy: queued for ${pmId}, len=${q.length}`);
        }
        return;
      }
      feishuLog(`[FeishuBridge] new session pmId=${pmId}`);
      feishuSessions.set(openId, pmId);
      feishuBusy.add(pmId);
      feishuReplyTarget.set(pmId, rt);
      startTask(pmId, rt, anchorMsgId);
      ensureAgent({ id: pmId, name: `飞书:${openId.slice(-4)}`, role: "Leader", state: "idle",
        sub: "飞书会话", model: leaderProviderCfg.model });
      feishuAggregators.set(pmId, createAggregator(pmId));
      userMessage(pmId, text);
      feishuLog(`[feishu-pm-inject] new session → PM ${pmId} firstMessage="${text.slice(0, 120)}" (len=${text.length})`);
      startLeaderAgent({ id: pmId, firstMessage: text, promptFile: "pm",
        conversationMode: true, replyHook: makeGatewayHook(pmId),
        turnEndHook: () => {
          feishuBusy.delete(pmId); // pre-clear: drain routing fix (Bug 2)
          shadowCompleteBase(openId, pmId);
          const bpm = agents.get(pmId);
          if (bpm instanceof HttpConvAgent) {
            let cleanHistory = bpm.getMessages();
            // Merge any completed fork Q/As in arrival order so subsequent turns
            // (base PM and future forks) can see all concurrent work done so far.
            const buf = feishuForkBuffer.get(openId);
            if (buf && buf.length > 0) {
              buf.sort((a, b) => a.seq - b.seq);
              const forkEntries = buf.flatMap(c => ([
                { role: "user"      as const, content: c.question },
                { role: "assistant" as const, content: c.answer   },
              ]));
              cleanHistory = cleanHistory.concat(forkEntries);
              bpm.appendHistory(forkEntries); // inject into base PM's live messages
              feishuForkBuffer.delete(openId);
              feishuLog(`[FeishuConcurrent] merged ${buf.length} fork Q/As into ${pmId} history`);
            }
            feishuCheckpoints.set(pmId, cleanHistory);
          }
          outboundGateway.flush(pmId);
          drainPendingQueue(openId);
        } });
    } else {
      // ── Existing session ───────────────────────────────────────────────────
      const existingPmId = feishuSessions.get(openId)!;
      const a = agents.get(existingPmId);
      feishuLog(
        `[FeishuBridge] existing pmId=${existingPmId} alive=${a instanceof HttpConvAgent} busy=${feishuBusy.has(existingPmId)}`,
      );
      if (a instanceof HttpConvAgent) {
        if (feishuBusy.has(existingPmId)) {
          if (isStatusQuery(text)) {
            const statusText = buildBusyStatusReply(openId, existingPmId);
            feishuLog(
              `[FeishuStatus] immediate busy status for ${existingPmId}` +
              ` text="${text.slice(0, 80)}"`,
            );
            if (anchorMsgId) {
              replyToMessageWithText(anchorMsgId, statusText, tokenManager).catch((err) => {
                feishuLog(`[FeishuStatus] reply failed: ${err instanceof Error ? err.message : String(err)}`);
              });
            }
            return;
          }

          // Keep obvious follow-ups on the same PM history. Independent messages
          // can still fork for full-duplex concurrency.
          const followup = classifyFollowup(text);
          if (followup.isFollowup) {
            const q = feishuMsgQueue.get(existingPmId) ?? [];
            q.push({ text, messageId: anchorMsgId });
            feishuMsgQueue.set(existingPmId, q);
            markPendingInput(existingPmId);
            feishuLog(
              `[FeishuFollowup] queued to base ${existingPmId} reason=${followup.reason}` +
              ` len=${q.length} text="${text.slice(0, 80)}"`,
            );
            if (anchorMsgId && feishuTokenManager) {
              addProcessingReaction(anchorMsgId, feishuTokenManager).catch(() => {});
            }
            return;
          }

          // Phase B: base PM is busy → try to fork a concurrent independent task.
          const forkCount = feishuForks.get(openId)?.size ?? 0;
          if (forkCount < FEISHU_MAX_CONCURRENT - 1) {
            startConcurrentTask(openId, existingPmId, text, anchorMsgId, chatId, chatType);
          } else {
            // All slots full → overflow queue + ⏳ reaction so user sees acknowledgement.
            const pending = feishuPendingQueue.get(openId) ?? [];
            pending.push({ text, anchorMsgId, chatId, chatType });
            feishuPendingQueue.set(openId, pending);
            feishuLog(`[FeishuConcurrent] at capacity (${forkCount + 1}/${FEISHU_MAX_CONCURRENT}), queued for openId=...${openId.slice(-6)}`);
            if (anchorMsgId && feishuTokenManager) {
              addProcessingReaction(anchorMsgId, feishuTokenManager).catch(() => {});
            }
          }
        } else {
          // Phase E: flush any completed fork Q/As into base PM before new message,
          // so the new message's context already contains all concurrent work done so far.
          flushForkBufferToBase(openId, existingPmId);
          feishuBusy.add(existingPmId);
          feishuReplyTarget.set(existingPmId, rt);
          startTask(existingPmId, rt, anchorMsgId);
          userMessage(existingPmId, text);
          killedAgents.delete(existingPmId);
          markPendingInput(existingPmId);
          feishuLog(`[feishu-pm-inject] existing session → PM ${existingPmId} text="${text.slice(0, 120)}" (len=${text.length})`);
          a.sendCommand({ type: "user.message", text });
        }
      } else {
        feishuLog(`[FeishuBridge] PM ${existingPmId} gone, starting fresh`);
        feishuAggregators.get(existingPmId)?.reset();
        feishuAggregators.delete(existingPmId);
        feishuSessions.delete(openId);
        inputMgr.clear(openId); // discard any stale pending window for this user
        setImmediate(() => {
          const newPmId = `feishu-${crypto.createHash("sha256").update(openId + Date.now()).digest("hex").slice(0, 8)}`;
          feishuSessions.set(openId, newPmId);
          feishuReplyTarget.set(newPmId, rt);
          startTask(newPmId, rt, anchorMsgId);
          ensureAgent({ id: newPmId, name: `飞书:${openId.slice(-4)}`, role: "Leader", state: "idle",
            sub: "飞书会话", model: leaderProviderCfg.model });
          feishuAggregators.set(newPmId, createAggregator(newPmId));
          userMessage(newPmId, text);
          startLeaderAgent({ id: newPmId, firstMessage: text, promptFile: "pm",
            conversationMode: true, replyHook: makeGatewayHook(newPmId),
            turnEndHook: () => {
              feishuBusy.delete(newPmId);
              shadowCompleteBase(openId, newPmId);
              const bpm2 = agents.get(newPmId);
              if (bpm2 instanceof HttpConvAgent) {
                let cleanHistory2 = bpm2.getMessages();
                const buf2 = feishuForkBuffer.get(openId);
                if (buf2 && buf2.length > 0) {
                  buf2.sort((a, b) => a.seq - b.seq);
                  const forkEntries2 = buf2.flatMap(c => ([
                    { role: "user"      as const, content: c.question },
                    { role: "assistant" as const, content: c.answer   },
                  ]));
                  cleanHistory2 = cleanHistory2.concat(forkEntries2);
                  bpm2.appendHistory(forkEntries2);
                  feishuForkBuffer.delete(openId);
                  feishuLog(`[FeishuConcurrent] merged ${buf2.length} fork Q/As into ${newPmId} history`);
                }
                feishuCheckpoints.set(newPmId, cleanHistory2);
              }
              outboundGateway.flush(newPmId);
              drainPendingQueue(openId);
            } });
        });
      }
    }
  };

  // Input-merge window: buffers rapid consecutive messages from the same user
  // and flushes them as one combined turn after FEISHU_INPUT_WINDOW_MS of silence.
  inputMgr = new FeishuInputWindowManager(FEISHU_INPUT_WINDOW_MS, dispatchMessage);

  startFeishuWebSocket({
    appId,
    appSecret,
    onStatus: (msg: string) => {
      const connected = msg.includes("connected");
      const disconnected =
        msg.includes("closed") ||
        msg.includes("error:") ||
        msg.includes("bootstrap failed") ||
        msg.includes("max reconnect attempts reached");
      setFeishuConnection({
        enabled: true,
        connected: connected ? true : disconnected ? false : getState().feishuConnection.connected,
        status: msg,
      });
    },
    onMessage: (openId: string, text: string, chatId: string, chatType: string, messageId: string) => {
      feishuLog(
        `[FeishuBridge] onMessage openId=...${openId.slice(-6)} msgId=${messageId.slice(-8)} len=${text.length} text="${text.slice(0, 120)}"`,
      );

      // Short-time same-content guard: reject exact duplicate text within 5s per user.
      // (Event-ID dedup is already handled upstream in websocket.ts seenEventIds.)
      const recentMsg = feishuRecentTexts.get(openId);
      if (recentMsg && recentMsg.text === text && Date.now() - recentMsg.time < 5000) {
        feishuLog(`[FeishuBridge] dup content from ${openId} within 5s, skipped`);
        return;
      }
      feishuRecentTexts.set(openId, { text, time: Date.now() });

      // Feed into merge window — timer fires dispatchMessage after silence gap.
      inputMgr.feed(openId, text, messageId, chatId, chatType);
    },
  }).catch((err: unknown) => {
    feishuConnected = false; // allow retry after failure
    setFeishuConnection({
      enabled: true,
      connected: false,
      status: `连接失败: ${err instanceof Error ? err.message : String(err)}`,
    });
    feishuLog(`[FeishuWS] startup failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

function startLeaderAgent(opts: LeaderOpts): void {
  if (DEMO && !opts.parentId) { return runDemo(opts.firstMessage ?? "demo"); }
  if (agents.has(opts.id)) {
    process.stderr.write(`[startLeaderAgent] EARLY RETURN: agents already has "${opts.id}" — skipping spawn\n`);
    return;
  }

  const cfg = loadConfig();
  const leaderProviderCfg = getAgentProviderConfig(cfg, "leader");
  const model = opts.model ?? leaderProviderCfg.model ?? MODEL;
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

  // Phase B: forked tasks share the exact system prompt from the base PM for Anthropic cache reuse.
  const systemPrompt = opts.sharedSystemPrompt
    ?? buildSystemPrompt("Leader", opts.id, opts.goal, opts.resumedMemoryId, promptFile);
  const a = new HttpConvAgent({
    id: opts.id,
    role: "Leader",
    providerCfg: { ...leaderProviderCfg, model },
    systemPrompt,
    resumeFrom: opts.isForkedTask ? undefined : opts.resumedMemoryId,
    initialMessages: opts.initialMessages,
  });
  agents.set(opts.id, a);
  globalBus.registerAgent(opts.id, a);

  // Secretary — skipped for forked tasks (single-use, no memory persistence needed).
  const secretary: SecretaryProxy | null = opts.isForkedTask ? null : (() => {
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
    const sec = new SecretaryProxy(mem, { startNewSession: !existingMem });
    secretaries.set(opts.id, sec);
    return sec;
  })();

  // Per-turn state
  const toolQueue: Array<Extract<TuiEvent, { type: "tool.call" }>> = [];
  let actedThisTurn = false;
  let continuations = 0;
  let gaveUp = false;
  let nudgePending = false; // true when the next run turn is a system-initiated nudge
  let sentToUserThisTurn = false; // true when PM sent message.to=user this turn
  let reportedToParent = false;   // true when TL/Worker sent message to their parent this turn
  let lastToolCallKey = "";       // loop detection: last "tool:argsJSON" key
  let sameToolCallCount = 0;      // how many consecutive times same tool+args was called
  let terminalEventAccepted = false; // non-root leaders/forks ignore delayed events after agent.done
  const turnShadow = new TurnController();
  const logTurnShadow = (): void => {
    if (process.env.SPAWN_SHADOW_TURN !== "1") return;
    process.stderr.write(`[TurnController:shadow] ${opts.id} ${JSON.stringify(turnShadow.snapshot())}\n`);
  };

  // Quality tracking — emitted as structured stderr log on agent.done
  let qualTurns = 0;
  let qualNudges = 0;
  let qualHandup = false;
  let lastTtftMs = 0;
  let lastTotalMs = 0;

  // Unified child-Leader convergence (Feishu 已读不回 / 已读空回 fix).
  // A non-conversation sub-Leader (TL) can pass through MANY idle exits without ever
  // converging (1307 replied-no-todos, 1346 auto-close, 1362/1408 gaveUp, fall-throughs),
  // leaving store.state="idle" forever → parent PM waits indefinitely → feishuBusy never
  // releases → pending Feishu messages never drain. Rather than patch each exit, the idle
  // handler's terminal/no-op exits "make way" for sub-Leaders (guard: convMode || !parentId)
  // and route them all to ONE of three dead-zone fallbacks, which call this single function.
  // Contract: relay TL's real output to parent FIRST (so PM has content to tell the user,
  // not 已读空回), THEN synthesize agent.done so the existing done pipeline runs (store→done
  // clears PM activeChildren, completeForeground + parent-notify + unregister via a.emit).
  const convergeChildLeader = (reasonTag: string, conv: { gaveUp?: boolean } = {}): void => {
    const parentId = opts.parentId!;
    let report: string;
    if (conv.gaveUp) {
      // Gave-up path: stale prose is misleading — relay an explicit "abandoned" notice.
      report = `[${opts.id} 汇报] 多次推进无效，已放弃该子任务。请基于已有上下文向用户说明当前进展。`;
    } else {
      // Pick the most recent CLEAN assistant prose: not empty, not raw protocol JSON,
      // and not DeepSeek DSML tool-call noise (relaying DSML markup is worse than a placeholder).
      const lastProse = [...a.getMessages()].reverse().find((m) => {
        const t = m.content.trim();
        return m.role === "assistant" && t !== "" &&
          !t.startsWith("{") && !t.startsWith("<") && !m.content.includes("｜｜DSML｜｜");
      })?.content.trim() ?? "";
      report = lastProse
        ? `[${opts.id} 汇报] ${lastProse.slice(0, 1500)}`
        : `[${opts.id} 汇报] 子任务已完成，TL 未生成有效汇总。请基于已有上下文向用户说明当前进展。`;
    }
    process.stderr.write(`[${opts.id}] idle → child-leader converge [${reasonTag}] relay+done (gaveUp=${!!conv.gaveUp})\n`);
    const parentAgent = agents.get(parentId);
    if (parentAgent instanceof HttpConvAgent && !killedAgents.has(parentId)) {
      parentAgent.sendCommand({ type: "user.message", text: report });
      reportedToParent = true;
    }
    a.emit("event", {
      v: 1, type: "agent.done", agent: opts.id, success: true, reason: reasonTag,
    } as TuiEvent);
  };

  // Drain a conversation-mode PM after it has replied to the user: release the serial
  // feishuBusy lock and dispatch the next queued follow-up. Shared by the clean-exit path
  // (replied + no todos) and the dead-zone path (replied + stale todos + nudges exhausted).
  // Without the dead-zone caller, a PM that spawned a TL holds feishuBusy forever after its
  // first reply — every later follow-up ("结论呢"…) queues but never drains (only-replies-once bug).
  const drainConvModePM = (closeStaleTodos: boolean): void => {
    if (closeStaleTodos) {
      const todos = getState().todosByAgent.get(opts.id) ?? [];
      if (todos.some((t) => t.state === "todo" || t.state === "run")) {
        const closed = todos.map((t) => ({ ...t, state: (t.state === "todo" || t.state === "run") ? "done" : t.state }));
        applyEvent({ v: 1, type: "todo.set", agent: opts.id, items: closed as any });
      }
    }
    opts.turnEndHook?.();
    feishuBusy.delete(opts.id);
    const nextItem = feishuMsgQueue.get(opts.id)?.shift();
    if (nextItem) {
      const { text: nextMsg, messageId: nextMsgId } = nextItem;
      process.stderr.write(`[${opts.id}] delivering queued msg: "${nextMsg.slice(0, 60)}"\n`);
      feishuBusy.add(opts.id);
      const rt = feishuReplyTarget.get(opts.id);
      if (rt && feishuTokenManager) {
        const task = createTask({ pmId: opts.id, ...rt, rootMessageId: nextMsgId }, feishuTokenManager);
        taskRegistry.set(task.taskId, task);
        pmCurrentTask.set(opts.id, task.taskId);
        feishuBridge.emit({ type: 'task_spawned', taskId: task.taskId, agentPath: 'PM', title: '🦞 PM' });
        if (nextMsgId) {
          addProcessingReaction(nextMsgId, feishuTokenManager)
            .then((rid) => { task.reactionId = rid; })
            .catch(() => {});
        }
      }
      setImmediate(() => {
        if (getState().agents.get(opts.id)?.state === "done" || killedAgents.has(opts.id)) return;
        userMessage(opts.id, nextMsg);
        a.sendCommand({ type: "user.message", text: nextMsg });
      });
    }
  };

  a.on("event", (e: TuiEvent) => {
    if (terminalEventAccepted && e.type !== "token.usage") {
      process.stderr.write(`[${opts.id}] dropped ${e.type} after terminal agent.done\n`);
      return;
    }

    // Spawn — pre-check then dispatch to correct handler
    if (e.type === "spawn") {
      // Guard 1: reject before store write if the child ID already exists.
      // LLMs sometimes hallucinate reusing an existing agent ID (e.g. spawning the PM
      // itself as a worker), which would corrupt the store entry and stall the parent.
      if (agents.has(e.child)) {
        process.stderr.write(`[${opts.id}] spawn REJECTED: child="${e.child}" already exists in agents Map\n`);
        a.sendCommand({ type: "user.message", text: `[系统] spawn 失败：agent ID "${e.child}" 已被占用。请使用一个唯一的新 ID（如 worker-${Date.now().toString(36).slice(-4)}）。` });
        return;
      }
      // Guard 2: normalize parent to opts.id — LLM sometimes outputs a stale/wrong parent
      // (e.g. "pm" when the actual Feishu PM ID is "feishu-xxxxxxxx"). If we leave it as-is,
      // the child's parent field in the store won't match opts.id and activeChildren = 0.
      const normalized: typeof e = e.parent !== opts.id ? { ...e, parent: opts.id } : e;
      // Use opts.id (not e.parent) for role lookup — e.parent may be stale
      const parentRole = getState().agents.get(opts.id)?.role;
      const check = pm.preCheckSpawn(normalized, parentRole);
      if (!check.ok) {
        applyEvent({ v: 1, type: "agent.error", agent: opts.id, code: check.code, detail: check.detail });
        return;
      }
      actedThisTurn = true;
      turnShadow.markAction();
      applyEvent(normalized);
      pm.observe(normalized);
      secretary?.observe(normalized);
      process.stderr.write(`[${opts.id}] spawn child=${normalized.child} role=${normalized.role ?? "?"} goal="${(normalized.goal ?? "").slice(0, 80)}"\n`);
      startWorker(normalized); // foreground tracking registered inside startWorker for both Leader+Worker
      return;
    }

    if (e.type === "agent.error") {
      applyEvent(e); pm.observe(e); secretary?.observe(e);
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

    // Non-root leaders/TLs do not own the Feishu/user reply channel. If a TL
    // writes message.to=user, relay it to its parent PM instead so the final
    // artifact is not lost behind the OutboundGateway's active-child filter.
    if (e.type === "message" && opts.parentId && e.to === "user") {
      const redirected = { ...e, to: opts.parentId } as typeof e;
      process.stderr.write(`[${opts.id}] redirected message.to=user → ${opts.parentId}\n`);
      applyEvent(redirected);
      pm.observe(redirected);
      secretary?.observe(redirected);
      reportedToParent = true;
      turnShadow.markParentReport();
      const parentAgent = agents.get(opts.parentId);
      if (parentAgent instanceof HttpConvAgent && !killedAgents.has(opts.parentId)) {
        parentAgent.sendCommand({
          type: "user.message",
          text: `[${opts.id}→${opts.parentId}] ${e.text}`,
        });
      }
      return;
    }

    // Approve/reject destructive Bash from a child agent
    if (e.type === "tool.approved" || e.type === "tool.rejected") {
      const pending = leaderApprovalQueue.get(e.id);
      if (pending) {
        leaderApprovalQueue.delete(e.id);
        if (e.type === "tool.approved") {
          executeTool(pending.toolName, pending.toolArgs, { agentId: pending.workerChildId }).then((r) => {
            if (getState().agents.get(pending.workerChildId)?.state === "done" || killedAgents.has(pending.workerChildId)) {
              process.stderr.write(`[${pending.workerChildId}] dropped Bash-approval tool.result — agent done during execution\n`);
              return;
            }
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
    secretary?.observe(e);

    // ── per-event debug logging ──────────────────────────────────────────────
    if (e.type === "agent.state") {
      process.stderr.write(`[${opts.id}] state→${e.state} acted=${actedThisTurn} sentUser=${sentToUserThisTurn} reportedParent=${reportedToParent} cont=${continuations} gaveUp=${gaveUp}\n`);
    }
    if (e.type === "message") {
      process.stderr.write(`[${opts.id}] message to=${e.to} "${e.text.slice(0, 120)}"\n`);
    }
    if (e.type === "todo.set") {
      // M1-7 (BC-001): a plan-only turn is NOT an action. Emitting todo.set
      // without a tool.call/spawn/message/done leaves actedThisTurn=false so
      // the idle handler routes to the "强制执行" nudge instead of the softer
      // "acted-but-todo-pending" one. This unifies leader with worker (whose
      // workerActedThisTurn is already not set by todo.set) — "催了才干活" fix.
      const summary = (e.items as Array<{state: string; text: string}>).map((t) => `[${t.state}]${t.text.slice(0,30)}`).join(", ");
      process.stderr.write(`[${opts.id}] todo.set ${e.items.length} items: ${summary}\n`);
    }
    if (e.type === "tool.call") {
      process.stderr.write(`[${opts.id}] tool.call ${e.name}(${JSON.stringify(e.args).slice(0, 100)})\n`);
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (e.type === "agent.state" && e.state === "run") {
      turnShadow.beginTurn();
      actedThisTurn = false;
      sentToUserThisTurn = false;
      reportedToParent = false;
      lastToolCallKey = "";
      sameToolCallCount = 0;
      if (!nudgePending) { continuations = 0; gaveUp = false; }
      else qualNudges++; // nudgePending=true means this run was system-initiated
      nudgePending = false;
      qualTurns++;
    }

    if (e.type === "tool.call") {
      actedThisTurn = true;
      turnShadow.markAction();
      const toolKey = `${e.name}:${JSON.stringify(e.args)}`;
      if (toolKey === lastToolCallKey) { sameToolCallCount++; } else { lastToolCallKey = toolKey; sameToolCallCount = 1; }
      if (!toolNeedsApproval(e.name, e.args as Record<string, unknown>)) {
        toolQueue.push(e);
      } else if (opts.conversationMode) {
        // Feishu/conversation mode: PM is the authority — auto-approve destructive tools.
        // No human is watching the TUI to click y/n.
        process.stderr.write(`[${opts.id}] auto-approve tool "${e.name}" (conversationMode)\n`);
        toolQueue.push(e);
      } else if (!opts.parentId) {
        // Root PM in normal mode has no parent to approve — return error so agent can recover.
        setImmediate(() => {
          applyEvent({ v: 1, type: "tool.result", agent: opts.id, id: e.id, ok: false,
            output: `Tool "${e.name}" requires approval. Root leader has no parent to approve — use a non-destructive alternative or rephrase the command.` });
          a.sendCommand({ type: "tool.result", id: e.id, ok: false,
            output: `Tool "${e.name}" requires approval. Root leader has no parent to approve — use a non-destructive alternative or rephrase the command.` });
        });
      }
      // else: non-root leader routes to parent via leaderApprovalQueue (handled below)
    }

    if (e.type === "message") {
      actedThisTurn = true;
      if (e.to === "user") {
        sentToUserThisTurn = true;
        turnShadow.markUserReply();
        // All suppression, format, and sanitization decisions are centralised in the
        // OutboundGateway. Pass _fallback through so SuppressFilter can catch it.
        opts.replyHook?.(e.text, e.format, { _fallback: (e as any)._fallback, agentId: e.agent });
      }
      if (opts.parentId && e.to === opts.parentId) {
        reportedToParent = true;
        turnShadow.markParentReport();
        // Extract any file paths TL reported to PM so they can be injected at PM's turnEnd.
        const pathMatches = e.text.match(
          /(?:[A-Za-z]:[\\/]|\/|\.\/)(?:[^\s,，。）\]"'\n\\]+)\.(?:md|txt|json|csv|yaml|yml)/gi,
        );
        if (pathMatches?.length) {
          const pending = pmPendingArtifacts.get(opts.parentId) ?? [];
          for (const p of pathMatches) pending.push(p);
          pmPendingArtifacts.set(opts.parentId, pending);
          process.stderr.write(`[${opts.id}] artifact paths captured for ${opts.parentId}: ${pathMatches.join(", ")}\n`);
        }
      }
      if (e.to !== "user" && (!opts.parentId || e.to !== opts.parentId)) {
        turnShadow.markAction();
      }
      if (e.to !== "user") {
        const routed = globalBus.routeMessage(opts.id, e.to, e.text);
        if (!routed) {
          a.sendCommand({
            type: "user.message",
            text: `[系统] 消息无法送达：agent "${e.to}" 不存在或已结束。请重新 spawn，或 message→user 说明情况。`,
          });
        }
      }
    }

    if (e.type === "token.usage") {
      if (e.ttft_ms !== undefined) lastTtftMs = e.ttft_ms;
      if (e.total_ms !== undefined) lastTotalMs = e.total_ms;
    }

    if (e.type === "agent.done") {
      actedThisTurn = true;
      turnShadow.markAction();
      if (opts.parentId || opts.isForkedTask) {
        terminalEventAccepted = true;
        toolQueue.length = 0;
      }
      if (!opts.isForkedTask) {
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
        const sessionHash = secretary?.getMemory()?.session_hash ?? "?";
        process.stderr.write(
          `[quality] ${opts.id} session=${sessionHash} score=${score}` +
          ` success=${e.success} turns=${qualTurns} nudges=${qualNudges}` +
          ` handup=${qualHandup} gaveUp=${gaveUp} rejects=${rejects}` +
          ` tokens_in=${tok?.prompt ?? 0} tokens_out=${tok?.completion ?? 0}` +
          ` evidence=${e.evidence?.length ?? 0}` +
          ` latency=${opts.id}:${lastTtftMs}/${lastTotalMs}\n`,
        );
        if (!opts.parentId) setPendingRating(opts.id, sessionHash);
      } else {
        // Forked task done — clean up bus registration (no memory to delete).
        globalBus.unregisterAgent(opts.id);
      }
    }
    // Tech Lead completion — notify parent PM + ingest memory upward
    if (e.type === "agent.done" && opts.parentId) {
      const pmSec = secretaries.get("pm");
      if (pmSec && secretary) pmSec.ingestChildMemory(secretary.getMemory() as any);
      // Resolve foreground tracking so parent's pm.getForegroundChildren() reflects completion
      pm.completeForeground(opts.id, { success: e.success, reason: e.reason, evidence: e.evidence });
      const parentAgent = agents.get(opts.parentId);
      // Don't wake a killed/finished parent — child completion should not restart it.
      const parentState = getState().agents.get(opts.parentId)?.state;
      if (!killedAgents.has(opts.parentId) && parentState !== "done" && parentAgent instanceof HttpConvAgent) {
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
      globalBus.unregisterAgent(opts.id);
      if (!opts.isForkedTask) deleteAgentMemory(opts.id);
    }

    if (e.type === "unit.handup") {
      qualHandup = true;
      turnShadow.markParentReport();
    }

    // unit.handup — forward to parent
    if (e.type === "unit.handup" && opts.parentId) {
      // Capture artifact paths for PM's forced document injection at turnEnd.
      if (e.artifacts?.length) {
        const pending = pmPendingArtifacts.get(opts.parentId) ?? [];
        for (const p of e.artifacts) pending.push(p);
        pmPendingArtifacts.set(opts.parentId, pending);
        process.stderr.write(`[${opts.id}] handup artifacts captured for ${opts.parentId}: ${e.artifacts.join(", ")}\n`);
      }
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
      turnShadow.endTurn();
      logTurnShadow();
      if (toolQueue.length > 0) {
        // Loop detection: warn before draining if same tool called 2+ times in a row
        if (sameToolCallCount >= 2) {
          const loopTool = lastToolCallKey.split(":")[0] ?? "";
          process.stderr.write(`[${opts.id}] loop-detect: ${loopTool} called same args ${sameToolCallCount}x\n`);
          const warnMsg = `【系统-循环检测】你已连续 ${sameToolCallCount} 次调用相同的 ${loopTool}，得到相同结果。换一个不同的工具或不同参数，否则任务将无法推进。`;
          setImmediate(() => {
            if (getState().agents.get(opts.id)?.state === "done" || killedAgents.has(opts.id)) return;
            a.sendCommand({ type: "user.message", text: warnMsg });
          });
          sameToolCallCount = 0;
        }
        const batch = toolQueue.splice(0);
        setImmediate(async () => {
          if (getState().agents.get(opts.id)?.state === "done" || killedAgents.has(opts.id)) return;
          const results = await Promise.all(batch.map((c) => executeTool(c.name, c.args, { agentId: opts.id })));
          // Defer delivery via setImmediate so the I/O phase can drain SSE events (including
          // agent.done from the LLM stream) before we re-check and deliver. A microtask
          // continuation here would fire BEFORE pending SSE I/O, missing a concurrent agent.done.
          setImmediate(() => {
            if (getState().agents.get(opts.id)?.state === "done" || killedAgents.has(opts.id)) {
              process.stderr.write(`[${opts.id}] dropped tool.result for ${batch.length} tool(s) — agent done during execution\n`);
              return;
            }
            for (let i = 0; i < batch.length; i++) {
              const { id } = batch[i]!;
              const { ok, output } = results[i]!;
              applyEvent({ v: 1, type: "tool.result", agent: opts.id, id, ok, output });
            }
            // Feed combined results back to the LLM — without this the PM hangs indefinitely.
            // Use user.message so the [tool_result id=...] headers in `combined` aren't
            // double-wrapped (sendCommand type:"tool.result" would add an extra header).
            const combined = batch.map((c, i) =>
              `[tool_result id="${c.id}" ok="${results[i]!.ok}"]\n${results[i]!.output}`
            ).join("\n\n");
            a.sendCommand({ type: "user.message", text: combined });
          });
        });
      } else if (actedThisTurn) {
        const todos = getState().todosByAgent.get(opts.id) ?? [];
        const hasRun = todos.some((t) => t.state === "run");
        const hasTodo = todos.some((t) => t.state === "todo");
        const activeChildren = Array.from(getState().agents.values())
          .filter((ag) => ag.parent === opts.id && (ag.state === "run" || ag.state === "idle"));
        process.stderr.write(`[${opts.id}] idle/acted hasTodo=${hasTodo} hasRun=${hasRun} activeChildren=${activeChildren.length} sentUser=${sentToUserThisTurn} reportedParent=${reportedToParent} convMode=${!!opts.conversationMode} cont=${continuations}\n`);
        // Belt-and-suspenders: also check foreground spawn handles (registered synchronously,
        // not subject to the spawn→run state transition race that activeChildren can miss)
        const foregroundChildren = pm.getForegroundChildren(opts.id);
        const hasActiveChildren = activeChildren.length > 0 || foregroundChildren.length > 0;
        if (hasActiveChildren) {
          process.stderr.write(`[${opts.id}] idle → waiting for children: store=[${activeChildren.map(c => c.id).join(",")}] fg=[${foregroundChildren.join(",")}]\n`);
        } else if (reportedToParent && !hasTodo) {
          process.stderr.write(`[${opts.id}] idle → reportedToParent+done, closing run items\n`);
          if (hasRun) {
            const closed = todos.map((t) => ({ ...t, state: t.state === "run" ? "done" : t.state }));
            applyEvent({ v: 1, type: "todo.set", agent: opts.id, items: closed as any });
          }
        } else if (sentToUserThisTurn && opts.conversationMode && !hasTodo && !hasActiveChildren) {
          // Conversation mode: replied to user, no pending todos, no in-flight children → done
          process.stderr.write(`[${opts.id}] idle → conversationMode replied+no-todos+no-children, done\n`);
          drainConvModePM(false);
        } else if (sentToUserThisTurn && opts.conversationMode && hasTodo) {
          // Conversation mode: replied to user but still has todos. (hasActiveChildren is already
          // false here — the 1297 branch caught it.) Nudge to finish; if nudges are exhausted,
          // converge anyway so the PM releases feishuBusy + drains queued follow-ups instead of
          // holding the serial lock forever (only-replies-once bug after spawning a TL).
          process.stderr.write(`[${opts.id}] idle → conversationMode replied but hasTodo, nudging cont=${continuations}\n`);
          if (continuations < 3) {
            continuations++;
            nudgePending = true;
            const pendingTodos = todos.filter((t) => t.state === "todo").map((t) => t.text).join("; ");
            setImmediate(() => {
              if (getState().agents.get(opts.id)?.state === "done" || killedAgents.has(opts.id)) return;
              a.sendCommand({ type: "user.message", text: `【系统】你回复了用户但还有未完成任务：${pendingTodos}。立刻执行。` });
            });
          } else {
            // Nudges exhausted — stale meta-todos (work already delegated to a finished TL) must
            // not trap the PM. Auto-close them, release feishuBusy, dispatch next follow-up.
            process.stderr.write(`[${opts.id}] idle → conversationMode replied + nudges exhausted, converging\n`);
            drainConvModePM(true);
          }
        } else if (sentToUserThisTurn && !hasTodo && (opts.conversationMode || !opts.parentId)) {
          // PM replied to user and has no pending tasks — done, nothing to nudge.
          // Make-way guard: sub-Leaders fall through to the dead-zone fallback below.
          process.stderr.write(`[${opts.id}] idle → replied+no-todos, done\n`);
        } else if (hasRun && !hasTodo && (opts.conversationMode || !opts.parentId)) {
          // Make-way guard: sub-Leaders fall through to the dead-zone fallback below.
          process.stderr.write(`[${opts.id}] idle → hasRun+no-todo, auto-close run items\n`);
          const closed = todos.map((t) => ({ ...t, state: t.state === "run" ? "done" : t.state }));
          applyEvent({ v: 1, type: "todo.set", agent: opts.id, items: closed as any });
        } else if (hasTodo && continuations < 3) {
          continuations++;
          const pendingTodos = todos.filter((t) => t.state === "todo").map((t) => t.text).join("; ");
          process.stderr.write(`[${opts.id}] idle → nudge cont=${continuations} pending="${pendingTodos.slice(0,80)}"\n`);
          nudgePending = true;
          setImmediate(() => {
            if (getState().agents.get(opts.id)?.state === "done" || killedAgents.has(opts.id)) return;
            a.sendCommand({
              type: "user.message",
              text: `【系统】todo 未完成：${pendingTodos}。立刻执行下一步（tool.call 或 spawn 或直接回答）。`,
            });
          });
        } else if (hasTodo && (opts.conversationMode || !opts.parentId)) {
          // Make-way guard: sub-Leaders fall through to the dead-zone fallback below.
          process.stderr.write(`[${opts.id}] idle → gaveUp after 3 nudges\n`);
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
            if (getState().agents.get(opts.id)?.state === "done" || killedAgents.has(opts.id)) return;
            a.sendCommand({
              type: "user.message",
              text: `【系统】你回复了但没有输出 todo.set。立刻输出 todo.set 列出当前计划，然后执行第一步。`,
            });
          });
        } else if (opts.conversationMode) {
          // Defensive fall-through: acted (spawn/tool/message) but no branch above matched.
          // This happens when PM spawned a TL that died before completing, or exhausted nudges
          // without ever sending a user reply. Release the serial queue to prevent deadlock.
          process.stderr.write(`[${opts.id}] idle → actedThisTurn+conversationMode+no-branch-matched, releasing feishuBusy\n`);
          opts.turnEndHook?.();
          feishuBusy.delete(opts.id);
        } else if (!opts.conversationMode && opts.parentId && !hasActiveChildren && !reportedToParent) {
          // Child-Leader dead-zone fallback (link A — acted). Any sub-Leader that acted but was
          // not converged by a specific exit above (made-way 1307/1346/1362, or fell through)
          // lands here. !hasActiveChildren protects a TL still waiting on a worker; !reportedToParent
          // skips those already handled by the reportedToParent exit.
          convergeChildLeader("idle-acted-deadzone");
        }
      } else if (!actedThisTurn && !gaveUp) {
        const todos = getState().todosByAgent.get(opts.id) ?? [];
        const hasPending = todos.some((t) => t.state === "todo" || t.state === "run");
        const activeChildren2 = Array.from(getState().agents.values())
          .filter((ag) => ag.parent === opts.id && (ag.state === "run" || ag.state === "idle"));
        process.stderr.write(`[${opts.id}] idle/no-action hasPending=${hasPending} activeChildren=${activeChildren2.length} cont=${continuations}\n`);
        if (hasPending && activeChildren2.length > 0) {
          process.stderr.write(`[${opts.id}] idle → waiting for children: ${activeChildren2.map(c => c.id).join(",")}\n`);
        } else if (hasPending && continuations < 3) {
          continuations++;
          const pendingTodos = todos.filter((t) => t.state === "todo" || t.state === "run").map((t) => t.text).join("; ");
          process.stderr.write(`[${opts.id}] idle → nudge(no-action) cont=${continuations} pending="${pendingTodos.slice(0,80)}"\n`);
          nudgePending = true;
          setImmediate(() => {
            if (getState().agents.get(opts.id)?.state === "done" || killedAgents.has(opts.id)) return;
            const pending2 = todos.filter((t: {state:string;text:string}) => t.state === "todo" || t.state === "run").map((t: {text:string}) => t.text).join("; ");
            a.sendCommand({ type: "user.message", text: `【系统-强制执行】你已经规划了 todo 但没有采取任何行动。现在必须立刻输出以下之一：\n1. spawn 指令（如果需要 TL 执行）\n2. tool.call 指令（如果 PM 自己能处理）\n3. message.to=user（如果可以直接回答）\n未完成项：${pending2}\n不允许再次只输出 todo.set 或 step。` });
          });
        } else if (hasPending && (opts.conversationMode || !opts.parentId)) {
          // Make-way guard: sub-Leaders fall through to the link-B dead-zone fallback below.
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
            if (getState().agents.get(opts.id)?.state === "done" || killedAgents.has(opts.id)) return;
            a.sendCommand({
              type: "user.message",
              text: "【系统-回复缺失】你刚才处理了消息但没有输出任何内容（无 message、无 tool.call、无 spawn）。请立刻 message→user 回复用户，或说明你在等待什么。",
            });
          });
        } else if (!opts.conversationMode && opts.parentId && activeChildren2.length === 0 && pm.getForegroundChildren(opts.id).length === 0 && !reportedToParent) {
          // Child-Leader dead-zone fallback (link B — no action). Sub-Leader took no action,
          // nudges exhausted (or no pending work), no active children, never reported — converge.
          convergeChildLeader("idle-noaction-deadzone");
        } else {
          continuations = 0;
        }
      } else if (!opts.conversationMode && opts.parentId && !reportedToParent) {
        // Top-level dead-zone fallback: a sub-Leader with actedThisTurn=false && gaveUp=true
        // falls through BOTH chains above (acted chain and !acted&&!gaveUp chain). Converge it
        // with gave-up semantics (relay an explicit "abandoned" notice, not stale prose).
        const hasKids = Array.from(getState().agents.values())
          .some((ag) => ag.parent === opts.id && (ag.state === "run" || ag.state === "idle"))
          || pm.getForegroundChildren(opts.id).length > 0;
        if (!hasKids) convergeChildLeader("gaveup-deadzone", { gaveUp: true });
      }
    }
  });

  secretary?.on("event", (e: TuiEvent) => applyEvent(e));

  a.on("_raw_message", (m: { role: "user" | "assistant"; content: string }) => {
    secretary?.observeMessage(m.role, m.content);
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

function startWorker(
  e: Extract<TuiEvent, { type: "spawn" }>,
  opts: { resumedMemoryId?: string; firstMessage?: string } = {},
): void {
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
    // Register foreground tracking for TL (same pattern as Worker below).
    // Must happen AFTER startLeaderAgent so the child is in the agents Map.
    const tlHandle = pm.registerSpawn(e.child, e.parent);
    tlHandle.promise.then((syncResult) => {
      if (syncResult === null) {
        const parentAgent = agents.get(e.parent);
        if (parentAgent instanceof HttpConvAgent) {
          parentAgent.sendCommand({
            type: "user.message",
            text: `[系统] ${e.child} 已超过 2 分钟，自动切换为后台模式。完成时会通过 task-notification 通知你。`,
          });
        }
      }
    });
    return;
  }

  const cfg = loadConfig();
  const baseWorkerProviderCfg = getAgentProviderConfig(cfg, "worker");
  const workerModel = e.model ?? baseWorkerProviderCfg.model;
  if (!workerModel) {
    applyEvent({ v: 1, type: "agent.error", agent: e.parent,
      code: "no_worker_model", detail: "No model configured for worker — use /model worker <model-name>" });
    return;
  }
  const workerProviderCfg = { ...baseWorkerProviderCfg, ...(e.model ? { model: e.model } : {}) };

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

  const systemPrompt = buildSystemPrompt(
    e.role, e.child, e.goal, opts.resumedMemoryId,
    e.dispatch?.prompt_file ?? undefined,
  );
  const a = new HttpConvAgent({
    id: e.child,
    role: e.role,
    providerCfg: workerProviderCfg,
    systemPrompt,
    resumeFrom: opts.resumedMemoryId,
  });
  agents.set(e.child, a);
  globalBus.registerAgent(e.child, a);

  // S2: Secretary for this Worker
  const dispatch = e.dispatch ?? {
    background: e.goal,
    constraints: [],
    acceptance_criteria: ["agent.done"],
    stop_conditions: ["agent.done"],
  };
  const existingMem = opts.resumedMemoryId ? loadMemory(e.child) : null;
  const mem = existingMem ?? createMemory({
    agentId: e.child,
    agentType: e.role === "Secretary" ? "SECRETARY" : "WORKER",
    parentChain,
    depth: parentDepth + 1,
    model: workerModel,
    roleName: e.role,
    dispatch,
  });
  const secretary = new SecretaryProxy(mem, { startNewSession: !existingMem });
  secretaries.set(e.child, secretary);

  // Pending tool calls emitted during one send() round — batched and executed on idle
  const toolQueue: Array<Extract<TuiEvent, { type: "tool.call" }>> = [];
  let workerActedThisTurn = false;
  let workerContinuations = 0;
  let workerGaveUp = false;
  let workerCorrectedThisTurn = false; // deduplicate illegal_message corrections per turn
  let workerNudgePending = false; // true when the next run turn is a system-initiated nudge
  let wLastToolKey = "";
  let wSameToolCount = 0;
  let wDoneNotified = false; // guard: only send completion notification to parent once
  let workerTerminal = false; // once agent.done is accepted, drop delayed/prose/tool events
  const workerTurnShadow = new TurnController();
  const logWorkerTurnShadow = (): void => {
    if (process.env.SPAWN_SHADOW_TURN !== "1") return;
    process.stderr.write(`[TurnController:shadow] ${e.child} ${JSON.stringify(workerTurnShadow.snapshot())}\n`);
  };
  // Coding completion guard: tracks last RunTests outcome.
  // Non-null means the worker called RunTests at least once this session.
  let wLastTestFailed: number | null = null; // null=never run, 0=all pass, N=N failures
  let wLastRunTestsSummary = "";
  // Test-evidence tracking for completion guard (covers Bash test runs, not just the RunTests tool):
  let wRanTestCommand = false;           // worker invoked RunTests OR a test-runner Bash cmd this session
  let wTestAttemptedButNoResult = false; // a test run produced NO parseable result (ECONNABORTED / cmd error / empty)

  // Circuit breaker constants
  const MAX_WORKER_TURNS = 40;
  const MAX_CONSEC_FAIL_TOOLS = 5;
  // Consecutive tool-failure counter — reset on any successful tool result
  let wConsecToolFails = 0;

  // Hard circuit (#2 main-chain liveness / full-duplex 地基): force-converge a stalled worker so it
  // can NEVER hold `active` forever and lock its TL/PM back into half-duplex. Unlike the nudge/escalate
  // path (workerContinuations resets on non-nudge runs → never reaches the gaveUp escalate, and even
  // that only notifies parent without agent.done), these counters are NOT resettable and ALWAYS end in
  // a forced agent.done(false) that releases `active`.
  const WORKER_HARD_STALL_N = 5;         // consecutive no-progress idle turns → circuit (early-stop 主力)
  const WORKER_HARD_MS = 15 * 60 * 1000; // wall-clock cap (防爆兜底, 宁松勿紧, 早停靠 stall)
  let wStallCount = 0;                    // turns with NO action AND NO queued tools (network-error空转/死锁)
  const wHardStartTs = Date.now();        // worker spawn wall-clock origin
  let wHardCircuitFired = false;          // one-shot guard
  let wLastFailOutput = "";               // most recent failing tool output (for handup last-error ③)

  // Quality tracking for worker
  let wQualTurns = 0;
  let wQualNudges = 0;
  let wQualHandup = false;
  let wLastTtftMs = 0;
  let wLastTotalMs = 0;

  const isTestRunnerBash = (ev: Extract<TuiEvent, { type: "tool.call" }>): boolean => {
    if (ev.name !== "Bash") return false;
    const cmd = typeof ev.args === "object" && ev.args !== null
      ? String((ev.args as Record<string, unknown>).command ?? (ev.args as Record<string, unknown>).cmd ?? "")
      : "";
    return /\b(?:npm\s+test|node\s+--test|bun\s+test|vitest|jest|pytest|cargo\s+test|go\s+test)\b/i.test(cmd);
  };

  // Force-converge a hard-stalled worker. Emits handup (③: 已完成 + 卡点 + 最后错误 — 半成品不随熔断丢)
  // THEN agent.done(false). Both flow through the existing handup/done handlers, which notify the parent
  // via sendCommand → the parent's QUEUE (⑤: never preempts the parent's in-flight turn). The done(false)
  // reuses the existing failure-notify path (④: TL → message→user with 重试/换方法/放弃 options), so the
  // background task's outcome flows back into the conversation on its own — no need for the user to ask.
  const fireHardCircuit = (reason: string): void => {
    if (wHardCircuitFired) return;
    if (getState().agents.get(e.child)?.state === "done" || killedAgents.has(e.child)) return;
    wHardCircuitFired = true;
    const todos = getState().todosByAgent.get(e.child) ?? [];
    const doneTodos = todos.filter((t) => t.state === "done").map((t) => t.text);
    const stuckTodo = todos.find((t) => t.state === "run" || t.state === "todo")?.text ?? "(无明确 todo)";
    const lastErr = wLastFailOutput || "(无捕获错误，疑似网络重试无产出 / 空转)";
    const elapsedMs = Date.now() - wHardStartTs;
    recordHealthMetric({
      agent_id: e.child,
      event_type: "hard_circuit_fired",
      severity: "critical",
      reason,
      latency_ms: elapsedMs,
      meta: {
        parent: e.parent,
        stallCount: wStallCount,
        stuckTodo,
        doneTodos,
        lastError: lastErr.replace(/\s+/g, " ").slice(0, 500),
      },
    });
    process.stderr.write(
      `[hard-circuit] worker=${e.child} reason=${reason} stall=${wStallCount} ` +
      `elapsed=${Math.round(elapsedMs / 1000)}s stuck-todo="${stuckTodo}" ` +
      `last-error="${lastErr.replace(/\s+/g, " ").slice(0, 120)}"\n`,
    );
    a.emit("event", {
      v: 1, type: "unit.handup", agent: e.child, parent: e.parent,
      summary: `[硬熔断:${reason}] 已完成: ${doneTodos.join("; ") || "(无)"}；卡在: ${stuckTodo}；最后错误: ${lastErr.replace(/\s+/g, " ").slice(0, 200)}`,
      artifacts: [], facts_to_promote: [], decisions: [], failed_acceptance: [stuckTodo],
    } as TuiEvent);
    a.emit("event", {
      v: 1, type: "agent.done", agent: e.child, success: false, reason: `hard-circuit ${reason}`,
    } as TuiEvent);
  };

  a.on("event", (ev: TuiEvent) => {
    if (workerTerminal && ev.type !== "token.usage") {
      process.stderr.write(`[${e.child}] dropped ${ev.type} after terminal agent.done\n`);
      return;
    }

    // spawn: pre-check BEFORE applyEvent to prevent ghost agents in store
    if (ev.type === "spawn") {
      // Auto-rename on ID collision (concurrent forks often generate "tl-01" collisions).
      // Register a bus alias so parent's future message.to=originalId still routes to the renamed child.
      const resolvedSpawnEv = agents.has(ev.child)
        ? (() => {
            const newChildId = `${ev.child}-${Date.now().toString(36).slice(-4)}`;
            process.stderr.write(`[${e.child}] spawn auto-rename: "${ev.child}"→"${newChildId}" (ID collision)\n`);
            globalBus.addAlias(ev.child, newChildId);
            return { ...ev, child: newChildId };
          })()
        : ev;
      // Normalize parent to actual spawner ID
      const normalizedEv = resolvedSpawnEv.parent !== e.child
        ? resolvedSpawnEv
        : { ...resolvedSpawnEv, parent: e.child };
      const parentRole = getState().agents.get(e.child)?.role;
      const check = pm.preCheckSpawn(normalizedEv, parentRole);
      if (!check.ok) {
        applyEvent({ v: 1, type: "agent.error", agent: e.child, code: check.code, detail: check.detail });
        return;
      }
      workerActedThisTurn = true;
      workerTurnShadow.markAction();
      applyEvent(normalizedEv);
      pm.observe(normalizedEv);
      secretary.observe(normalizedEv);
      startWorker(normalizedEv);
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
      // Non-root Leader (TL) must report to parent (PM), never directly to user.
      // e.parent is always set for TL (root PM has no parent).
      const isTLToUser = senderRole === "Leader" && ev.to === "user" && !!e.parent;
      if (isWorkerToUser || isWorkerToWorker || isTLToUser) {
        workerActedThisTurn = true; // prevent auto-continuation nudge loop
        workerTurnShadow.markAction();
        // _fallback messages are internal protocol noise (LLM wrote prose instead of JSON).
        // Drop silently — don't redirect to PM or it pollutes PM's context.
        if ((ev as any)._fallback) {
          process.stderr.write(`[${e.child}] discarded _fallback protocol noise (to=${ev.to}): "${ev.text.slice(0, 80)}"\n`);
          return;
        }
        // Auto-forward to parent so the report is never lost, then correct.
        if (globalBus.hasAgent(e.parent)) {
          const redirected = { ...ev, to: e.parent } as typeof ev;
          applyEvent(redirected);      // store as child→parent (visible in both panes)
          globalBus.routeMessage(e.child, e.parent, ev.text, { prefix: `[${e.child}→${e.parent}]` });
        }
        if (!workerCorrectedThisTurn) {
          workerCorrectedThisTurn = true;
          const detail = isTLToUser
            ? `TL ${ev.agent} message.to=user 越级 — 已自动转发至 ${e.parent}（PM）。TL 汇报对象为 PM，不得直接联系用户。`
            : `Worker ${ev.agent} message.to=${ev.to} 违规 — 已自动转发至 ${e.parent} 并纠正。`;
          applyEvent({ v: 1, type: "agent.error", agent: ev.agent, code: "illegal_message", detail });
          pm.observe(ev);
          setImmediate(() => {
            if (getState().agents.get(e.child)?.state === "done" || killedAgents.has(e.child)) return;
            a.sendCommand({
              type: "user.message",
              text: isTLToUser
                ? `[系统-纠正] message.to=user 已拦截并转发给 PM（${e.parent}）。请使用 message.to=${e.parent}，由 PM 转发给用户。`
                : `[系统-纠正] message.to=${ev.to} 违规已被自动转发至 ${e.parent}。下次请直接使用 message.to=${e.parent}，然后 agent.done。`,
            });
          });
        }
        return;
      }
    }

    // Coding completion guard: if RunTests was run and failed, block success claims.
    // Intercepted BEFORE applyEvent so the "done" state is never committed.
    if (ev.type === "agent.done" && ev.success && wLastTestFailed !== null && wLastTestFailed > 0) {
      process.stderr.write(
        `[${e.child}] completion guard: blocked agent.done(success) — RunTests shows ${wLastTestFailed} failure(s)\n`,
      );
      recordHealthMetric({
        agent_id: e.child,
        event_type: "test_failed_but_claimed_done",
        severity: "critical",
        reason: `agent_done_success_blocked_with_${wLastTestFailed}_test_failures`,
        meta: {
          parent: e.parent,
          failedTests: wLastTestFailed,
          runTestsSummary: wLastRunTestsSummary,
        },
      });
      recordHealthMetric({
        agent_id: e.child,
        event_type: "agent_done_blocked_by_guard",
        severity: "warn",
        reason: "test_failed_but_claimed_done",
        meta: {
          parent: e.parent,
          failedTests: wLastTestFailed,
        },
      });
      setImmediate(() => {
        if (killedAgents.has(e.child) || getState().agents.get(e.child)?.state === "done") return;
        a.sendCommand({
          type: "user.message",
          text: `[系统-测试未通过] 你声明 success:true，但最近一次 RunTests 显示 ${wLastTestFailed} 个失败。` +
                `必须先修复所有失败的测试，然后重新运行 RunTests 确认全绿，再 agent.done。`,
        });
      });
      return; // Reject: keep agent running so it can fix the failures
    }
    // 方案2(证据判定，非关键词)：worker 跑过测试命令(wRanTestCommand)，却从未取得有效通过记录
    // (wLastTestFailed 仍为 null — failN>0 已被上面拦，0 是真全绿放行)，却声称 success → 拦截。
    if (ev.type === "agent.done" && ev.success && wRanTestCommand && wLastTestFailed === null) {
      process.stderr.write(
        `[${e.child}] completion guard: blocked agent.done(success) — ran test cmd but NO valid test result (attempted=${wTestAttemptedButNoResult})\n`,
      );
      recordHealthMetric({
        agent_id: e.child,
        event_type: "agent_done_blocked_by_guard",
        severity: "warn",
        reason: "missing_valid_test_evidence",
        meta: {
          parent: e.parent,
          testAttemptedButNoResult: wTestAttemptedButNoResult,
        },
      });
      setImmediate(() => {
        if (killedAgents.has(e.child) || getState().agents.get(e.child)?.state === "done") return;
        a.sendCommand({
          type: "user.message",
          text: `[系统-无测试证据] 你声称 success:true，但系统没有任何有效的测试运行记录` +
                `（测试命令跑过但未产出可解析的 pass/fail 计数，可能因网络中断、命令不存在或输出为空）。` +
                `必须真正跑通测试并确认全绿（RunTests 或 node --test 输出含 pass≥1 且 fail 为 0），再 agent.done。`,
        });
      });
      return; // Reject: no valid test evidence for a success claim
    }

    applyEvent(ev);
    pm.observe(ev);
    secretary.observe(ev);

    // ── per-event debug logging ──────────────────────────────────────────────
    if (ev.type === "agent.state") {
      process.stderr.write(`[${e.child}] state→${ev.state} acted=${workerActedThisTurn} cont=${workerContinuations} gaveUp=${workerGaveUp}\n`);
    }
    if (ev.type === "message") {
      process.stderr.write(`[${e.child}] message to=${ev.to} "${ev.text.slice(0, 120)}"\n`);
    }
    if (ev.type === "todo.set") {
      const summary = (ev.items as Array<{state: string; text: string}>).map((t) => `[${t.state}]${t.text.slice(0,30)}`).join(", ");
      process.stderr.write(`[${e.child}] todo.set ${ev.items.length} items: ${summary}\n`);
    }
    if (ev.type === "tool.call") {
      process.stderr.write(`[${e.child}] tool.call ${ev.name}(${JSON.stringify(ev.args).slice(0, 100)})\n`);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Forward worker→parent communication to the parent LLM ────────────────
    // Without this, leader spawns a worker but never hears back — hangs forever.
    if (ev.type === "message" && ev.to === e.parent) {
      globalBus.routeMessage(e.child, e.parent, ev.text, { prefix: `[${e.child}→${e.parent}]` });
    }
    if (ev.type === "token.usage") {
      if (ev.ttft_ms !== undefined) wLastTtftMs = ev.ttft_ms;
      if (ev.total_ms !== undefined) wLastTotalMs = ev.total_ms;
    }
    if (ev.type === "agent.state" && ev.state === "run") {
      workerTurnShadow.beginTurn();
      if (workerNudgePending) wQualNudges++;
      wQualTurns++;
      // Hard turn limit — force handup so worker can't loop indefinitely
      if (wQualTurns >= MAX_WORKER_TURNS) {
        setImmediate(() => {
          if (getState().agents.get(e.child)?.state === "done" || killedAgents.has(e.child)) return;
          a.sendCommand({
            type: "user.message",
            text: `[系统-轮数上限] 你已使用 ${wQualTurns} 轮，达到上限 ${MAX_WORKER_TURNS} 轮。必须在本轮内完成任务或立即 unit.handup 给 ${e.parent}（含当前进展和卡点），不允许继续下一轮。`,
          });
        });
      }
    }
    if (ev.type === "unit.handup") wQualHandup = true;
    if (ev.type === "agent.done") {
      workerTerminal = true;
      toolQueue.length = 0;
      workerActedThisTurn = true;
      workerTurnShadow.markAction();
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
        ` evidence=${ev.evidence?.length ?? 0}` +
        ` latency=${e.child}:${wLastTtftMs}/${wLastTotalMs}\n`,
      );
      // Resolve foreground tracking so parent's pm.getForegroundChildren() reflects completion
      pm.completeForeground(e.child, { success: ev.success, reason: ev.reason, evidence: ev.evidence });
      const parentAgent = agents.get(e.parent);
      // Don't wake a killed/finished parent.
      const parentSt = getState().agents.get(e.parent)?.state;
      // Guard: only notify parent once — workers can emit agent.done multiple times if nudged
      if (!wDoneNotified && !killedAgents.has(e.parent) && parentSt !== "done" && parentAgent instanceof HttpConvAgent) {
        wDoneNotified = true;
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
      globalBus.unregisterAgent(e.child);
      deleteAgentMemory(e.child);
    }
    if (ev.type === "unit.handup") {
      workerTurnShadow.markParentReport();
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
      workerTurnShadow.markAction();
      if (ev.name === "RunTests" || isTestRunnerBash(ev)) wRanTestCommand = true;
      const wToolKey = `${ev.name}:${JSON.stringify(ev.args)}`;
      if (wToolKey === wLastToolKey) { wSameToolCount++; } else { wLastToolKey = wToolKey; wSameToolCount = 1; }
      if (wSameToolCount >= 3) {
        const output =
          `[系统-重复工具拦截] 你已连续 ${wSameToolCount} 次调用相同的 ${ev.name} 和相同参数。` +
          `该调用已被拒绝，不会再次执行。请基于已有 tool.result 推进；` +
          `如果已完成，立即 message.to=${e.parent} 汇报并 agent.done。`;
        applyEvent({ v: 1, type: "tool.result", agent: e.child, id: ev.id, ok: false, output });
        a.sendCommand({ type: "user.message", text: output });
        return;
      }
      if (wLastTestFailed === 0 && (ev.name === "RunTests" || isTestRunnerBash(ev))) {
        const output =
          `[系统-测试已通过] 最近一次 RunTests 已全绿，禁止重复运行测试消耗时间。\n` +
          `${wLastRunTestsSummary}\n\n` +
          `现在必须 message.to=${e.parent} 汇报改动和测试结果，然后 agent.done(success:true)。`;
        applyEvent({ v: 1, type: "tool.result", agent: e.child, id: ev.id, ok: false, output });
        a.sendCommand({ type: "user.message", text: output });
        return;
      }
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
      if (ev.to === e.parent) workerTurnShadow.markParentReport();
      else if (ev.to === "user") workerTurnShadow.markUserReply();
      else workerTurnShadow.markAction();
    }

    // Agent 变 idle → 批量执行排队的工具并把结果回喂给 agent
    if (ev.type === "agent.state" && ev.state === "idle") {
      if (getState().agents.get(e.child)?.state === "done") return;
      workerTurnShadow.endTurn();
      logWorkerTurnShadow();
      // Hard-circuit stall tracking (#2): a turn with NO action AND NO queued tools = no progress
      // (network-error 空转 / idle 死锁 命中). NOT reset by nudges, so it eventually fires — unlike the
      // resettable workerContinuations path that network errors keep zeroing out.
      if (toolQueue.length === 0 && !workerActedThisTurn) wStallCount++;
      else wStallCount = 0;
      if (!wHardCircuitFired) {
        const elapsed = Date.now() - wHardStartTs;
        if (wStallCount >= WORKER_HARD_STALL_N) { fireHardCircuit(`stall x${wStallCount}`); return; }
        if (elapsed > WORKER_HARD_MS) { fireHardCircuit(`wall-clock ${Math.round(elapsed / 60000)}min`); return; }
      }
      if (toolQueue.length > 0) {
        if (wSameToolCount >= 2) {
          const loopTool = wLastToolKey.split(":")[0] ?? "";
          process.stderr.write(`[${e.child}] loop-detect: ${loopTool} called same args ${wSameToolCount}x\n`);
          const warnMsg = `【系统-循环检测】你已连续 ${wSameToolCount} 次调用相同的 ${loopTool}，得到相同结果。换一个不同的工具或不同参数。`;
          setImmediate(() => {
            if (getState().agents.get(e.child)?.state === "done" || killedAgents.has(e.child)) return;
            a.sendCommand({ type: "user.message", text: warnMsg });
          });
        }
        const batch = toolQueue.splice(0);
        setImmediate(async () => {
          // Guard: agent may have reached terminal state while this callback was queued.
          if (getState().agents.get(e.child)?.state === "done" || killedAgents.has(e.child)) return;
          const results = await Promise.all(batch.map((c) => executeTool(c.name, c.args, { agentId: e.child })));
          // Defer delivery via setImmediate so the I/O phase can drain SSE events (including
          // agent.done from the LLM stream) before we re-check and deliver. A microtask
          // continuation here would fire BEFORE pending SSE I/O, missing a concurrent agent.done.
          setImmediate(() => {
            if (getState().agents.get(e.child)?.state === "done" || killedAgents.has(e.child)) {
              process.stderr.write(`[${e.child}] dropped tool.result for ${batch.length} tool(s) — agent done during execution\n`);
              return;
            }
            for (let i = 0; i < batch.length; i++) {
              const { id } = batch[i]!;
              const { ok, output } = results[i]!;
              if (batch[i]!.name === "Edit" || batch[i]!.name === "Write") {
                wLastTestFailed = null;
                wLastRunTestsSummary = "";
                wTestAttemptedButNoResult = false;
              }
              // Track consecutive failures for circuit breaker + capture last failure for hard-circuit handup.
              if (ok) { wConsecToolFails = 0; } else { wConsecToolFails++; wLastFailOutput = output; }
              // Coding completion guard: track RunTests outcome so we can reject a
              // premature agent.done(success:true) when tests are still failing.
              if (batch[i]!.name === "RunTests") {
                const failMatch = output.match(/failed:\s*(\d+)/);
                wLastTestFailed = failMatch ? parseInt(failMatch[1]!, 10) : (ok ? 0 : 1);
                if (wLastTestFailed === 0) {
                  wTestAttemptedButNoResult = false;
                  const passMatch = output.match(/passed:\s*(\d+)/);
                  const skippedMatch = output.match(/skipped:\s*(\d+)/);
                  wLastRunTestsSummary =
                    `RunTests PASS: passed=${passMatch?.[1] ?? "?"}, failed=0, skipped=${skippedMatch?.[1] ?? "0"}`;
                }
              } else if (isTestRunnerBash(batch[i]!)) {
                // Bash 跑测试 — node test runner 格式 (# fail N / ℹ fail N)，独立正则，三态回填。
                // 全绿判定必须 passN ≥ 1：pass 0/fail 0(测试没跑起来的异常输出)不得判全绿，
                // 落到"无有效结果"被 guard 拦——worker 不能靠输出里有个 pass 字样蒙混。
                // BACKLOG: RunTests 分支的 `ok ? 0` 有同款"未真跑即判 0"隐患；两处全绿判定将来应
                // 抽成同一函数(要求 pass≥1)防逻辑漂移。本次范围内不改 RunTests 分支以免扩大。
                const failM = output.match(/(?:#|ℹ)\s*fail(?:ed)?\s+(\d+)/i);
                const passM = output.match(/(?:#|ℹ)\s*pass(?:ed)?\s+(\d+)/i);
                const failN = failM ? parseInt(failM[1]!, 10) : null;
                const passN = passM ? parseInt(passM[1]!, 10) : null;
                if (failN !== null && failN > 0) {
                  wLastTestFailed = failN;
                  wTestAttemptedButNoResult = false;
                } else if (passN !== null && passN > 0 && (failN === 0 || failN === null)) {
                  // 真全绿：至少 1 个 pass 且无 fail
                  wLastTestFailed = 0;
                  wTestAttemptedButNoResult = false;
                  wLastRunTestsSummary = `Bash test PASS: passed=${passN}, failed=${failN ?? 0}`;
                } else {
                  // pass 0 / fail 0 / 都解不出（ECONNABORTED、命令不存在、空输出）→ 无有效结果
                  wTestAttemptedButNoResult = true; // wLastTestFailed 保持 null
                }
              }
              applyEvent({ v: 1, type: "tool.result", agent: e.child, id, ok, output });
            }
            // Use user.message so the [tool_result id=...] headers in `combined` aren't
            // double-wrapped (sendCommand type:"tool.result" would add an extra header).
            let combined = batch.map((c, i) =>
              `[tool_result id="${c.id}" ok="${results[i]!.ok}"]\n${results[i]!.output}`
            ).join("\n\n");
            // Circuit breaker: append forced-handup directive when consecutive failures hit threshold
            if (wConsecToolFails >= MAX_CONSEC_FAIL_TOOLS) {
              wConsecToolFails = 0;
              combined +=
                `\n\n[系统-熔断] 最近 ${MAX_CONSEC_FAIL_TOOLS} 次工具调用全部失败，触发降级熔断。` +
                `禁止继续换工具试错。立即 unit.handup 给 ${e.parent}，说明：` +
                `① 你在尝试什么操作 ② 用了哪些工具 ③ 每次的具体错误信息。`;
            }
            if (batch.some((c) => c.name === "RunTests") && wLastTestFailed === 0) {
              combined +=
                `\n\n[系统-测试通过收束] ${wLastRunTestsSummary}。` +
                `禁止再次调用 RunTests 或 Bash 测试命令。立即 message.to=${e.parent} 汇报改动和测试结果，` +
                `然后 agent.done(success:true)。`;
            }
            a.sendCommand({ type: "user.message", text: combined });
          });
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
            if (getState().agents.get(e.child)?.state === "done" || killedAgents.has(e.child)) return;
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
            if (getState().agents.get(e.child)?.state === "done" || killedAgents.has(e.child)) return;
            a.sendCommand({ type: "user.message", text: "【系统】你有未完成的 todo。立刻执行下一步：输出 step + tool.call，不要只规划。" });
          });
        } else if (hasPending) {
          // 3 nudges failed — terminate the worker as failed so it cannot remain
          // idle forever and keep the parent/Feishu queue blocked.
          workerGaveUp = true;
          fireHardCircuit("nudge-exhausted");
        } else if (workerContinuations < 2) {
          // Worker processed a message but produced no output, and has no pending todos.
          workerContinuations++;
          workerNudgePending = true;
          setImmediate(() => {
            if (getState().agents.get(e.child)?.state === "done" || killedAgents.has(e.child)) return;
            a.sendCommand({
              type: "user.message",
              text: "【系统-回复缺失】你处理了消息但没有任何输出。请立刻 message→parent 报告当前状态，或继续执行任务。",
            });
          });
        } else {
          workerGaveUp = true;
          fireHardCircuit("silent-no-output");
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
  let initMsg = opts.firstMessage ?? e.goal;
  if (!opts.firstMessage && dispatchCtx) {
    const parts: string[] = [`任务目标：${e.goal}`];
    if (dispatchCtx.background) parts.push(`背景：${dispatchCtx.background}`);
    if (dispatchCtx.constraints?.length) parts.push(`约束：${dispatchCtx.constraints.join("；")}`);
    if (dispatchCtx.acceptance_criteria?.length) parts.push(`验收标准：${dispatchCtx.acceptance_criteria.join("；")}`);
    initMsg = parts.join("\n");
  }
  // Always inject parent ID so TL/Worker knows exactly which agent to report to.
  initMsg += `\n汇报对象（你的 parent agent ID）：${e.parent}`;
  // Inject parent TL's confirmed facts (Codex fork-spawn pattern):
  // Worker gets cross-task context without needing to re-read parent history.
  const parentSec = secretaries.get(e.parent);
  if (parentSec) {
    const parentFacts = topFactsByWeight(parentSec.getMemory(), 5);
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

function parseScheduleDelay(raw: string, now = Date.now()): number | null {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (m[2] ?? "ms").toLowerCase();
  const mult = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  return now + Math.round(n * mult);
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
  const selectedPending = pending.filter((pa) => pa.agent === sel);
  const [paletteName, setPaletteName] = useState<PaletteName>(loadConfig().palette);
  const palette = PALETTES[paletteName];
  const layout = useStore((s) => s.layout);
  const scrollOffset     = useStore((s) => s.scrollOffset);
  const agentPaneScroll  = useStore((s) => s.agentPaneScroll);
  const effort           = useStore((s) => s.effort);
  const [effortSelecting, setEffortSelecting] = useState(false);
  const [modelSelecting, setModelSelecting] = useState(false);
  // Zen mode: hide left (AGENTS) and right (TODO) panes, keep only the centre ConvPane
  // so the conversation text can be selected/copied without sidebar columns interleaving.
  const [zenMode, setZenMode] = useState(false);
  // Status mode: show ONLY the left AGENTS pane (hide centre ConvPane + right TODO),
  // a focused view of agent statuses.
  const [statusMode, setStatusMode] = useState(false);
  const [exitSecsLeft, setExitSecsLeft] = useState(0);
  const exitConfirm                     = exitSecsLeft > 0;
  const exitConfirmTimer                = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastExitRequestAt               = useRef(0);
  const lastInputFocusLog               = useRef("");
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

  const emitCommandMessage = (text: string) => {
    applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text } as TuiEvent);
  };

  const selectedConfigRole = (): AgentConfigRole => {
    const selected = getState().agents.get(getState().selectedAgent);
    if (selected?.role === "Worker") return "worker";
    if (selected?.role === "Secretary") return "secretary";
    return "leader";
  };

  const showModelConfig = () => {
    const cfg = loadConfig();
    const roleLines = (["leader", "worker", "secretary"] as AgentConfigRole[]).map((role) => {
      const roleCfg = cfg.agents[role];
      const providerCfg = getAgentProviderConfig(cfg, role);
      const base = providerCfg.baseUrl ? ` ${providerCfg.baseUrl}` : "";
      return `${role}: ${roleCfg.model} -> ${providerCfg.provider} / ${providerCfg.model}${base}`;
    });
    const modelLines = Object.entries(cfg.models).map(([name, modelCfg]) => {
      const base = modelCfg.baseUrl ? ` ${modelCfg.baseUrl}` : "";
      return `${name}: ${modelCfg.provider} / ${modelCfg.model}${base}`;
    });
    emitCommandMessage(
      `当前角色模型:\n${roleLines.join("\n")}\n\n已注册模型:\n${modelLines.join("\n")}` +
      `\n\n用法:\n/connect <name> <preset|baseUrl> [modelId] <apiKey>\n/model <leader|worker|secretary> <name>`,
    );
  };

  const registerModelCommand = (
    name: string | undefined,
    preset: string | undefined,
    modelOrKey: string | undefined,
    maybeApiKey: string | undefined,
  ) => {
    if (!name || !preset || !modelOrKey) {
      emitCommandMessage("用法: /connect <name> <preset|baseUrl> [modelId] <apiKey>");
      return;
    }
    const cfg = resolveModelConfigInput(preset, modelOrKey, maybeApiKey);
    if (!cfg) {
      emitCommandMessage(`缺少模型名。preset "${preset}" 没有默认模型时，请使用: /connect ${name} ${preset} <modelId> <apiKey>`);
      return;
    }
    saveModelConfig(name, cfg);
    emitCommandMessage(`模型已注册: ${name} -> ${cfg.provider} / ${cfg.model}${cfg.baseUrl ? ` ${cfg.baseUrl}` : ""} ✓`);
  };

  const switchModelCommand = (
    role: string | undefined,
    modelName: string | undefined,
  ) => {
    if (!role || !modelName) {
      emitCommandMessage("用法: /model <leader|worker|secretary> <name>");
      return;
    }
    if (!isAgentConfigRole(role)) {
      emitCommandMessage(`未知 agent 角色 "${role}"，可用: leader, worker, secretary`);
      return;
    }
    const cfg = loadConfig();
    const modelCfg = cfg.models[modelName];
    if (!modelCfg) {
      emitCommandMessage(`未知模型 "${modelName}"。先用 /connect ${modelName} <preset|baseUrl> [modelId] <apiKey> 注册。`);
      return;
    }
    if (!saveAgentModel(role, modelName)) {
      emitCommandMessage(`模型切换失败: ${role} -> ${modelName}`);
      return;
    }
    if (role === "leader") updateAgentInfo("pm", { model: modelCfg.model });
    emitCommandMessage(`${role} 模型已切换: ${modelName} -> ${modelCfg.model} ✓`);
  };

  const confirmModelChoice = (role: AgentConfigRole, model: string) => {
    const cfg = loadConfig();
    const modelCfg = cfg.models[model];
    if (!modelCfg || !saveAgentModel(role, model)) {
      emitCommandMessage(`未知模型 "${model}"。先用 /connect 注册。`);
      setModelSelecting(false);
      return;
    }
    if (role === "leader") updateAgentInfo("pm", { model: modelCfg.model });
    setModelSelecting(false);
    emitCommandMessage(`${role} 模型已切换: ${model} -> ${modelCfg.model} ✓`);
  };

  const showWebConfig = () => {
    const cfg = loadConfig();
    const providerLines = Object.entries(cfg.web.providers).map(([name, provider]) => {
      const active = name === cfg.web.search.provider ? "*" : " ";
      const details = provider.type === "serper"
        ? `${provider.type}${provider.hl ? ` hl=${provider.hl}` : ""}${provider.gl ? ` gl=${provider.gl}` : ""}`
        : provider.type;
      return `${active} ${name}: ${details} key=${provider.apiKey ? "***" : "(missing)"}`;
    });
    emitCommandMessage(
      `WebSearch: ${cfg.web.search.enabled ? "enabled" : "disabled"} provider=${cfg.web.search.provider}` +
      ` max=${cfg.web.search.maxResults ?? 5} timeout=${cfg.web.search.timeoutSeconds ?? 10}s\n` +
      `${providerLines.length ? providerLines.join("\n") : "(no configured web providers)"}\n\n` +
      `用法:\n/web connect <name> <serper|brave> <apiKey> [hl] [gl]\n/web provider <name>\n/web show`,
    );
  };

  const connectWebProviderCommand = (args: string[]) => {
    const [name, typeRaw, apiKey, hl, gl] = args;
    if (!name || !typeRaw || !apiKey) {
      emitCommandMessage("用法: /web connect <name> <serper|brave> <apiKey> [hl] [gl]");
      return;
    }
    const type = typeRaw as WebSearchProviderType;
    if (type !== "serper" && type !== "brave") {
      emitCommandMessage(`未知 WebSearch 供应商 "${typeRaw}"，可用: serper, brave`);
      return;
    }
    saveWebSearchProvider(name, {
      type,
      apiKey,
      ...(type === "serper" && hl ? { hl } : {}),
      ...(type === "serper" && gl ? { gl } : {}),
    });
    emitCommandMessage(`WebSearch 供应商已保存并启用: ${name} (${type}) ✓`);
  };

  const switchWebProviderCommand = (name: string | undefined) => {
    if (!name) {
      emitCommandMessage("用法: /web provider <name>");
      return;
    }
    if (!saveWebSearchSelection(name)) {
      emitCommandMessage(`未知 WebSearch 供应商 "${name}"。先用 /web connect ${name} <serper|brave> <apiKey> 注册。`);
      return;
    }
    emitCommandMessage(`WebSearch 默认供应商已切换: ${name} ✓`);
  };

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
          text: "用法：/schedule 10m 检查构建状态" });
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
      replaceAgentForResume(id);
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
    { name: "layout",  desc: "切换布局 v1 | v3",             handler: (args) => { const l = args[0]; if (l === "v1" || l === "v3") { setLayout(l); saveLayout(l); } } },
    { name: "zen",     desc: "切换 Zen 模式（隐藏左右面板，只留中间文本方便复制）", handler: () => { setZenMode((v) => !v); } },
    { name: "status",  desc: "切换 Status 模式（只显示左侧 agents 状态面板）", handler: () => { setStatusMode((v) => !v); } },
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

  useEffect(() => {
    const timer = setInterval(() => {
      const due = scheduledTasks.due(Date.now());
      for (const ev of due) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: `⏰ 计划任务触发 ${ev.task.id}: ${ev.task.text}` });
        dispatchUser(`@pm [计划任务 ${ev.task.id}] ${ev.task.text}`);
        scheduledTasks.complete(ev.task.id);
      }
    }, 1000);
    timer.unref();
    return () => clearInterval(timer);
  }, []);

  // 启动: 注册 PM + process-monitor 占位，检查未完成会话
  useEffect(() => {
    const cfg = loadConfig();
    const leaderCfg = getAgentProviderConfig(cfg, "leader");
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "idle", sub: "waiting for first message", model: leaderCfg.model });
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
    const now = Date.now();
    if (now - lastExitRequestAt.current < 120) return;
    lastExitRequestAt.current = now;
    if (exitConfirm) {
      if (exitConfirmTimer.current) clearInterval(exitConfirmTimer.current);
      exit();
      process.exit(0);
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

  useEffect(() => {
    requestExitFromSignal = requestExit;
    return () => {
      if (requestExitFromSignal === requestExit) requestExitFromSignal = null;
    };
  });

  useEffect(() => {
    const focused = selectedPending.length === 0 && !modelSelecting && !effortSelecting;
    const signature = [
      `sel=${sel}`,
      `focused=${focused}`,
      `inputLen=${input.length}`,
      `pendingSel=${selectedPending.length}`,
      `pendingAll=${pending.length}`,
      `model=${modelSelecting}`,
      `effort=${effortSelecting}`,
    ].join(" ");
    if (signature !== lastInputFocusLog.current) {
      lastInputFocusLog.current = signature;
      process.stderr.write(`[input] ${signature}\n`);
    }
  }, [sel, input.length, selectedPending.length, pending.length, modelSelecting, effortSelecting]);

  // 全局快捷键
  useInput((char, key) => {
    if (key.ctrl && char === "c") { requestExit(); return; }
    if (char === "q" && !input) { requestExit(); return; }
    if (key.tab && !input) {
      if (modelSelecting) setModelSelecting(false);
      if (effortSelecting) setEffortSelecting(false);
      const ids = agentList;
      if (!ids.length) return;
      const idx = ids.indexOf(sel);
      const nextIdx = idx >= 0 ? (idx + 1) % ids.length : 0;
      const maxVis = Math.max(3, Math.floor(Math.max(6, (process.stdout.rows ?? 24) - 5) / 3));
      selectAgentVisible(ids[nextIdx]!, maxVis);
      return;
    }
    if (modelSelecting) {
      if (key.escape) setModelSelecting(false);
      return;
    }
    // Only handle ESC here when InputBar is NOT focused (pending approvals).
    // When InputBar is focused (pending.length===0), it handles ESC itself via onESC prop.
    // Handling it in both places caused double "⏹ interrupted by ESC" messages.
    if (key.escape && selectedPending.length > 0) { handleESCInterrupt(); return; }

    // 待审批时 y/n 接管
    if (selectedPending.length > 0) {
      if (char === "y") {
        const m = selectedPending[0]!;
        const toolId = m.tool_id!;
        approve(toolId);
        const agentInst = agents.get(m.agent);
        if (agentInst) {
          executeTool(m.tool_name ?? "", m.tool_args, { agentId: m.agent }).then((r) => {
            applyEvent({ v: 1, type: "tool.result", agent: m.agent, id: toolId, ok: r.ok, output: r.output });
            agentInst.sendCommand({ type: "tool.result", id: toolId, ok: r.ok, output: r.output });
          });
        }
        return;
      }
      if (char === "n") {
        const m = selectedPending[0]!;
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

    // P/F/C/E/M shortcuts — only when not typing and no pending approvals
    if (!input && selectedPending.length === 0) {
      // E — open effort selector (ESC/Enter handled inside EffortBar's own useInput)
      if (char === "E" && !effortSelecting) { setEffortSelecting(true); return; }
      if (key.escape && effortSelecting)    { setEffortSelecting(false); return; }
      if (char === "M" && !effortSelecting) { setModelSelecting(true); return; }
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
      const maxVis = Math.max(3, Math.floor(Math.max(6, (process.stdout.rows ?? 24) - 5) / 3));
      const nextIdx = idx >= 0 ? (idx + 1) % ids.length : 0;
      selectAgentVisible(ids[nextIdx]!, maxVis);
    }
  });

  return (
    <PaletteContext.Provider value={palette}>
      <Box flexDirection="column">
        <Transcript model={MODEL} />
        {modelSelecting
          ? (() => {
              const cfg = loadConfig();
              const modelChoices = Object.keys(cfg.models);
              const modelDescriptions = Object.fromEntries(
                Object.entries(cfg.models).map(([name, modelCfg]) => [
                  name,
                  `${modelCfg.provider} / ${modelCfg.model}${modelCfg.baseUrl ? ` ${modelCfg.baseUrl}` : ""}`,
                ]),
              );
              return <ModelBar
                currentRole={selectedConfigRole()}
                currentModelByRole={{
                  leader: cfg.agents.leader.model,
                  worker: cfg.agents.worker.model,
                  secretary: cfg.agents.secretary.model,
                }}
                modelChoices={modelChoices}
                modelDescriptions={modelDescriptions}
                onConfirm={confirmModelChoice}
                onCancel={() => setModelSelecting(false)}
              />;
            })()
          : effortSelecting
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
                focused={selectedPending.length === 0}
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
                  selectedPending.length > 0
                    ? `[${selectedPending[0]!.agent}] ${selectedPending[0]!.tool_name ?? ""} — y approve · n reject`
                    : pending.length > 0
                    ? `${pending.length} pending approval(s) in other agent(s) — Tab to review`
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

// Tee stderr to a UTF-8 log file so it can be viewed correctly on Windows
// regardless of the terminal's codepage.
const LOG_FILE = path.join(process.cwd(), "tui.log");
(function setupLogFile() {
  const logStream = fs.createWriteStream(LOG_FILE, { encoding: "utf8", flags: "a" });
  const sessionStart = Date.now();
  logStream.write(`\n--- session ${new Date().toISOString()} ---\n`);
  const origWrite = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;
  const mirrorToTerminal = process.env.SPAWN_TTY_LOGS === "1";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any, encodingOrCb?: any, cb?: any): boolean => {
    const text = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    // Prepend +elapsed ms timestamp to each line (skip blank lines and escape sequences)
    const elapsed = `+${((Date.now() - sessionStart) / 1000).toFixed(1)}s`;
    const timestamped = text.replace(/^(?!\x1b)(.)/mg, `${elapsed} $1`);
    logStream.write(timestamped);
    if (mirrorToTerminal) return origWrite(chunk, encodingOrCb, cb);
    const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
    if (callback) queueMicrotask(callback);
    return true;
  };
})();

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

// ── stdin passthrough (keyboard-only TUI) ───────────────────────────────────
// This TUI deliberately does not implement mouse interaction. Keep terminal
// mouse tracking disabled so normal terminal selection/copy remains native.
const DISABLE_MOUSE_TRACKING = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";
process.stdout.write(DISABLE_MOUSE_TRACKING);

const filteredStdin = new Transform({
  transform(chunk, _encoding, callback) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const ctrlC = buf.includes(0x03);
    const cleaned = ctrlC ? Buffer.from(buf.filter((byte) => byte !== 0x03)) : buf;
    if (ctrlC) {
      const request = requestExitFromSignal;
      if (request) request();
      else process.exit(130);
    }
    if (cleaned.length > 0) this.push(cleaned);
    callback();
  },
});
process.stdin.pipe(filteredStdin, { end: false });

Object.defineProperties(filteredStdin, {
  isTTY: { get: () => process.stdin.isTTY },
  setRawMode: { value: (mode: boolean) => { try { process.stdin.setRawMode(mode); } catch { /* non-TTY fallback */ } } },
  ref: { value: () => process.stdin.ref() },
  unref: { value: () => process.stdin.unref() },
});

// Re-disable on exit — covers clean exit, SIGINT (Ctrl+C), and SIGTERM
const TERM_RESET = `${DISABLE_MOUSE_TRACKING}\x1b[?2004l\x1b[?25h`;
function restoreTerminalForExit(): void {
  const rows = process.stdout.rows ?? 24;
  process.stdout.write(`${TERM_RESET}\x1b[${rows};1H\x1b[2K\n`);
}
process.on("exit", restoreTerminalForExit);
process.on("SIGTERM", () => { process.stdout.write(TERM_RESET); process.exit(143); });

let requestExitFromSignal: (() => void) | null = null;
process.on("SIGINT", () => {
  process.stdout.write(TERM_RESET);
  if (requestExitFromSignal) {
    requestExitFromSignal();
    return;
  }
  process.exit(130);
});

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
      const r = _orig(`\x1b[?2026h${s}${getCursorAnchorSequence()}\x1b[?2026l`, ...rest);
      _inside = false;
      return r;
    }
    return _orig(chunk, ...rest);
  };
}

// Route diagnostic stderr to tui.log while the interactive TUI runs. The app
// emits many raw process.stderr.write agent-event logs; written to the terminal
// they corrupt Ink's <Static> line tracking (stranded status bar / blank gaps).
// A file keeps the terminal clean for Ink. (Skipped for non-TTY: tests/CI.)
if (process.stdout.isTTY && !DEMO) {
  try {
    const _logStream = fs.createWriteStream(path.join(process.cwd(), "tui.log"), { flags: "a" });
    process.stderr.write = ((chunk: any, ...rest: any[]) => _logStream.write(chunk, ...rest)) as typeof process.stderr.write;
  } catch { /* fall back to terminal stderr */ }
}

render(<App />, { stdin: filteredStdin as any, exitOnCtrlC: false, patchConsole: false });

