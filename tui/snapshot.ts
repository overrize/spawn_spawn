/**
 * OMO Instance Status Snapshot
 *
 * Outputs a single-frame ANSI-formatted dashboard to stdout.
 * Each SpawnAgent = one OMO instance, ForkAgent = parallel worker within it.
 * Compatible with OpenCode/OMO terminal display — NO full-screen takeover.
 *
 * Run: npx tsx tui/snapshot.ts [spawnId]
 */

import { spawnBridge } from "../omo-bridge/index.js";
import { AgentStatus, AgentType } from "../src/core/types.js";
import type { AgentInfo } from "../omo-bridge/index.js";
import type { MemoryEventPayload } from "../src/core/types.js";

// ─── ANSI Escape Codes ──────────────────────────────────────────────

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bgBlue: "\x1b[44m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
  bgGray: "\x1b[100m",
};

// ─── Box-Drawing Characters (Unicode) ───────────────────────────────

const BOX = {
  tl: "\u250c", // ┌ top-left
  tr: "\u2510", // ┐ top-right
  bl: "\u2514", // └ bottom-left
  br: "\u2518", // ┘ bottom-right
  h: "\u2500",  // ─ horizontal
  v: "\u2502",  // │ vertical
  lt: "\u251c", // ├ left-T
  rt: "\u2524", // ┤ right-T
};

// ─── Event Store (module-level, survives between invocations) ──────

interface EventEntry {
  time: string;
  type: string;
  key: string;
  value: string;
  agentId: string;
}

const eventLog: EventEntry[] = [];
const subscribedSpawns = new Set<string>();
const MAX_EVENTS = 10;

// ─── ANSI-Aware String Utilities ────────────────────────────────────

const ANSI_RE = /\x1b\[\d*(;\d+)*m/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

function visualLen(str: string): number {
  return stripAnsi(str).length;
}

function padVisual(str: string, len: number): string {
  const plainLen = visualLen(str);
  if (plainLen >= len) return str;
  return str + " ".repeat(len - plainLen);
}

// ─── Public Helper Functions ────────────────────────────────────────

function statusColor(status: AgentStatus): string {
  switch (status) {
    case AgentStatus.RUNNING:
      return ANSI.green;
    case AgentStatus.PAUSED:
      return ANSI.yellow;
    case AgentStatus.TERMINATED:
    case AgentStatus.ERROR:
      return ANSI.red;
    case AgentStatus.IDLE:
      return ANSI.gray;
    case AgentStatus.INITIALIZING:
    case AgentStatus.RESUMING:
    case AgentStatus.TERMINATING:
      return ANSI.blue;
    default:
      return ANSI.reset;
  }
}

function statusLabel(status: AgentStatus): string {
  return status;
}

function truncateId(id: string, maxLen = 20): string {
  if (id.length <= maxLen) return id;
  return id.slice(0, maxLen - 1) + "\u2026";
}

function truncateValue(val: unknown, maxLen = 40): string {
  if (val === null || val === undefined) return String(val);
  if (typeof val === "object") {
    try {
      const str = JSON.stringify(val);
      if (str.length <= maxLen) return str;
      return str.slice(0, maxLen - 1) + "\u2026";
    } catch {
      return String(val);
    }
  }
  const str = String(val);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "\u2026";
}

// ─── Box Helpers ────────────────────────────────────────────────────

function boxHeader(text: string, width = 70): string {
  const inner = width - 2; // space between corners
  const dashCount = inner - text.length - 3; // "─ " + text + " " = text.length + 3
  return BOX.tl + BOX.h + " " + text + " " + BOX.h.repeat(Math.max(0, dashCount)) + BOX.tr;
}

function boxFooter(width = 70): string {
  const inner = width - 2;
  return BOX.bl + BOX.h.repeat(inner) + BOX.br;
}

function boxSeparator(width = 70): string {
  const inner = width - 2;
  return BOX.lt + BOX.h.repeat(inner) + BOX.rt;
}

function boxSubHeader(text: string, width = 70): string {
  const inner = width - 2;
  const dashCount = inner - text.length - 3;
  return BOX.lt + BOX.h + " " + text + " " + BOX.h.repeat(Math.max(0, dashCount)) + BOX.rt;
}

function boxLine(content: string, width = 70): string {
  const inner = width - 2;
  const padded = padVisual(content, inner);
  return BOX.v + padded + BOX.v;
}

function boxBlank(width = 70): string {
  return boxLine("", width);
}

// ─── Memory Event Subscription ──────────────────────────────────────

function subscribeToSpawnEvents(spawnId: string): void {
  if (subscribedSpawns.has(spawnId)) return;
  try {
    spawnBridge.subscribeMemory(spawnId, (payload: MemoryEventPayload) => {
      const d = new Date(payload.timestamp);
      const time =
        String(d.getHours()).padStart(2, "0") +
        ":" +
        String(d.getMinutes()).padStart(2, "0") +
        ":" +
        String(d.getSeconds()).padStart(2, "0");

      let typeLabel: string;
      switch (payload.type) {
        case "memory:set":
          typeLabel = "SET";
          break;
        case "memory:delete":
          typeLabel = "DEL";
          break;
        case "memory:clear":
          typeLabel = "CLR";
          break;
        default:
          typeLabel = payload.type;
      }

      eventLog.push({
        time,
        type: typeLabel,
        key: payload.key ?? "",
        value:
          payload.value === null || payload.value === undefined
            ? ""
            : typeof payload.value === "string"
              ? payload.value
              : JSON.stringify(payload.value),
        agentId: payload.agentId,
      });

      while (eventLog.length > MAX_EVENTS) {
        eventLog.shift();
      }
    });
    subscribedSpawns.add(spawnId);
  } catch {
    // Spawn might not be available
  }
}

// ─── Rendering: Stats Line ──────────────────────────────────────────

function renderStats(agents: AgentInfo[], memKeyCount: number, width: number): string[] {
  const total = agents.length + 1; // +1 for MainAgent

  let active = 1; // Main counts as active
  let paused = 0;
  let terminated = 0;
  let error = 0;

  for (const a of agents) {
    switch (a.status) {
      case AgentStatus.RUNNING:
      case AgentStatus.INITIALIZING:
      case AgentStatus.RESUMING:
        active++;
        break;
      case AgentStatus.PAUSED:
        paused++;
        break;
      case AgentStatus.TERMINATED:
        terminated++;
        break;
      case AgentStatus.ERROR:
        error++;
        break;
    }
  }

  const parts: string[] = [];
  parts.push(`  ${ANSI.bold}${total}${ANSI.reset} OMO instances`);
  parts.push(`${ANSI.green}${active} active${ANSI.reset}`);
  parts.push(`${ANSI.yellow}${paused} paused${ANSI.reset}`);
  parts.push(`${ANSI.red}${terminated} terminated${ANSI.reset}`);
  parts.push(`${ANSI.cyan}${memKeyCount} memory keys${ANSI.reset}  `);

  return [boxLine(parts.join(" │ "), width)];
}

// ─── Rendering: Agent Tree ──────────────────────────────────────────

function renderAgentTree(agents: AgentInfo[], width: number): string[] {
  const lines: string[] = [];
  const spawns = agents.filter((a) => a.type === AgentType.SPAWN);
  const forks = agents.filter((a) => a.type === AgentType.FORK);

  // MainAgent — always at root
  const mainColor = statusColor(AgentStatus.RUNNING);
  lines.push(
    boxLine(`  \u25c6 MainAgent  (${mainColor}RUNNING${ANSI.reset})`, width)
  );

  if (spawns.length === 0) {
    lines.push(boxBlank(width));
    lines.push(
      boxLine(
        `  ${ANSI.gray}No OMO instances. Use s:spawn to create one.${ANSI.reset}`,
        width
      )
    );
    return lines;
  }

  // Separator after Main
  lines.push(boxLine(`  ${BOX.v}`, width));

  // Group forks by parent spawn
  const forkMap = new Map<string, AgentInfo[]>();
  for (const f of forks) {
    const pid = f.parentId ?? "";
    if (!forkMap.has(pid)) forkMap.set(pid, []);
    forkMap.get(pid)!.push(f);
  }

  for (let si = 0; si < spawns.length; si++) {
    const spawn = spawns[si];
    const isLastSpawn = si === spawns.length - 1;
    const color = statusColor(spawn.status);
    const label = statusLabel(spawn.status);
    const fCount = spawn.forkCount ?? 0;
    const children = forkMap.get(spawn.id) ?? [];

    // Spawn line
    const prefix = isLastSpawn ? `  \u2514\u2500\u2500 ` : `  \u251c\u2500\u2500 `;
    const spawnLine =
      prefix +
      `SpawnAgent ${color}(${label})${ANSI.reset}  ` +
      `${ANSI.dim}depth=${spawn.depth ?? "?"}  forks=${fCount}${ANSI.reset}`;
    lines.push(boxLine(spawnLine, width));

    // Fork children
    for (let fi = 0; fi < children.length; fi++) {
      const fork = children[fi];
      const isLastFork = fi === children.length - 1;
      const fColor = statusColor(fork.status);
      const fLabel = statusLabel(fork.status);

      // Continuation line from parent spawn
      const cont = isLastSpawn ? "   " : `  ${BOX.v}`;
      const fPrefix = cont + (isLastFork ? `  \u2514\u2500\u2500 ` : `  \u251c\u2500\u2500 `);

      const forkLine =
        fPrefix +
        `ForkAgent ${fColor}(${fLabel})${ANSI.reset}  ` +
        `${ANSI.dim}depth=${fork.depth ?? "?"}${ANSI.reset}`;
      lines.push(boxLine(forkLine, width));
    }

    // Empty continuation line between spawn groups (if not last)
    if (!isLastSpawn) {
      lines.push(boxLine(`  ${BOX.v}`, width));
    }
  }

  return lines;
}

// ─── Rendering: Shared Memory ───────────────────────────────────────

function renderMemory(spawnId: string | null, width: number): string[] {
  const lines: string[] = [];

  if (!spawnId) {
    lines.push(boxSubHeader("SharedMemory", width));
    lines.push(boxLine(`  ${ANSI.gray}(no spawn selected)${ANSI.reset}`, width));
    return lines;
  }

  const label = `SpawnAgent ${truncateId(spawnId, 14)} SharedMemory`;
  lines.push(boxSubHeader(label, width));

  try {
    const snapshot = spawnBridge.getMemorySnapshot(spawnId);
    const entries = Object.values(snapshot.entries);

    if (entries.length === 0) {
      lines.push(boxLine(`  ${ANSI.gray}(empty)${ANSI.reset}`, width));
      return lines;
    }

    const displayEntries = entries.slice(0, 10);
    for (const entry of displayEntries) {
      const keyDisplay = entry.key.padEnd(14);
      const valDisplay = truncateValue(entry.value, 40);
      lines.push(
        boxLine(
          `  ${ANSI.cyan}${keyDisplay}${ANSI.reset} \u2192 ${ANSI.bold}${valDisplay}${ANSI.reset}`,
          width
        )
      );
    }

    if (entries.length > 10) {
      lines.push(
        boxLine(
          `  ${ANSI.gray}(${entries.length - 10} more entries...)${ANSI.reset}`,
          width
        )
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(boxLine(`  ${ANSI.gray}(${msg})${ANSI.reset}`, width));
  }

  return lines;
}

// ─── Rendering: Event Log ───────────────────────────────────────────

function renderEvents(width: number): string[] {
  const lines: string[] = [];
  lines.push(boxSubHeader(`Events (last ${MAX_EVENTS})`, width));

  if (eventLog.length === 0) {
    lines.push(boxLine(`  ${ANSI.gray}(no events yet)${ANSI.reset}`, width));
    return lines;
  }

  for (const evt of eventLog) {
    const timeStr = `${ANSI.gray}${evt.time}${ANSI.reset}`;

    let typeColor = ANSI.reset;
    if (evt.type === "SET") typeColor = ANSI.green;
    else if (evt.type === "DEL") typeColor = ANSI.red;
    else if (evt.type === "CLR") typeColor = ANSI.yellow;

    const typeStr = `${typeColor}${evt.type.padEnd(5)}${ANSI.reset}`;
    const shortId = truncateId(evt.agentId, 16);

    let detail: string;
    if (evt.type === "CLR") {
      detail = `${ANSI.dim}memory cleared${ANSI.reset}`.padEnd(30);
    } else if (evt.type === "DEL") {
      const keyPart = evt.key.padEnd(18);
      detail = `${ANSI.red}${keyPart}${ANSI.reset}`;
    } else {
      const keyPart = evt.key.padEnd(18);
      const valShort =
        evt.value.length > 20
          ? evt.value.slice(0, 19) + "\u2026"
          : evt.value;
      detail = `${keyPart} = ${valShort}`;
    }

    const byStr = `${ANSI.dim}by ${shortId}${ANSI.reset}`;
    lines.push(boxLine(`  ${timeStr}  ${typeStr} ${detail} ${byStr}`, width));
  }

  return lines;
}

// ─── Main Render Function ───────────────────────────────────────────

function render(targetSpawnId?: string, width = 78): string {
  const out: string[] = [];

  // ── Header ──
  out.push(boxHeader("OMO Instance Status", width));

  // ── Gather agents ──
  let agents: AgentInfo[];
  try {
    agents = spawnBridge.getAllAgents();
  } catch {
    agents = [];
  }

  // If bridge not initialized or no agents at all
  if (agents.length === 0) {
    out.push(
      boxLine(
        `  ${ANSI.yellow}No OMO instances running. Run spawnAgent() first.${ANSI.reset}`,
        width
      )
    );
    out.push(boxFooter(width));
    return out.join("\n");
  }

  // Subscribe to memory events for all spawns
  for (const a of agents) {
    if (a.type === AgentType.SPAWN) {
      subscribeToSpawnEvents(a.id);
    }
  }

  // Count total memory keys across all spawns
  let memoryKeyCount = 0;
  for (const a of agents) {
    if (a.type === AgentType.SPAWN) {
      try {
        const snap = spawnBridge.getMemorySnapshot(a.id);
        memoryKeyCount += Object.keys(snap.entries).length;
      } catch {
        // skip unreachable spawns
      }
    }
  }

  // ── Stats ──
  out.push(...renderStats(agents, memoryKeyCount, width));

  // ── Separator ──
  out.push(boxSeparator(width));

  // ── Agent tree ──
  out.push(...renderAgentTree(agents, width));

  // ── Blank spacer ──
  out.push(boxBlank(width));

  // ── Memory section ──
  const spawns = agents.filter((a) => a.type === AgentType.SPAWN);

  let selectedSpawnId: string | null = null;

  if (targetSpawnId) {
    // Verify it exists among known spawns
    if (spawns.some((s) => s.id === targetSpawnId)) {
      selectedSpawnId = targetSpawnId;
    }
    // If not found, fall through to first spawn below
  }

  if (!selectedSpawnId && spawns.length > 0) {
    selectedSpawnId = spawns[0].id;
  }

  out.push(...renderMemory(selectedSpawnId, width));

  // ── Events ──
  out.push(...renderEvents(width));

  // ── Footer ──
  out.push(boxFooter(width));

  return out.join("\n");
}

// ─── Entry Point ────────────────────────────────────────────────────

function main(): void {
  const targetSpawnId = process.argv[2] || undefined;
  const snapshot = render(targetSpawnId);
  process.stdout.write(snapshot + "\n");
}

main();
