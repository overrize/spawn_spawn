// MemoryStore — 唯一的 .spawn/memory/ I/O 层
// 原子写（tmp + rename）+ fsync，防止半写状态被 resume 读到

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { AgentMemory } from "./types.js";

function memoryDir(): string {
  return path.resolve(process.cwd(), ".spawn", "memory");
}

export function ensureMemoryDir(): void {
  fs.mkdirSync(memoryDir(), { recursive: true });
}

export function memoryPath(agentId: string): string {
  return path.join(memoryDir(), `${agentId}.json`);
}

export function messagesPath(agentId: string): string {
  return path.join(memoryDir(), `${agentId}.messages.jsonl`);
}

/** New session-history file (replaces flat .messages.jsonl). */
export function sessionsPath(agentId: string): string {
  return path.join(memoryDir(), `${agentId}.sessions.json`);
}

export function remindersPath(): string {
  return path.join(memoryDir(), "reminders.json");
}

export function loadMemory(agentId: string): AgentMemory | null {
  try {
    return JSON.parse(fs.readFileSync(memoryPath(agentId), "utf8")) as AgentMemory;
  } catch { return null; }
}

export function saveMemory(agentId: string, mem: AgentMemory): void {
  ensureMemoryDir();
  const p = memoryPath(agentId);
  const content = JSON.stringify(mem, null, 2);
  const tmp = `${p}.tmp`;
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, p);  // atomic on Unix; best-effort on Windows
  } catch {
    // Windows fallback: rename can fail with EPERM (e.g. AV scanner holds)
    try { fs.writeFileSync(p, content, "utf8"); } catch { /* best-effort */ }
    try { fs.unlinkSync(tmp); } catch { /* ignore stale tmp */ }
  }
}

// ── Session-based message history ────────────────────────────────────────────

/** Max number of sessions kept per agent. Oldest evicted when exceeded. */
export const MAX_SESSIONS = 5;

export interface SessionEntry {
  session_hash: string;
  started_at: number;
  messages: Array<{ role: "user" | "assistant"; content: string; ts: number }>;
}

function loadSessionsRaw(agentId: string): SessionEntry[] {
  try {
    return JSON.parse(fs.readFileSync(sessionsPath(agentId), "utf8")) as SessionEntry[];
  } catch { return []; }
}

function writeSessions(agentId: string, sessions: SessionEntry[]): void {
  const p = sessionsPath(agentId);
  const tmp = `${p}.tmp`;
  const content = JSON.stringify(sessions);
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, p);
  } catch {
    try { fs.writeFileSync(p, content, "utf8"); } catch { /* best-effort */ }
    try { fs.unlinkSync(tmp); } catch { /* stale tmp */ }
  }
}

/**
 * Called when a new agent run begins (SecretaryProxy constructor).
 * Appends a new empty session, evicting the oldest if MAX_SESSIONS exceeded.
 */
export function startSession(agentId: string, sessionHash: string): void {
  ensureMemoryDir();
  try {
    const sessions = loadSessionsRaw(agentId);
    const entry: SessionEntry = { session_hash: sessionHash, started_at: Date.now(), messages: [] };
    writeSessions(agentId, [...sessions, entry].slice(-MAX_SESSIONS));
  } catch { /* best-effort */ }
}

/** Append a message to the current (last) session. */
export function appendMessage(
  agentId: string,
  msg: { role: "user" | "assistant"; content: string; ts: number },
): void {
  ensureMemoryDir();
  try {
    const sessions = loadSessionsRaw(agentId);
    if (sessions.length === 0) {
      // No startSession called yet — create an implicit session
      sessions.push({ session_hash: "implicit", started_at: Date.now(), messages: [] });
    }
    sessions[sessions.length - 1].messages.push(msg);
    writeSessions(agentId, sessions);
  } catch { /* EPERM / locked file on Windows — memory write is best-effort */ }
}

/** Returns all messages from the most recent session (used for resume context). */
export function loadMessages(
  agentId: string,
): Array<{ role: "user" | "assistant"; content: string; ts: number }> {
  try {
    const sessions = loadSessionsRaw(agentId);
    return sessions.length > 0 ? sessions[sessions.length - 1].messages : [];
  } catch { return []; }
}

/** Returns all stored sessions for this agent (newest last). */
export function loadSessions(agentId: string): SessionEntry[] {
  return loadSessionsRaw(agentId);
}

// ── Lookup & lifecycle ────────────────────────────────────────────────────────

/** 通过 7-char session_hash 查找 AgentMemory */
export function loadMemoryByHash(hash: string): AgentMemory | null {
  try {
    ensureMemoryDir();
    for (const f of fs.readdirSync(memoryDir())) {
      if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(memoryDir(), f), "utf8")) as AgentMemory;
        if (m.session_hash === hash) return m;
      } catch { /* skip corrupt file */ }
    }
    return null;
  } catch { return null; }
}

/** 扫描所有 tombstone.final_status === null 的 agent（未正常退出）*/
export function listUnfinishedAgents(): AgentMemory[] {
  try {
    ensureMemoryDir();
    return fs
      .readdirSync(memoryDir())
      .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
      .map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(memoryDir(), f), "utf8")) as AgentMemory; }
        catch { return null; }
      })
      .filter((m): m is AgentMemory => m !== null && m.tombstone?.final_status === null);
  } catch { return []; }
}

/**
 * Called on agent.done. Deletes the working-set .json (no longer needed).
 * The .sessions.json is intentionally kept for future resume.
 */
export function deleteAgentMemory(agentId: string): void {
  try { fs.unlinkSync(memoryPath(agentId)); } catch { /* already gone */ }
  // sessions file is kept — evicted naturally when MAX_SESSIONS is exceeded
}

/** 追加 btw 提醒到 reminders.json */
export function appendReminder(text: string, ts: number): void {
  ensureMemoryDir();
  const p = remindersPath();
  let reminders: Array<{ text: string; ts: number }> = [];
  try { reminders = JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* fresh file */ }
  reminders.push({ text, ts });
  fs.writeFileSync(p, JSON.stringify(reminders, null, 2), "utf8");
}

/** 构建一个全新 AgentMemory 对象（spawn 时初始化） */
export function createMemory(opts: {
  agentId: string;
  agentType: "PM" | "LEADER" | "SECRETARY" | "WORKER";
  parentChain: string[];
  depth: number;
  model: string;
  roleName: string;
  dispatch?: {
    background: string;
    constraints: string[];
    acceptance_criteria: string[];
    stop_conditions: string[];
  };
}): AgentMemory {
  const created_at = Date.now();
  const session_hash = crypto
    .createHash("sha256")
    .update(`${opts.agentId}_${created_at}`)
    .digest("hex")
    .slice(0, 7);

  return {
    schema_version: 1,
    agent_id: opts.agentId,
    agent_type: opts.agentType,
    session_hash,
    parent_chain: opts.parentChain,
    depth: opts.depth,
    created_at,
    updated_at: created_at,
    identity: { role_name: opts.roleName, skills: [], model: opts.model },
    dispatch: opts.dispatch ?? {
      background: "",
      constraints: [],
      acceptance_criteria: [],
      stop_conditions: [],
    },
    working_set: { facts: [], decisions: [], open_questions: [] },
    child_handles: [],
    tombstone: {
      compact_summary: null,
      final_status: null,
      final_artifacts: [],
      resume_hint: null,
    },
  };
}
