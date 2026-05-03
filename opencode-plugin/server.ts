/**
 * OpenCode Server Plugin — Fork-Agent Bridge
 *
 * Runs alongside OMO in the server process.
 * Publishes fork-agent state to KV store for the TUI plugin to read.
 *
 * Install alongside the TUI plugin in opencode.json.
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin";

export default async function forkAgentServer(input: PluginInput): Promise<Record<string, unknown>> {
  // Dynamically import spawnBridge when available
  let spawnBridge: any = null;
  try {
    const mod = await import("../../omo-bridge/index.js");
    spawnBridge = mod.spawnBridge;
  } catch {
    // Bridge not available — TUI will show "No spawn agents"
  }

  // Poll spawnBridge state every 2 seconds, publish to KV
  const interval = setInterval(() => {
    if (!spawnBridge) return;

    try {
      const agents = spawnBridge.getAllAgents();
      const spawns = agents.filter((a: any) => a.type === "SPAWN");
      const forks = agents.filter((a: any) => a.type === "FORK");

      let totalMemoryKeys = 0;
      const spawnData = spawns.map((s: any) => {
        let keys = 0;
        try {
          const snap = spawnBridge.getMemorySnapshot(s.id);
          keys = Object.keys(snap.entries).length;
          totalMemoryKeys += keys;
        } catch {}
        return {
          id: s.id,
          status: s.status,
          forkIds: spawnBridge
            .getAllAgents()
            .filter((a: any) => a.type === "FORK" && a.parentId === s.id)
            .map((f: any) => f.id),
          forkCount: s.forkCount ?? 0,
          memoryKeys: keys,
        };
      });

      const state = {
        mainStatus: "RUNNING",
        spawns: spawnData,
        forks: forks.map((f: any) => ({
          id: f.id,
          status: f.status,
          parentId: f.parentId ?? "",
        })),
        totalAgents: agents.length + 1,
        activeCount:
          1 +
          agents.filter(
            (a: any) =>
              a.status === "RUNNING" ||
              a.status === "INITIALIZING" ||
              a.status === "RESUMING"
          ).length,
        pausedCount: agents.filter((a: any) => a.status === "PAUSED").length,
        totalMemoryKeys,
      };

      input.client.kv.set("fork-agent:state", JSON.stringify(state));
    } catch (err) {
      // Silently skip — bridge might not be ready
    }
  }, 2000);

  return {
    dispose() {
      clearInterval(interval);
    },
  };
}
