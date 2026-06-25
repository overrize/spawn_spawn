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

import { globalBus } from "../bus/Bus.js";
import { loadMemory, topFactsByWeight } from "../memory/MemoryStore.js";
import type { AgentMemory } from "../memory/types.js";

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

export type MissKind = "gap" | "recent-user-msg" | "todo-missing";

export interface ShadowMiss {
  kind: MissKind;
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

export function buildLogContextFromMemory(agentId: string, memory: AgentMemory): LogContext {
  // Cursor: honour tombstone only when epoch matches (same process lifetime).
  let logCursor = 0;
  if (
    memory.tombstone.log_cursor !== undefined &&
    memory.tombstone.log_cursor_epoch === globalBus.getEpoch()
  ) {
    logCursor = memory.tombstone.log_cursor;
  }

  const { entries, headOffset, hasGap } = globalBus.getLog(logCursor, agentId);

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

  return {
    messages: content.trim()
      ? [{ role: "user" as const, content: gapPrefix + content }]
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
      detail: `ring overflow — events before offset ${newCtx.stats.fromOffset} are lost`,
    });
  }

  const newContent = newCtx.messages.map((m) => m.content).join("\n");

  // 2. Recent user-role messages (last 5)
  const recentUser = oldMessages.filter((m) => m.role === "user").slice(-5);
  for (const msg of recentUser) {
    // Strip tool_result protocol headers to get human-readable content
    const clean = msg.content
      .replace(/\[tool_result[^\]]*\]\n?[^\n]*/gm, "")
      .replace(/\[system-[^\]]*\][^\n]*/gm, "")
      .trim();
    if (clean.length < 30) continue; // too short / protocol-only

    const probe = clean.slice(0, 60);
    if (!newContent.includes(probe.slice(0, 30))) {
      misses.push({
        kind: "recent-user-msg",
        detail: `"${probe.slice(0, 60).replace(/\n/g, "\\n")}"`,
      });
    }
  }

  // 3. Todo: if oldMessages contain a recent todo.set pattern but newCtx lacks active todos
  const hasTodoInOld = oldMessages
    .slice(-10)
    .some((m) => m.content.includes("[run]") || m.content.includes("[todo]"));
  const hasTodoInNew = newContent.includes("【当前 todo】");
  if (hasTodoInOld && !hasTodoInNew) {
    misses.push({
      kind: "todo-missing",
      detail: "oldMessages has active todo items but newCtx has no todo block (tombstone.last_todo may be stale)",
    });
  }

  return misses;
}

// ── Formatted stderr log line ─────────────────────────────────────────────────

/** Emit shadow diff results to stderr. Called by httpAgent when USE_LOG_CONTEXT is set. */
export function logShadowDiff(
  agentId: string,
  turnIdx: number,
  newCtx: LogContext,
  misses: ShadowMiss[],
): void {
  const prefix = `[shadow-ctx] agent=${agentId} turn=${turnIdx}`;
  const statStr = `facts=${newCtx.stats.factCount} decisions=${newCtx.stats.decisionCount} delta=${newCtx.stats.deltaEventCount}`;
  if (misses.length === 0) {
    process.stderr.write(`${prefix} ✓ no gaps (${statStr})\n`);
  } else {
    process.stderr.write(`${prefix} ⚠ ${misses.length} miss(es) (${statStr}):\n`);
    for (const m of misses) {
      process.stderr.write(`  [${m.kind}] ${m.detail}\n`);
    }
  }
}
