/**
 * Fork-Agent Terminal Dashboard
 *
 * A terminal-native TUI (like htop) showing the fork-agent system in real-time.
 * Uses neo-blessed for terminal rendering.
 *
 * Run: npx tsx tui/dashboard.ts
 */

// ─── Imports ────────────────────────────────────────────────────────
// @ts-ignore - neo-blessed lacks type definitions
import blessed from "neo-blessed";
import { spawnBridge } from "../omo-bridge/index.js";
import { AgentStatus, AgentType } from "../src/core/types.js";
import type { AgentInfo } from "../omo-bridge/index.js";
import type { MemoryEventPayload } from "../src/core/types.js";

// ─── Types ─────────────────────────────────────────────────────────
interface EventLogEntry {
  time: string;
  type: string;
  key: string;
  value: string;
  agentId: string;
}

// ─── Global State ──────────────────────────────────────────────────
let selectedAgentId: string | null = null;
let allAgents: AgentInfo[] = [];
const eventLog: EventLogEntry[] = [];
const memorySubscriptions = new Map<string, () => void>();
const MAX_EVENT_LOG = 15;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let promptActive = false;

// ─── Status Display Helpers ────────────────────────────────────────
const STATUS_ICON: Record<AgentStatus, string> = {
  [AgentStatus.IDLE]: "○",
  [AgentStatus.INITIALIZING]: "◌",
  [AgentStatus.RUNNING]: "●",
  [AgentStatus.PAUSED]: "◐",
  [AgentStatus.RESUMING]: "◌",
  [AgentStatus.TERMINATING]: "◌",
  [AgentStatus.TERMINATED]: "✕",
  [AgentStatus.ERROR]: "⚠",
};

const STATUS_COLOR: Record<AgentStatus, string> = {
  [AgentStatus.IDLE]: "gray",
  [AgentStatus.INITIALIZING]: "blue",
  [AgentStatus.RUNNING]: "green",
  [AgentStatus.PAUSED]: "yellow",
  [AgentStatus.RESUMING]: "blue",
  [AgentStatus.TERMINATING]: "red",
  [AgentStatus.TERMINATED]: "red",
  [AgentStatus.ERROR]: "orange",
};

function statusDisplay(status: AgentStatus): string {
  const icon = STATUS_ICON[status] ?? "?";
  const color = STATUS_COLOR[status] ?? "white";
  return `{${color}-fg}${icon} ${status}{/${color}-fg}`;
}

function formatValue(val: unknown): string {
  if (val === null) return "null";
  if (typeof val === "object") {
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  }
  return String(val);
}

function padEnd(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}

// ─── Screen ────────────────────────────────────────────────────────
const screen = blessed.screen({
  smartCSR: true,
  title: "Fork-Agent Dashboard",
  cursor: { artificial: false, shape: "line", blink: true },
});

// ─── Widgets ───────────────────────────────────────────────────────
// Stats bar (top, 1 line)
const statsBox = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: "100%",
  height: 1,
  tags: true,
  content: "",
  style: { fg: "white", bg: "blue" },
});

// Agent tree (left panel, ~70% width)
const treeList = blessed.list({
  parent: screen,
  top: 1,
  left: 0,
  width: "70%",
  height: "100%-11",
  keys: true,
  vi: true,
  mouse: true,
  scrollable: true,
  interactive: true,
  border: { type: "line" },
  label: " Agent Tree ",
  tags: true,
  style: {
    fg: "white",
    selected: { bg: "blue", fg: "white" },
    item: { fg: "white" },
    border: { fg: "cyan" },
  },
});

// Agent detail (right top, ~30% width, ~50% height)
const detailBox = blessed.box({
  parent: screen,
  top: 1,
  left: "70%",
  width: "30%",
  height: "50%-6",
  border: { type: "line" },
  label: " Agent Detail ",
  scrollable: true,
  tags: true,
  content: "Select an agent\nto view details",
  style: { border: { fg: "cyan" } },
});

// Memory panel (right bottom, ~30% width, ~50% height)
const memoryBox = blessed.box({
  parent: screen,
  top: "50%-5",
  left: "70%",
  width: "30%",
  height: "50%-6",
  border: { type: "line" },
  label: " SharedMemory ",
  scrollable: true,
  tags: true,
  content: "Select a Spawn or Fork\nto view memory",
  style: { border: { fg: "cyan" } },
});

// Event log (bottom, full width, last 15 events)
const eventLogBox = blessed.box({
  parent: screen,
  bottom: 1,
  left: 0,
  width: "100%",
  height: 8,
  border: { type: "line" },
  label: " Events ",
  scrollable: true,
  tags: true,
  content: "No events yet",
  style: { border: { fg: "cyan" } },
});

// Footer (bottom, 1 line)
const footerBox = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: "100%",
  height: 1,
  tags: true,
  content:
    " {blue-bg}{white-fg} s:spawn  f:fork  p:pause  r:resume  t:terminate  m:mem-set  c:mem-clear  q:quit {/}",
  style: { fg: "white", bg: "blue" },
});

// Footer content (for restoration after prompts)
const FOOTER_DEFAULT =
  " {blue-bg}{white-fg} s:spawn  f:fork  p:pause  r:resume  t:terminate  m:mem-set  c:mem-clear  q:quit {/}";

// ─── Tree Building ─────────────────────────────────────────────────
/**
 * Build a flat tree display from AgentInfo[].
 * Returns array of display strings and a parallel array mapping each line to an agent ID.
 */
function buildAgentTree(agents: AgentInfo[]): {
  items: string[];
  indexMap: string[];
} {
  const items: string[] = [];
  const indexMap: string[] = [];

  // Separate spawns and forks
  const spawns = agents.filter((a) => a.type === AgentType.SPAWN);
  const forks = agents.filter((a) => a.type === AgentType.FORK);

  // Pseudo-Main entry (root of tree)
  const mainStatus = AgentStatus.RUNNING;
  items.push(
    `{white-fg}◆ {bold}Main{/bold}  ${statusDisplay(mainStatus)}{/white-fg}  (${spawns.length} spawns)`
  );
  indexMap.push("__main__");

  // Group forks by parent spawn
  const forkMap = new Map<string, AgentInfo[]>();
  for (const f of forks) {
    const pid = f.parentId ?? "";
    if (!forkMap.has(pid)) forkMap.set(pid, []);
    forkMap.get(pid)!.push(f);
  }

  // Render each spawn and its forks
  for (let si = 0; si < spawns.length; si++) {
    const spawn = spawns[si];
    const isLastSpawn = si === spawns.length - 1;
    const spawnPrefix = isLastSpawn ? "  └─ " : "  ├─ ";
    const statusStr = statusDisplay(spawn.status);
    const shortId = spawn.id.length > 20 ? spawn.id.slice(0, 20) + "…" : spawn.id;

    items.push(
      `${spawnPrefix}■ {bold}Spawn{/bold} ${statusStr}  {gray-fg}${shortId}{/gray-fg}` +
        `  (${spawn.forkCount ?? 0} forks)`
    );
    indexMap.push(spawn.id);

    const children = forkMap.get(spawn.id) ?? [];
    for (let fi = 0; fi < children.length; fi++) {
      const fork = children[fi];
      const isLastFork = fi === children.length - 1;
      const forkConnector = isLastSpawn ? "   " : "  │";
      const forkPrefix = forkConnector + (isLastFork ? "  └─ " : "  ├─ ");
      const fStatus = statusDisplay(fork.status);
      const fShortId = fork.id.length > 18 ? fork.id.slice(0, 18) + "…" : fork.id;

      items.push(
        `${forkPrefix}├ {bold}Fork{/bold} ${fStatus}  {gray-fg}${fShortId}{/gray-fg}`
      );
      indexMap.push(fork.id);
    }
  }

  return { items, indexMap };
}

/**
 * Get the effective spawn ID for memory operations.
 * If selected is FORK, returns its parent; if SPAWN, returns itself; if MAIN, returns null.
 */
function getMemorySpawnId(info: AgentInfo | undefined): string | null {
  if (!info) return null;
  if (info.type === AgentType.SPAWN) return info.id;
  if (info.type === AgentType.FORK) return info.parentId ?? null;
  return null; // MAIN
}

// ─── Rendering ─────────────────────────────────────────────────────
function renderStats(): void {
  const spawns = allAgents.filter((a) => a.type === AgentType.SPAWN);
  const forks = allAgents.filter((a) => a.type === AgentType.FORK);
  const total = allAgents.length + 1; // +1 for Main

  let active = 1; // Main is always considered active
  let paused = 0;
  let terminated = 0;

  for (const a of allAgents) {
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
    }
  }

  // Count total memory entries across all spawns
  let memCount = 0;
  for (const s of spawns) {
    try {
      const snap = spawnBridge.getMemorySnapshot(s.id);
      memCount += Object.keys(snap.entries).length;
    } catch {
      // Spawn might have been terminated between render cycles
    }
  }

  statsBox.setContent(
    ` {bold}Fork-Agent Dashboard{/bold} │ ` +
      `{white-fg}Agents:{/white-fg} ${total} │ ` +
      `{green-fg}Active:{/green-fg} ${active} │ ` +
      `{yellow-fg}Paused:{/yellow-fg} ${paused} │ ` +
      `{red-fg}Terminated:{/red-fg} ${terminated} │ ` +
      `Memory entries: ${memCount}`
  );
}

function renderTree(): void {
  const { items, indexMap } = buildAgentTree(allAgents);

  // Preserve selection
  let newSelected = 0;
  if (selectedAgentId) {
    const idx = indexMap.indexOf(selectedAgentId);
    if (idx >= 0) newSelected = idx;
  }

  treeList.setItems(items);

  // Only select if items changed to avoid flickering
  if (treeList.selected !== newSelected && items.length > 0) {
    treeList.select(newSelected);
  }

  // Update selected agent from current list position
  const currentIdx = treeList.selected;
  if (currentIdx >= 0 && currentIdx < indexMap.length) {
    const mappedId = indexMap[currentIdx];
    if (mappedId === "__main__") {
      selectedAgentId = "__main__";
    } else {
      selectedAgentId = mappedId;
    }
  }
}

function renderDetail(): void {
  const agent = getSelectedAgent();
  if (!agent) {
    detailBox.setContent("\n  {gray-fg}Select an agent{/gray-fg}\n  {gray-fg}to view details{/gray-fg}");
    return;
  }

  const status = agent.status;
  const color = STATUS_COLOR[status] ?? "white";
  const lines: string[] = [];

  lines.push("");
  const statusIcon = STATUS_ICON[status] ?? "?";

  lines.push(`  {bold}id:{/bold}        {gray-fg}${agent.id}{/gray-fg}`);
  lines.push(`  {bold}type:{/bold}      ${agent.type}`);
  lines.push(`  {bold}status:{/bold}    {${color}-fg}${statusIcon} ${status}{/${color}-fg}`);

  if (agent.parentId) {
    const shortParent =
      agent.parentId.length > 30 ? agent.parentId.slice(0, 30) + "…" : agent.parentId;
    lines.push(`  {bold}parentId:{/bold}  {gray-fg}${shortParent}{/gray-fg}`);
  }

  if (agent.forkCount !== undefined) {
    lines.push(`  {bold}forkCount:{/bold} ${agent.forkCount}`);
  }
  if (agent.depth !== undefined) {
    lines.push(`  {bold}depth:{/bold}     ${agent.depth}`);
  }

  lines.push("");

  detailBox.setContent(lines.join("\n"));
}

function renderMemory(): void {
  const agent = getSelectedAgent();
  if (!agent) {
    memoryBox.setContent(
      "\n  {gray-fg}Select a Spawn or Fork{/gray-fg}\n  {gray-fg}to view memory{/gray-fg}"
    );
    return;
  }

  if (agent.type === AgentType.MAIN) {
    memoryBox.setContent(
      "\n  {gray-fg}Select a Spawn or Fork{/gray-fg}\n  {gray-fg}to view memory{/gray-fg}"
    );
    return;
  }

  const spawnId = getMemorySpawnId(agent);
  if (!spawnId) {
    memoryBox.setContent("\n  {gray-fg}No memory available{/gray-fg}");
    return;
  }

  try {
    const snapshot = spawnBridge.getMemorySnapshot(spawnId);
    const entries = snapshot.entries;
    const keys = Object.keys(entries);

    if (keys.length === 0) {
      memoryBox.setContent("\n  {gray-fg}No entries{/gray-fg}");
      return;
    }

    const lines: string[] = [""];
    for (const key of keys.slice(0, 30)) {
      // Limit display to 30 entries
      const entry = entries[key];
      const val = formatValue(entry.value);
      const truncatedKey = key.length > 14 ? key.slice(0, 14) + "…" : key;
      const truncatedVal = val.length > 24 ? val.slice(0, 24) + "…" : val;
      lines.push(
        `  {green-fg}${padEnd(truncatedKey, 15)}{/green-fg} → {white-fg}${truncatedVal}{/white-fg}`
      );
    }

    if (keys.length > 30) {
      lines.push(`  {gray-fg}... and ${keys.length - 30} more{/gray-fg}`);
    }

    lines.push("");
    memoryBox.setContent(lines.join("\n"));
  } catch {
    memoryBox.setContent("\n  {gray-fg}Memory unavailable{/gray-fg}");
  }
}

function renderEventLog(): void {
  if (eventLog.length === 0) {
    eventLogBox.setContent("\n  {gray-fg}No events yet{/gray-fg}");
    return;
  }

  const lines: string[] = [];
  for (const evt of eventLog.slice(-MAX_EVENT_LOG)) {
    let typeColor = "white";
    if (evt.type.includes("SET")) typeColor = "green";
    else if (evt.type.includes("DELETE")) typeColor = "red";
    else if (evt.type.includes("CLEAR")) typeColor = "yellow";

    const agentShort =
      evt.agentId.length > 18 ? evt.agentId.slice(0, 18) + "…" : evt.agentId;
    const keyShort = evt.key.length > 14 ? evt.key.slice(0, 14) + "…" : evt.key;
    const valShort = evt.value.length > 16 ? evt.value.slice(0, 16) + "…" : evt.value;

    if (evt.type === "memory:clear") {
      lines.push(
        `{gray-fg}${evt.time}{/gray-fg} {${typeColor}-fg}${evt.type}{/${typeColor}-fg}  {gray-fg}by ${agentShort}{/gray-fg}`
      );
    } else if (evt.type === "memory:delete") {
      lines.push(
        `{gray-fg}${evt.time}{/gray-fg} {${typeColor}-fg}DELETE{/${typeColor}-fg}  ${keyShort}  {gray-fg}by ${agentShort}{/gray-fg}`
      );
    } else {
      lines.push(
        `{gray-fg}${evt.time}{/gray-fg} {${typeColor}-fg}SET{/${typeColor}-fg}    ${keyShort} = ${valShort}  {gray-fg}by ${agentShort}{/gray-fg}`
      );
    }
  }

  eventLogBox.setContent("\n  " + lines.join("\n  "));
  try {
    eventLogBox.scrollTo(eventLogBox.getScrollHeight());
  } catch {
    // scrollTo may not be available in all blessed versions
  }
}

function renderAll(): void {
  try {
    // Refresh agent list
    allAgents = spawnBridge.getAllAgents();
  } catch {
    // Bridge might not be initialized yet
    allAgents = [];
  }

  ensureMemorySubscriptions();
  renderStats();
  renderTree();
  renderDetail();
  renderMemory();
  renderEventLog();
  screen.render();
}

// ─── Selection ─────────────────────────────────────────────────────
function getSelectedAgent(): AgentInfo | undefined {
  if (!selectedAgentId || selectedAgentId === "__main__") return undefined;
  return allAgents.find((a) => a.id === selectedAgentId);
}

function getSelectedAgentInfo(): {
  info: AgentInfo | undefined;
  isMain: boolean;
} {
  if (!selectedAgentId || selectedAgentId === "__main__") {
    return { info: undefined, isMain: true };
  }
  const info = allAgents.find((a) => a.id === selectedAgentId);
  return { info, isMain: false };
}

// ─── Memory Event Subscriptions ────────────────────────────────────
function ensureMemorySubscriptions(): void {
  const existingSpawns = new Set(allAgents.filter((a) => a.type === AgentType.SPAWN).map((a) => a.id));

  // Unsubscribe from spawns that no longer exist
  for (const [spawnId, unsub] of Array.from(memorySubscriptions.entries())) {
    if (!existingSpawns.has(spawnId)) {
      try {
        unsub();
      } catch {
        // Ignore cleanup errors
      }
      memorySubscriptions.delete(spawnId);
    }
  }

  // Subscribe to new spawns
  for (const spawnId of Array.from(existingSpawns)) {
    if (!memorySubscriptions.has(spawnId)) {
      try {
        const unsub = spawnBridge.subscribeMemory(spawnId, (payload: MemoryEventPayload) => {
          addEventLog(payload);
        });
        memorySubscriptions.set(spawnId, unsub);
      } catch {
        // Spawn might not be available anymore
      }
    }
  }
}

function addEventLog(payload: MemoryEventPayload): void {
  const now = new Date(payload.timestamp);
  const time =
    String(now.getHours()).padStart(2, "0") +
    ":" +
    String(now.getMinutes()).padStart(2, "0") +
    ":" +
    String(now.getSeconds()).padStart(2, "0");

  eventLog.push({
    time,
    type: payload.type,
    key: payload.key ?? "",
    value: formatValue(payload.value ?? ""),
    agentId: payload.agentId,
  });

  // Keep only last MAX_EVENT_LOG entries
  while (eventLog.length > MAX_EVENT_LOG) {
    eventLog.shift();
  }
}

// ─── Async Prompt Helper ───────────────────────────────────────────
function asyncPrompt(label: string, initialValue?: string): Promise<string> {
  return new Promise<string>((resolve) => {
    promptActive = true;

    // Create a text input box overlaid at bottom
    const promptBox = blessed.textbox({
      parent: screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      inputOnFocus: true,
      keys: true,
      mouse: true,
      style: {
        fg: "yellow",
        bg: "black",
        focus: { bg: "blue" },
      },
    });

    footerBox.setContent(` {yellow-fg}${label}:{/yellow-fg} `);
    screen.render();

    // Set initial value if provided
    if (initialValue) {
      promptBox.setValue(initialValue);
    }

    promptBox.focus();
    screen.render();

    // On Enter/submit
    let resolved = false;
    function finish(value: string): void {
      if (resolved) return;
      resolved = true;
      promptActive = false;
      promptBox.hide();
      promptBox.destroy();
      footerBox.setContent(FOOTER_DEFAULT);
      screen.render();
      resolve(value);
    }

    promptBox.on("submit", (value: string) => {
      finish(value ? value.trim() : "");
    });

    promptBox.on("cancel", () => {
      finish("");
    });

    // Read input
    promptBox.readInput((err: Error | null, value: string) => {
      if (!resolved) {
        finish(err ? "" : value?.trim() ?? "");
      }
    });
  });
}

// ─── Task Helpers ──────────────────────────────────────────────────
async function doSpawn(): Promise<void> {
  const desc = await asyncPrompt("SpawnAgent description");
  if (!desc) return;

  try {
    const { spawnId } = await spawnBridge.spawnAgent(desc);
    eventLog.push({
      time: getTimeNow(),
      type: "spawn:created",
      key: "",
      value: desc,
      agentId: spawnId,
    });
    while (eventLog.length > MAX_EVENT_LOG) eventLog.shift();
    renderAll();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    eventLog.push({
      time: getTimeNow(),
      type: "error",
      key: "spawn",
      value: msg,
      agentId: "system",
    });
    renderAll();
  }
}

async function doFork(): Promise<void> {
  const { info } = getSelectedAgentInfo();
  if (!info || info.type !== AgentType.SPAWN) {
    eventLog.push({
      time: getTimeNow(),
      type: "error",
      key: "fork",
      value: "Select a SPAWN agent first",
      agentId: "system",
    });
    renderAll();
    return;
  }

  const desc = await asyncPrompt("ForkAgent description");
  if (!desc) return;

  try {
    const { forkId } = await spawnBridge.forkAgent(info.id, desc);
    eventLog.push({
      time: getTimeNow(),
      type: "fork:created",
      key: "",
      value: desc,
      agentId: forkId,
    });
    while (eventLog.length > MAX_EVENT_LOG) eventLog.shift();
    renderAll();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    eventLog.push({
      time: getTimeNow(),
      type: "error",
      key: "fork",
      value: msg,
      agentId: "system",
    });
    renderAll();
  }
}

async function doPause(): Promise<void> {
  const { info, isMain } = getSelectedAgentInfo();
  if (isMain || !info) {
    eventLog.push({
      time: getTimeNow(),
      type: "error",
      key: "pause",
      value: "Select a SPAWN or FORK agent",
      agentId: "system",
    });
    renderAll();
    return;
  }

  try {
    await spawnBridge.pauseAgent(info.id);
    eventLog.push({
      time: getTimeNow(),
      type: "agent:paused",
      key: "",
      value: info.id,
      agentId: info.id,
    });
    while (eventLog.length > MAX_EVENT_LOG) eventLog.shift();
    renderAll();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    eventLog.push({
      time: getTimeNow(),
      type: "error",
      key: "pause",
      value: msg,
      agentId: "system",
    });
    renderAll();
  }
}

async function doResume(): Promise<void> {
  const { info, isMain } = getSelectedAgentInfo();
  if (isMain || !info) {
    eventLog.push({
      time: getTimeNow(),
      type: "error",
      key: "resume",
      value: "Select a SPAWN or FORK agent",
      agentId: "system",
    });
    renderAll();
    return;
  }

  try {
    await spawnBridge.resumeAgent(info.id);
    eventLog.push({
      time: getTimeNow(),
      type: "agent:resumed",
      key: "",
      value: info.id,
      agentId: info.id,
    });
    while (eventLog.length > MAX_EVENT_LOG) eventLog.shift();
    renderAll();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    eventLog.push({
      time: getTimeNow(),
      type: "error",
      key: "resume",
      value: msg,
      agentId: "system",
    });
    renderAll();
  }
}

async function doTerminate(): Promise<void> {
  const { info, isMain } = getSelectedAgentInfo();
  if (isMain || !info) {
    eventLog.push({
      time: getTimeNow(),
      type: "error",
      key: "terminate",
      value: "Select a SPAWN or FORK agent",
      agentId: "system",
    });
    renderAll();
    return;
  }

  try {
    await spawnBridge.terminateAgent(info.id);
    selectedAgentId = null;
    eventLog.push({
      time: getTimeNow(),
      type: "agent:terminated",
      key: "",
      value: info.id,
      agentId: info.id,
    });
    while (eventLog.length > MAX_EVENT_LOG) eventLog.shift();
    renderAll();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    eventLog.push({
      time: getTimeNow(),
      type: "error",
      key: "terminate",
      value: msg,
      agentId: "system",
    });
    renderAll();
  }
}

async function doMemorySet(): Promise<void> {
  const agent = getSelectedAgent();
  const spawnId = getMemorySpawnId(agent);
  if (!spawnId) {
    eventLog.push({
      time: getTimeNow(),
      type: "error",
      key: "memory",
      value: "Select a Spawn or Fork agent first",
      agentId: "system",
    });
    renderAll();
    return;
  }

  const key = await asyncPrompt("Memory key");
  if (!key) return;

  const value = await asyncPrompt("Memory value");
  if (!value) return;

  try {
    // Try parsing as JSON if possible, otherwise store as string
    let parsedValue: unknown = value;
    try {
      parsedValue = JSON.parse(value);
    } catch {
      // Keep as string
    }
    spawnBridge.memorySet(spawnId, key, parsedValue as import("../src/core/types.js").JsonValue);
    renderAll();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    eventLog.push({
      time: getTimeNow(),
      type: "error",
      key: "memory-set",
      value: msg,
      agentId: "system",
    });
    renderAll();
  }
}

async function doMemoryClear(): Promise<void> {
  const agent = getSelectedAgent();
  const spawnId = getMemorySpawnId(agent);
  if (!spawnId) {
    eventLog.push({
      time: getTimeNow(),
      type: "error",
      key: "memory",
      value: "Select a Spawn or Fork agent first",
      agentId: "system",
    });
    renderAll();
    return;
  }

  try {
    spawnBridge.memoryClear(spawnId);
    renderAll();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    eventLog.push({
      time: getTimeNow(),
      type: "error",
      key: "memory-clear",
      value: msg,
      agentId: "system",
    });
    renderAll();
  }
}

// ─── Utilities ─────────────────────────────────────────────────────
function getTimeNow(): string {
  const now = new Date();
  return (
    String(now.getHours()).padStart(2, "0") +
    ":" +
    String(now.getMinutes()).padStart(2, "0") +
    ":" +
    String(now.getSeconds()).padStart(2, "0")
  );
}

// ─── Clean Exit ────────────────────────────────────────────────────
async function cleanExit(): Promise<void> {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  // Unsubscribe all memory listeners
  for (const [, unsub] of Array.from(memorySubscriptions.entries())) {
    try {
      unsub();
    } catch {
      // Ignore cleanup errors
    }
  }
  memorySubscriptions.clear();

  // Terminate all agents
  try {
    const agents = spawnBridge.getAllAgents();
    for (const agent of agents) {
      try {
        await spawnBridge.terminateAgent(agent.id);
      } catch {
        // Agent might already be terminated
      }
    }
  } catch {
    // Bridge might not be initialized
  }

  screen.destroy();
  process.exit(0);
}

// ─── Keyboard Handlers ─────────────────────────────────────────────
// Enter - select agent (show detail + memory)
treeList.on("select", (_item: unknown, index: number) => {
  // Build index map to get the agent ID
  const { indexMap } = buildAgentTree(allAgents);
  if (index >= 0 && index < indexMap.length) {
    const id = indexMap[index];
    selectedAgentId = id === "__main__" ? "__main__" : id;
  }
  renderDetail();
  renderMemory();
  screen.render();
});

// Quit
screen.key(["q", "C-c"], () => {
  cleanExit();
});

// Spawn
screen.key(["s"], () => {
  if (promptActive) return;
  doSpawn();
});

// Fork
screen.key(["f"], () => {
  if (promptActive) return;
  doFork();
});

// Pause
screen.key(["p"], () => {
  if (promptActive) return;
  doPause();
});

// Resume
screen.key(["r"], () => {
  if (promptActive) return;
  doResume();
});

// Terminate
screen.key(["t"], () => {
  if (promptActive) return;
  doTerminate();
});

// Memory set
screen.key(["m"], () => {
  if (promptActive) return;
  doMemorySet();
});

// Memory clear
screen.key(["c"], () => {
  if (promptActive) return;
  doMemoryClear();
});

// Handle screen resize
screen.on("resize", () => {
  renderAll();
});

// ─── Main ──────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // Initial render (before agents are created)
  renderAll();

  // Auto-init MainAgent + spawn 2 SpawnAgents with 2 ForkAgents each
  try {
    // Spawn first SpawnAgent
    const { spawnId: s1Id } = await spawnBridge.spawnAgent("Demo SpawnAgent A — web service manager", [
      "handle HTTP requests",
      "manage database connections",
    ]);
    eventLog.push({
      time: getTimeNow(),
      type: "spawn:created",
      key: "",
      value: "Demo SpawnAgent A",
      agentId: s1Id,
    });

    // Set some demo memory values
    spawnBridge.memorySet(s1Id, "config.url", "http://localhost:3000");
    spawnBridge.memorySet(s1Id, "db.host", "localhost");
    spawnBridge.memorySet(s1Id, "db.port", 5432);
    spawnBridge.memorySet(s1Id, "cache.ttl", 3600);
    spawnBridge.memorySet(s1Id, "auth.provider", "jwt");

    // Fork 2 ForkAgents from Spawn A
    const { forkId: f1aId } = await spawnBridge.forkAgent(s1Id, "Fork A1 — handle users route");
    eventLog.push({
      time: getTimeNow(),
      type: "fork:created",
      key: "",
      value: "Fork A1",
      agentId: f1aId,
    });

    const { forkId: f1bId } = await spawnBridge.forkAgent(s1Id, "Fork A2 — handle products route");
    eventLog.push({
      time: getTimeNow(),
      type: "fork:created",
      key: "",
      value: "Fork A2",
      agentId: f1bId,
    });

    // Pause one fork for demo
    await spawnBridge.pauseAgent(f1bId);

    // Spawn second SpawnAgent
    const { spawnId: s2Id } = await spawnBridge.spawnAgent("Demo SpawnAgent B — data pipeline", [
      "process data streams",
      "generate reports",
    ]);
    eventLog.push({
      time: getTimeNow(),
      type: "spawn:created",
      key: "",
      value: "Demo SpawnAgent B",
      agentId: s2Id,
    });

    spawnBridge.memorySet(s2Id, "pipeline.batchSize", 100);
    spawnBridge.memorySet(s2Id, "pipeline.timeout", 5000);
    spawnBridge.memorySet(s2Id, "output.format", "json");

    // Fork 2 ForkAgents from Spawn B
    const { forkId: f2aId } = await spawnBridge.forkAgent(s2Id, "Fork B1 — ETL processor");
    eventLog.push({
      time: getTimeNow(),
      type: "fork:created",
      key: "",
      value: "Fork B1",
      agentId: f2aId,
    });

    const { forkId: f2bId } = await spawnBridge.forkAgent(s2Id, "Fork B2 — report generator");
    eventLog.push({
      time: getTimeNow(),
      type: "fork:created",
      key: "",
      value: "Fork B2",
      agentId: f2bId,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    eventLog.push({
      time: getTimeNow(),
      type: "error",
      key: "startup",
      value: msg,
      agentId: "system",
    });
  }

  // Render after setup
  renderAll();

  // Start refresh loop (every 1 second)
  refreshTimer = setInterval(() => {
    try {
      renderAll();
    } catch {
      // Silently ignore refresh errors to keep the UI running
    }
  }, 1000);

  // Focus the tree list for keyboard navigation
  treeList.focus();
  screen.render();
}

// ─── Entry ─────────────────────────────────────────────────────────
main().catch((err: unknown) => {
  console.error("Dashboard startup failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
