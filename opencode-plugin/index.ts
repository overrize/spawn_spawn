/**
 * Fork-Agent OpenCode Server Plugin
 *
 * Same pattern as OMO:
 *   - client.tui?.showToast() → corner toasts
 *   - chat.message hook       → in-chat status
 *   - PluginModule { id, server } — NO tui export, NO JSX
 */
import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import type { PluginInput } from "@opencode-ai/plugin"

type ClientWithTui = {
  tui?: { showToast: (opts: { body: { title: string; message: string; variant: string; duration: number } }) => Promise<unknown> }
}

let spawnBridge: any = null

function buildStatus(): string | null {
  if (!spawnBridge) return null
  try {
    const agents = spawnBridge.getAllAgents()
    if (agents.length === 0) return null
    const spawns = agents.filter((a: any) => a.type === "SPAWN")
    const act = agents.filter((a: any) => a.status === "RUNNING").length
    const pau = agents.filter((a: any) => a.status === "PAUSED").length
    let mk = 0; for (const s of spawns) try { mk += Object.keys(spawnBridge.getMemorySnapshot(s.id).entries).length } catch {}
    const lines = [`${agents.length + 1} agents · ${act + 1} active · ${pau} paused · ${mk} keys`]
    for (const s of spawns.slice(0, 5)) {
      const ico = s.status === "RUNNING" ? "●" : s.status === "PAUSED" ? "◐" : "○"
      lines.push(`  ${ico} ${s.id.slice(0, 12)}… forks=${s.forkCount}`)
    }
    return lines.join("\n")
  } catch { return null }
}

const serverPlugin: Plugin = async (input: PluginInput) => {
  try { const m = await import("../omo-bridge/index.js"); spawnBridge = m.spawnBridge } catch {}

  return {
    async "event.session.start"(event: any) {
      const s = buildStatus()
      if (!s) return
      const c = input.client as unknown as ClientWithTui
      c.tui?.showToast({ body: { title: "Fork-Agent", message: s.split("\n")[0], variant: "info", duration: 4000 } }).catch(() => {})
    },
  }
}

const mod: PluginModule = { id: "fork-agent", server: serverPlugin }
export default mod
