import { spawnBridge } from '../../omo-bridge/index.js';
import { AgentType, AgentStatus } from '../../src/core/types.js';
import { AgentInfo } from '../../omo-bridge/spawn-bridge.js';

export interface AgentTreeNode {
  info: AgentInfo;
  children: AgentTreeNode[];
}

export interface MemoryFlowEdge {
  from: string;
  to: string;
  key: string;
  type: 'read' | 'write';
}

export interface TeamAggregation {
  totalAgents: number;
  activeAgents: number;
  pausedAgents: number;
  terminatedAgents: number;
  errorAgents: number;
  totalMemoryKeys: number;
  spawns: AgentInfo[];
  forks: AgentInfo[];
}

export interface AgentStore {
  agents: AgentInfo[];
  tree: AgentTreeNode | null;
  selectedId: string | null;
  team: TeamAggregation;
  memoryKeys: Map<string, Map<string, unknown>>;
  memoryFlows: MemoryFlowEdge[];
  events: Array<{ timestamp: number; type: string; key?: string; value?: unknown; agentId?: string }>;
  lastUpdate: number;
}

export type StoreListener = (store: Readonly<AgentStore>) => void;

export class Store {
  private state: AgentStore;
  private listeners: Set<StoreListener> = new Set();
  private unsubscribeFns: Array<() => void> = [];
  private maxEvents = 200;

  constructor() {
    this.state = {
      agents: [],
      tree: null,
      selectedId: null,
      team: emptyTeam(),
      memoryKeys: new Map(),
      memoryFlows: [],
      events: [],
      lastUpdate: 0,
    };
  }

  init(): void {
    this.refresh();
    this.subscribeAll();
  }

  getState(): Readonly<AgentStore> {
    return this.state;
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  select(id: string | null): void {
    this.state = { ...this.state, selectedId: id };
    this.notify();
  }

  refresh(): void {
    try {
      const agents = spawnBridge.getAllAgents();
      this.state = {
        ...this.state,
        agents,
        tree: buildTree(agents),
        team: computeTeam(agents),
        memoryKeys: snapshotAllMemory(agents),
        lastUpdate: Date.now(),
      };
      this.notify();
    } catch {}
  }

  destroy(): void {
    this.unsubscribeFns.forEach(fn => { try { fn(); } catch {} });
    this.unsubscribeFns = [];
    this.listeners.clear();
  }

  private subscribeAll(): void {
    try {
      const agents = spawnBridge.getAllAgents();
      for (const agent of agents) {
        if (agent.type === AgentType.SPAWN) {
          try {
            const unsub = spawnBridge.subscribeMemory(agent.id, (event: { type: string; key?: string; value?: unknown; agentId?: string }) => {
              this.addEvent(event);
              this.refresh();
            });
            this.unsubscribeFns.push(unsub);
          } catch {}
        }
      }
    } catch {}
  }

  private addEvent(event: { type: string; key?: string; value?: unknown; agentId?: string }): void {
    const entry = { timestamp: Date.now(), ...event };
    const events = [entry, ...this.state.events].slice(0, this.maxEvents);
    this.state = { ...this.state, events };
  }

  private notify(): void {
    const snapshot = this.state;
    for (const fn of this.listeners) {
      try { fn(snapshot); } catch {}
    }
  }
}

export const store = new Store();

function emptyTeam(): TeamAggregation {
  return { totalAgents: 0, activeAgents: 0, pausedAgents: 0, terminatedAgents: 0, errorAgents: 0, totalMemoryKeys: 0, spawns: [], forks: [] };
}

function buildTree(agents: AgentInfo[]): AgentTreeNode | null {
  let mainAgent = agents.find(a => a.type === AgentType.MAIN);
  if (!mainAgent) {
    try {
      const all = spawnBridge.getAllAgents();
      if (all.length > 0 && all[0].parentId) {
        mainAgent = {
          id: all[0].parentId,
          type: AgentType.MAIN,
          status: AgentStatus.RUNNING,
          parentId: undefined,
          forkCount: agents.filter(a => a.type === AgentType.SPAWN).length,
          depth: 0,
        };
      }
      if (!mainAgent) return null;
    } catch {
      return null;
    }
  }

  const spawns = agents.filter(a => a.type === AgentType.SPAWN);
  const forks = agents.filter(a => a.type === AgentType.FORK);
  const forksByParent = new Map<string, AgentInfo[]>();
  for (const f of forks) {
    const pid = f.parentId ?? '';
    if (!forksByParent.has(pid)) forksByParent.set(pid, []);
    forksByParent.get(pid)!.push(f);
  }

  return {
    info: mainAgent,
    children: spawns.map(s => ({
      info: s,
      children: (forksByParent.get(s.id) ?? []).map(f => ({ info: f, children: [] })),
    })),
  };
}

function computeTeam(agents: AgentInfo[]): TeamAggregation {
  const spawns = agents.filter(a => a.type === AgentType.SPAWN);
  const forks = agents.filter(a => a.type === AgentType.FORK);
  let totalMemoryKeys = 0;
  for (const s of spawns) {
    try {
      totalMemoryKeys += Object.keys(spawnBridge.getMemorySnapshot(s.id).entries).length;
    } catch {}
  }

  return {
    totalAgents: agents.length + 1,
    activeAgents: 1 + agents.filter(a =>
      a.status === AgentStatus.RUNNING ||
      a.status === AgentStatus.INITIALIZING ||
      a.status === AgentStatus.RESUMING
    ).length,
    pausedAgents: agents.filter(a => a.status === AgentStatus.PAUSED).length,
    terminatedAgents: agents.filter(a => a.status === AgentStatus.TERMINATED).length,
    errorAgents: agents.filter(a => a.status === AgentStatus.ERROR).length,
    totalMemoryKeys,
    spawns,
    forks,
  };
}

function snapshotAllMemory(agents: AgentInfo[]): Map<string, Map<string, unknown>> {
  const result = new Map<string, Map<string, unknown>>();
  for (const agent of agents) {
    if (agent.type === AgentType.SPAWN) {
      try {
        const snap = spawnBridge.getMemorySnapshot(agent.id);
        const map = new Map<string, unknown>();
        for (const [key, entry] of Object.entries(snap.entries)) {
          map.set(key, (entry as { value: unknown }).value);
        }
        result.set(agent.id, map);
      } catch {}
    }
  }
  return result;
}
