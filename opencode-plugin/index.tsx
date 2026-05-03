/** @jsxImportSource @opentui/solid */
/**
 * Fork-Agent OpenCode TUI Plugin
 * 
 * Renders spawn management in the sidebar — between LSP status and cwd path.
 * Slot: sidebar_content, order: 250 (between internal blocks)
 */
import type {
  TuiPlugin,
  TuiPluginModule,
  TuiSlotPlugin,
  TuiPluginApi,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui"
import { Show, createMemo, createSignal, onCleanup } from "solid-js"

// ─── Plugin identity ────────────────────────────────────────────────

const id = "fork-agent"

// ─── Status helpers ──────────────────────────────────────────────────

const STATUS: Record<string, { icon: string; color: string }> = {
  RUNNING:     { icon: "●", color: "success" },
  PAUSED:      { icon: "◐", color: "warning" },
  TERMINATED:  { icon: "✕", color: "error"   },
  ERROR:       { icon: "⚠", color: "error"   },
  IDLE:        { icon: "○", color: "textMuted" },
  INITIALIZING:{ icon: "◌", color: "info"    },
  RESUMING:    { icon: "◌", color: "info"    },
  TERMINATING: { icon: "◌", color: "info"    },
}

function tid(id: string, max = 14) {
  return id.length <= max ? id : id.slice(0, max - 1) + "…"
}

// ─── Data fetching ───────────────────────────────────────────────────

interface SpawnInfo {
  id: string
  status: string
  forks: { id: string; status: string }[]
  forkCount: number
  memoryKeys: number
}

interface ForkState {
  total: number
  active: number
  paused: number
  memoryKeys: number
  spawns: SpawnInfo[]
}

function fetchState(api: TuiPluginApi): ForkState | null {
  try {
    const raw = api.kv.get<string>("fork-agent:state")
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ─── Sidebar component ───────────────────────────────────────────────

const ForkAgentPanel = (props: {
  theme: TuiThemeCurrent
  state: ForkState | null
}) => {
  const t = props.theme
  const s = props.state

  return (
    <box
      border
      borderColor={t.borderSubtle}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="column"
      gap={1}
    >
      {/* Header */}
      <text fg={t.accent}>
        <b>Spawn Management</b>
      </text>

      {!s ? (
        <text fg={t.textMuted}>No spawn agents</text>
      ) : (
        <>
          {/* Stats line */}
          <text fg={t.textMuted}>
            <span style={{ fg: t.text, bold: true }}>{s.total}</span> agents ·{" "}
            <span style={{ fg: t.success }}>{s.active} active</span> ·{" "}
            <span style={{ fg: t.warning }}>{s.paused} paused</span> ·{" "}
            <span style={{ fg: t.info }}>{s.memoryKeys} keys</span>
          </text>

          {/* Main agent */}
          <text fg={t.text}>
            <span fg={t.textMuted}>◆ Main </span>
            <span style={{ fg: t.success }}>● RUNNING</span>
            <span fg={t.textMuted}> ({s.spawns.length} spawns)</span>
          </text>

          {/* Spawn agent tree */}
          {s.spawns.map((spawn, si) => {
            const lastSpawn = si === s.spawns.length - 1
            const sc = STATUS[spawn.status] || STATUS.IDLE
            const prefix = lastSpawn ? "  └─ " : "  ├─ "

            return (
              <box key={spawn.id} flexDirection="column" gap={0}>
                <text fg={t.text}>
                  <span fg={t.textMuted}>{prefix}</span>
                  <span fg={t.textMuted}>■ Spawn </span>
                  <span style={{ fg: t[sc.color as keyof TuiThemeCurrent] as string }}>
                    {sc.icon} {spawn.status}
                  </span>
                  <span fg={t.textMuted}> {tid(spawn.id)}</span>
                  {spawn.memoryKeys > 0 && (
                    <span style={{ fg: t.info }}> [{spawn.memoryKeys}]</span>
                  )}
                </text>

                {/* Fork children */}
                {spawn.forks.map((fork, fi) => {
                  const lastFork = fi === spawn.forks.length - 1
                  const fc = STATUS[fork.status] || STATUS.IDLE
                  const fp = lastSpawn
                    ? lastFork ? "     └─ " : "     ├─ "
                    : lastFork ? "  │  └─ " : "  │  ├─ "

                  return (
                    <text key={fork.id} fg={t.text}>
                      <span fg={t.textMuted}>{fp}</span>
                      <span fg={t.textMuted}>{lastFork ? "└" : "├"} Fork </span>
                      <span style={{ fg: t[fc.color as keyof TuiThemeCurrent] as string }}>
                        {fc.icon} {fork.status}
                      </span>
                      <span fg={t.textMuted}> {tid(fork.id)}</span>
                    </text>
                  )
                })}
              </box>
            )
          })}
        </>
      )}
    </box>
  )
}

// ─── Slot plugin factory ─────────────────────────────────────────────

function createSlot(api: TuiPluginApi): TuiSlotPlugin {
  // Reactive state, refreshed via polling
  const [state, setState] = createSignal<ForkState | null>(null)

  const interval = setInterval(() => {
    const s = fetchState(api)
    if (s) setState(s)
  }, 2000)

  onCleanup(() => clearInterval(interval))

  return {
    order: 250, // between LSP status and cwd path
    slots: {
      sidebar_content(ctx) {
        return (
          <ForkAgentPanel
            theme={ctx.theme.current}
            state={state()}
          />
        )
      },
    },
  }
}

// ─── Plugin entry ────────────────────────────────────────────────────

const tui: TuiPlugin = async (api) => {
  api.slots.register(createSlot(api))
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
