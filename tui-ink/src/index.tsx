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

import React, { useEffect, useRef, useState } from "react";
import { render, useApp, useInput, useStdin, Box, Text } from "ink";
import { PassThrough } from "node:stream";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { HttpConvAgent } from "./adapters/httpAgent.js";
import {
  TitleBar, AgentsPane, SessionsPane, ConvPane, TodoPane, StatusBar, InputBar,
  DagView, VDivider, PaletteContext, PALETTES,
} from "./ui.js";
import {
  applyEvent, ensureAgent, getState, selectAgent, useStore, userMessage,
  approve, reject, setLayout, scrollBy, setMinLevel, resumeAgent, updateAgentInfo,
} from "./store.js";
import type { TuiEvent, LogLevel } from "./protocol.js";
import { loadConfig, savePalette, saveLayout, saveAgentConfig, PROVIDER_PRESETS } from "./config.js";
import type { PaletteName, ProviderConfig } from "./config.js";
import { SecretaryProxy } from "./memory/SecretaryProxy.js";
import { createMemory, loadMemory, loadMemoryByHash, listUnfinishedAgents, memoryPath, messagesPath } from "./memory/MemoryStore.js";
import { ProcessManager } from "./pm/ProcessManager.js";
import { executeTool, toolNeedsApproval, buildToolSchemaBlock } from "./tools/registry.js";
import type { AgentRole } from "./tools/registry.js";

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
    if (mem) {
      const facts = mem.working_set.facts.slice(-10).map((f) => `- ${f.text}`).join("\n");
      const decisions = mem.working_set.decisions.map((d) => `- ${d.text}`).join("\n");
      const lastTodo = mem.tombstone.last_todo
        ? JSON.parse(mem.tombstone.last_todo).map((t: {state: string; text: string}) => `  [${t.state}] ${t.text}`).join("\n")
        : "(unknown)";
      tpl += `\n\n---\n\n## ⚠️ RESUMED CONTEXT\n\n你正在从中断恢复。上次中断原因：${mem.tombstone.resume_hint ?? "未知"}\n\n**上次 TODO 状态：**\n${lastTodo}\n\n**已确认事实（最近 10 条）：**\n${facts || "(无)"}\n\n**关键决定：**\n${decisions || "(无)"}\n\n**第一句必须输出 todo.set 重申当前计划，然后继续推进。**`;
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
      startWorker(e); // routes Leader role to startLeaderAgent internally
      return;
    }

    if (e.type === "agent.error") {
      applyEvent(e); pm.observe(e); secretary.observe(e);
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
    }

    if (e.type === "tool.call") {
      actedThisTurn = true;
      if (!toolNeedsApproval(e.name, e.args as Record<string, unknown>)) {
        toolQueue.push(e);
      }
      // Leaders' own destructive Bash: root PM has no parent to ask, just execute
    }

    if (e.type === "message") {
      actedThisTurn = true;
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

    // Tech Lead completion — notify parent PM + ingest memory upward
    if (e.type === "agent.done" && opts.parentId) {
      const pmSec = secretaries.get("pm");
      if (pmSec) pmSec.ingestChildMemory(secretary.getMemory() as any);
      const parentAgent = agents.get(opts.parentId);
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
      // Cleanup: delete memory files on normal completion (no resume needed)
      try { fs.unlinkSync(memoryPath(opts.id)); } catch { /* already gone */ }
      try { fs.unlinkSync(messagesPath(opts.id)); } catch { /* already gone */ }
    }

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
      if (toolQueue.length > 0) {
        const batch = toolQueue.splice(0);
        setImmediate(async () => {
          const results = await Promise.all(batch.map((c) => executeTool(c.name, c.args)));
          for (let i = 0; i < batch.length; i++) {
            const { id } = batch[i]!;
            const { ok, output } = results[i]!;
            applyEvent({ v: 1, type: "tool.result", agent: opts.id, id, ok, output });
          }
          const combined = batch.map((c, i) =>
            `[tool_result id="${c.id}" ok="${results[i]!.ok}"]\n${results[i]!.output}`
          ).join("\n\n");
          a.sendCommand({ type: "tool.result", id: batch[0]!.id, ok: true, output: combined });
        });
      } else if (actedThisTurn) {
        const todos = getState().todosByAgent.get(opts.id) ?? [];
        const hasRun = todos.some((t) => t.state === "run");
        const hasTodo = todos.some((t) => t.state === "todo");
        if (hasRun && !hasTodo) {
          const closed = todos.map((t) => ({ ...t, state: t.state === "run" ? "done" : t.state }));
          applyEvent({ v: 1, type: "todo.set", agent: opts.id, items: closed as any });
        }
      } else if (!actedThisTurn && !gaveUp) {
        const todos = getState().todosByAgent.get(opts.id) ?? [];
        const hasPending = todos.some((t) => t.state === "todo" || t.state === "run");
        if (hasPending && continuations < 3) {
          continuations++;
          setImmediate(() => {
            a.sendCommand({ type: "user.message", text: "【系统】你有未完成的 todo。立刻执行下一步：输出 step + tool.call 或 spawn，不要只规划。" });
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
    if (ev.type === "agent.done") {
      const parentAgent = agents.get(e.parent);
      if (parentAgent instanceof HttpConvAgent) {
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
      // Cleanup: delete worker memory files on completion
      try { fs.unlinkSync(memoryPath(e.child)); } catch { /* already gone */ }
      try { fs.unlinkSync(messagesPath(e.child)); } catch { /* already gone */ }
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
      } else if (workerActedThisTurn) {
        // Worker acted (sent message to parent or ran tool) — auto-close stale run todos
        const todos = getState().todosByAgent.get(e.child) ?? [];
        const hasRun  = todos.some((t) => t.state === "run");
        const hasTodo = todos.some((t) => t.state === "todo");
        if (hasRun && !hasTodo) {
          const closed = todos.map((t) => ({ ...t, state: t.state === "run" ? "done" : t.state }));
          applyEvent({ v: 1, type: "todo.set", agent: e.child, items: closed as any });
        }
      } else if (!workerActedThisTurn && !workerGaveUp) {
        // Worker planned but didn't act — nudge to continue
        const todos = getState().todosByAgent.get(e.child) ?? [];
        const hasPending = todos.some((t) => t.state === "todo" || t.state === "run");
        if (hasPending && workerContinuations < 3) {
          workerContinuations++;
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
  a.sendCommand({ type: "user.message", text: initMsg });
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
  const agentList = useStore((s) => Array.from(s.agents.keys()));
  const sel = useStore((s) => s.selectedAgent);
  const pending = useStore((s) => s.pendingApprovals);
  const [paletteName, setPaletteName] = useState<PaletteName>(loadConfig().palette);
  const palette = PALETTES[paletteName];
  const layout = useStore((s) => s.layout);
  const scrollOffset    = useStore((s) => s.scrollOffset);
  const cmdHistory      = useRef<string[]>([]);
  const historyIdx      = useRef(-1);
  const browsingHistory = useRef(false);
  const completeTick    = useRef(0);

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
        const resumeHint = (mem.tombstone.resume_hint ?? "Resume from last checkpoint") + deadNote;
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
    { name: "quit",    desc: "exit the TUI",                handler: () => process.exit(0) },
  ];

  const runCommand = (cmd: string) => {
    const parts = cmd.slice(1).split(/\s+/);
    const head = parts[0]!;
    const c = COMMANDS.find((c) => c.name === head);
    if (c) c.handler(parts.slice(1));
  };

  const slashMatches = input.startsWith("/")
    ? COMMANDS.filter((c) => c.name.startsWith(input.slice(1).split(/\s+/)[0]!))
    : [];

  const pmStarted = useRef(false);

  const dispatchUser = (raw: string) => {
    const text = raw.trim();
    if (!text) return;

    if (text.startsWith("/")) return runCommand(text);

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

    userMessage(target, body);
    const a = agents.get(target);
    if (!a) return;

    // HttpConvAgent has its own internal _queue and drains one message per turn,
    // so we always call sendCommand immediately — no React-level blocking needed.
    a.sendCommand({ type: "user.message", text: body });
  };

  // 启动: 注册 PM + process-monitor 占位，检查未完成会话
  useEffect(() => {
    const cfg = loadConfig();
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "idle", sub: "waiting for first message", model: cfg.agents.leader.model });
    // process-monitor: visual representation of the TypeScript ProcessManager in the agent tree
    ensureAgent({ id: "process-monitor", name: "monitor", role: "Secretary", parent: "pm", state: "run", sub: "supervising", model: "internal" });
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
    const MOUSE_SGR_RE = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
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
        while ((m = MOUSE_SGR_RE.exec(bin)) !== null) {
          hasMouse = true;
          if (m[1] === "64") scrollBy(3);   // wheel up → older
          if (m[1] === "65") scrollBy(-3);  // wheel down → newer
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

  // 全局快捷键
  useInput((char, key) => {
    if (key.ctrl && char === "c") exit();
    if (char === "q" && !input) exit();

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

    // P/F/C shortcuts — only when not typing and no pending approvals
    if (!input && !pending.length) {
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
      // 斜杠命令补全
      if (input.startsWith("/") && slashMatches.length === 1) {
        setInput("/" + slashMatches[0]!.name + " ");
        completeTick.current++;
        return;
      }
      if (input.startsWith("/") && slashMatches.length > 1) {
        const commonPrefix = lcp(slashMatches.map((m) => m.name));
        setInput("/" + commonPrefix);
        completeTick.current++;
        return;
      }
      // agent 切换
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
            <ConvPane scrollOffset={scrollOffset} />
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
                <AgentsPane width={agW} />
                <VDivider />
                <ConvPane scrollOffset={scrollOffset} />
                <VDivider />
                <TodoPane width={toW} />
              </Box>
            );
          })()
        )}
        <InputBar
          key={completeTick.current}
          focused={pending.length === 0}
          value={input}
          onChange={setInput}
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
              : (() => {
                  const selState = getState().agents.get(getState().selectedAgent)?.state;
                  return selState === "run" ? "working… (message queued)" : undefined;
                })()
          }
        />
        {slashMatches.length > 0 && (
          <Box paddingX={2} flexDirection="column">
            {slashMatches.map((c) => (
              <Box key={c.name}>
                <Text color="cyan">{`/${c.name}`.padEnd(12)}</Text>
                <Text dimColor>{c.desc}</Text>
              </Box>
            ))}
          </Box>
        )}
        <StatusBar demo={DEMO} />
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
const banner = DEMO
  ? "running in --demo mode (no real claude subprocess; fake events on first message)"
  : `live mode — will spawn 'claude' on first message (model=${MODEL})`;

console.log(`\nmulti-agent TUI · ${banner}\n`);

// ── stdin passthrough (no mouse interception) ───────────────────────────────
// 关掉所有鼠标追踪，还给终端原生文字选中能力。
// 滚动改用键盘（[ / ]，见 useInput 处理）。
process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l");

const filteredStdin = new PassThrough();
process.stdin.pipe(filteredStdin, { end: false });

Object.defineProperties(filteredStdin, {
  isTTY: { get: () => process.stdin.isTTY },
  setRawMode: { value: (mode: boolean) => process.stdin.setRawMode(mode) },
  ref: { value: () => process.stdin.ref() },
  unref: { value: () => process.stdin.unref() },
});

// Re-disable on exit in case the terminal re-enabled tracking during the session
process.on("exit", () => {
  process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l");
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
      const r = _orig(`\x1b[?2026h${s}\x1b[?2026l`, ...rest);
      _inside = false;
      return r;
    }
    return _orig(chunk, ...rest);
  };
}

render(<App />, { stdin: filteredStdin as any });
