/**
 * LogContextBuilder — builds LLM context from Secretary working_set + bus log delta.
 *
 * USE_LOG_CONTEXT shadow mode:
 *   Both old (this.messages) and new (log projection) context are built each turn.
 *   shadowDiff() reports what's in old but missing in new — logged to stderr.
 *   In shadow mode the old context is still sent to the LLM; no behaviour change.
 *   Once misses consistently reach zero, SHADOW_MODE=false lets new context take over.
 *
 * What the bus log currently captures (and does NOT capture):
 *   ✅ message events (agent output), tool.call, spawn, agent.done, unit.handup
 *   ❌ user.message commands (task injections, nudges, tool result payloads)
 *   → shadow diff will surface these as "recent-user-msg" misses,
 *     guiding which inbound events need to be published to the bus next.
 */

import fs from "node:fs";
import path from "node:path";
import { globalBus, SpawnBus } from "../bus/Bus.js";
import { loadMemory, topFactsByWeight } from "../memory/MemoryStore.js";
import type { AgentMemory } from "../memory/types.js";

// Shadow log file — plain text, one line per entry, survives PowerShell stderr weirdness.
// Set SHADOW_LOG_FILE env var to override path. Default: shadow.log in cwd.
const SHADOW_LOG_PATH = process.env.SHADOW_LOG_FILE ?? path.join(process.cwd(), "shadow.log");

function shadowWrite(line: string): void {
  try {
    fs.appendFileSync(SHADOW_LOG_PATH, line + "\n", "utf8");
  } catch { /* non-fatal */ }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface LogContext {
  /** Drop-in replacement for this.messages — single user turn containing the projection. */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  hasGap: boolean;
  stats: {
    factCount: number;
    decisionCount: number;
    deltaEventCount: number;
    fromOffset: number;
    headOffset: number;
  };
}

export type MissKind = "gap" | "recent-user-msg" | "todo-missing" | "decision-missing";

/**
 * Cause codes — each maps to the source path that should be publishing to the bus.
 *
 * recent-user-msg causes:
 *   slash-command     → handled in index.tsx command dispatcher, never enters bus
 *   nudge             → sendCommand() path, bypasses httpAgent.emit
 *   task-injection    → PM/TL receiving a structured task via sendCommand()
 *   tool-result-text  → applyEvent() appends tool results to this.messages directly
 *
 * todo-missing causes:
 *   tombstone-null    → Secretary has never seen a todo.set for this agent
 *   tombstone-stale   → todo.set fired but Secretary hasn't flushed since
 *
 * decision-missing causes:
 *   keyword-miss      → assistant turn contained decision keyword but Secretary didn't capture it
 *                       (happens when the turn is protocol-only JSON with no prose)
 *
 * gap causes:
 *   ring-overflow     → BUS_LOG_SIZE too small for the task length; increase env var
 */
export type MissCause =
  | "slash-command"
  | "nudge"
  | "task-injection"
  | "tool-result-text"
  | "tombstone-null"
  | "tombstone-stale"
  | "keyword-miss"
  | "ring-overflow"
  | "unknown";

export interface ShadowMiss {
  kind: MissKind;
  cause: MissCause;
  detail: string;
}

// ── Build ─────────────────────────────────────────────────────────────────────

/**
 * Build a log-derived context block for the given agent.
 * Returns null if no memory snapshot exists (fresh agent with no Secretary flush yet).
 */
export function buildLogContext(agentId: string): LogContext | null {
  const memory = loadMemory(agentId);
  if (!memory) return null;
  return buildLogContextFromMemory(agentId, memory);
}

export function buildLogContextFromMemory(agentId: string, memory: AgentMemory, bus: SpawnBus = globalBus): LogContext {
  // Cursor: honour tombstone only when epoch matches (same process lifetime).
  // On epoch mismatch (cross-restart or fresh agent), default to headOffset so we
  // don't replay stale history from a dead process's ring segment.
  let logCursor = bus.getHeadOffset();
  if (
    memory.tombstone.log_cursor !== undefined &&
    memory.tombstone.log_cursor_epoch === bus.getEpoch()
  ) {
    logCursor = memory.tombstone.log_cursor;
  }

  const { entries, headOffset, hasGap } = bus.getLog(logCursor, agentId);

  // ── Working set summary ───────────────────────────────────────────────────
  const facts = topFactsByWeight(memory, 15);
  const decisions = memory.working_set.decisions.slice(-5);

  const parts: string[] = [];

  if (facts.length > 0) {
    const lines = ["【已确认事实 (Secretary working_set)】"];
    for (const f of facts) lines.push(`  [w=${f.weight ?? 1}] ${f.text}`);
    parts.push(lines.join("\n"));
  }

  if (decisions.length > 0) {
    const lines = ["【已记录决策】"];
    for (const d of decisions) lines.push(`  · ${d.text.slice(0, 150)}`);
    parts.push(lines.join("\n"));
  }

  // Current todo from tombstone (updated by every todo.set event via Secretary)
  if (memory.tombstone.last_todo) {
    try {
      const items = JSON.parse(memory.tombstone.last_todo) as Array<{ state: string; text: string }>;
      const active = items.filter((i) => i.state === "run" || i.state === "todo");
      if (active.length > 0) {
        const lines = ["【当前 todo】"];
        for (const i of active) lines.push(`  [${i.state}] ${i.text}`);
        parts.push(lines.join("\n"));
      }
    } catch { /* malformed last_todo — skip */ }
  }

  // ── Bus log delta ─────────────────────────────────────────────────────────
  if (entries.length > 0) {
    const shown = entries.slice(-50); // cap to last 50 events in delta block
    const lines = [`【事件增量 (offset ${logCursor}→${headOffset}, ${entries.length} 条, 显示最近 ${shown.length} 条)】`];
    for (const entry of shown) {
      const e = entry.event;
      const rel = entry.offset - logCursor;
      switch (e.type) {
        case "message":
          lines.push(`  [+${rel}] ${e.agent}→${e.to}: ${e.text.slice(0, 150)}`);
          break;
        case "tool.result":
          lines.push(`  [+${rel}] tool.result[${e.id.slice(-6)}] ok=${e.ok}: ${e.output.slice(0, 80)}`);
          break;
        case "tool.call":
          lines.push(`  [+${rel}] tool.call ${e.name}(${JSON.stringify(e.args).slice(0, 60)})`);
          break;
        case "spawn":
          lines.push(`  [+${rel}] spawn ${e.child} goal="${(e.goal ?? "").slice(0, 60)}"`);
          break;
        case "unit.handup":
          lines.push(`  [+${rel}] handup from ${e.agent}: ${e.summary.slice(0, 100)}`);
          break;
        case "agent.done":
          lines.push(`  [+${rel}] agent.done ${e.agent} success=${e.success}`);
          break;
        // skip agent.state / token.usage — noise without signal for context
      }
    }
    parts.push(lines.join("\n"));
  }

  const content = parts.join("\n\n");
  const gapPrefix = hasGap
    ? `[GAP WARNING] 环形缓冲区已溢出 — offset ${logCursor} 之前的事件已丢失，以下为可用片段。\n\n`
    : "";

  // Always include gap warning even when working_set + delta are empty —
  // the gap itself is critical signal for the shadow diff.
  const fullContent = (gapPrefix + content).trim();
  return {
    messages: fullContent
      ? [{ role: "user" as const, content: fullContent }]
      : [],
    hasGap,
    stats: {
      factCount: facts.length,
      decisionCount: decisions.length,
      deltaEventCount: entries.length,
      fromOffset: logCursor,
      headOffset,
    },
  };
}

// ── Shadow diff ───────────────────────────────────────────────────────────────

/**
 * Compare old context (this.messages) against new log-derived context.
 * Returns a list of items present in old but not represented in new.
 *
 * Focus areas per spec: decision / 最近 user 指令 / 当前 todo.
 */
export function shadowDiff(
  oldMessages: Array<{ role: "user" | "assistant"; content: string }>,
  newCtx: LogContext,
): ShadowMiss[] {
  const misses: ShadowMiss[] = [];

  // 1. Gap is the loudest signal
  if (newCtx.hasGap) {
    misses.push({
      kind: "gap",
      cause: "ring-overflow",
      detail: `ring overflow — events before offset ${newCtx.stats.fromOffset} are lost; increase BUS_LOG_SIZE (current default 2000)`,
    });
  }

  const newContent = newCtx.messages.map((m) => m.content).join("\n");

  // 2. Recent user-role messages (last 5) — classify by source path
  const recentUser = oldMessages.filter((m) => m.role === "user").slice(-5);
  for (const msg of recentUser) {
    // Strip tool_result and system protocol headers
    const raw = msg.content;
    const hasToolResult = /\[tool_result/i.test(raw);
    const clean = raw
      .replace(/\[tool_result[^\]]*\]\n?[^\n]*/gm, "")
      .replace(/\[system-[^\]]*\][^\n]*/gm, "")
      .trim();

    if (hasToolResult && clean.length < 20) continue; // pure protocol payload with no real text

    // Filter truly empty / meaningless messages (< 5 chars after strip).
    // Do NOT apply a high threshold — CJK nudges like "继续" are 2 chars but meaningful.
    if (clean.length < 5) continue;

    const probe = clean.slice(0, 60);
    if (newContent.includes(probe.slice(0, 30))) continue; // already covered

    // Classify the cause by content signature
    const cause = classifyUserMsgCause(clean, hasToolResult);
    misses.push({
      kind: "recent-user-msg",
      cause,
      detail: `[cause=${cause}] "${probe.replace(/\n/g, "\\n")}"`,
    });
  }

  // 3. Todo: if oldMessages contain active todo markers but newCtx lacks a todo block
  const hasTodoInOld = oldMessages
    .slice(-10)
    .some((m) => m.content.includes("[run]") || m.content.includes("[todo]"));
  const hasTodoInNew = newContent.includes("【当前 todo】");
  if (hasTodoInOld && !hasTodoInNew) {
    // Distinguish: Secretary never saw a todo.set vs. saw one but tombstone not flushed yet
    const cause: MissCause = newCtx.stats.factCount === 0 ? "tombstone-null" : "tombstone-stale";
    misses.push({
      kind: "todo-missing",
      cause,
      detail: `active todo in oldMessages missing from newCtx (${cause})`,
    });
  }

  // 4. Decision keywords in recent assistant turns not reflected in working_set
  const recentAssistant = oldMessages.filter((m) => m.role === "assistant").slice(-3);
  for (const msg of recentAssistant) {
    const prose = msg.content.split("\n").filter((l) => !l.trim().startsWith("{")).join(" ").trim();
    if (prose.length < 20) continue;
    if (!DECISION_PATTERN.test(prose)) continue;
    const snippet = prose.slice(0, 80);
    if (!newContent.includes(snippet.slice(0, 30))) {
      misses.push({
        kind: "decision-missing",
        cause: "keyword-miss",
        detail: `[cause=keyword-miss] "${snippet.replace(/\n/g, "\\n")}"`,
      });
    }
  }

  return misses;
}

// Matches decision keywords from SecretaryProxy (kept in sync manually — both must match)
const DECISION_PATTERN = /应该|决定|选择|采用|方案|确认|将要|采取|should|decided|chosen|use|using|will\s/i;

/**
 * Infer which source path produced a user-role message that's missing from the bus.
 * Each cause maps to a specific code path that would need to publish to the bus.
 */
function classifyUserMsgCause(clean: string, hasToolResult: boolean): MissCause {
  if (hasToolResult) return "tool-result-text";
  if (clean.startsWith("/")) return "slash-command";
  // Structured task injection: multi-line, has section markers or JSON-ish structure
  if (clean.includes("\n") && (clean.includes("goal:") || clean.includes("## ") || clean.includes("任务"))) {
    return "task-injection";
  }
  // Short imperative — most likely a user nudge sent via sendCommand()
  if (clean.length < 150 && !clean.includes("\n")) return "nudge";
  return "unknown";
}

// ── Formatted stderr log line ─────────────────────────────────────────────────

/**
 * Write shadow diff results to SHADOW_LOG_PATH (plain text, avoids PowerShell stderr encoding issues).
 * Pass a custom `writer` in tests to capture output without touching the filesystem.
 */
export function logShadowDiff(
  agentId: string,
  turnIdx: number,
  newCtx: LogContext,
  misses: ShadowMiss[],
  writer: (line: string) => void = shadowWrite,
): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const prefix = `${ts} [shadow-ctx] agent=${agentId} turn=${turnIdx}`;
  const statStr = `facts=${newCtx.stats.factCount} decisions=${newCtx.stats.decisionCount} delta=${newCtx.stats.deltaEventCount}`;
  if (misses.length === 0) {
    writer(`${prefix} OK no-miss (${statStr})`);
  } else {
    const causeTally = misses.reduce<Record<string, number>>((acc, m) => {
      acc[m.cause] = (acc[m.cause] ?? 0) + 1;
      return acc;
    }, {});
    const tallyStr = Object.entries(causeTally).map(([c, n]) => `${c}x${n}`).join(" ");
    writer(`${prefix} MISS ${misses.length} (${statStr}) causes=[${tallyStr}]`);
    for (const m of misses) {
      writer(`  [${m.kind}/${m.cause}] ${m.detail}`);
    }
  }
}

/** Called once at app startup when USE_LOG_CONTEXT is set. */
export function logShadowStart(shadowMode: boolean): void {
  const ts = new Date().toISOString().slice(11, 23);
  shadowWrite(`${ts} [shadow-ctx] ENABLED SHADOW_MODE=${shadowMode} log=${SHADOW_LOG_PATH}`);
}
