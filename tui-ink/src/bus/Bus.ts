/**
 * SpawnBus — typed PubSub event bus for the multi-agent TUI.
 *
 * Design principles (adapted from MiMoCode opencode/src/bus):
 *  - All agent events flow through one bus instead of hardwired index.tsx listeners.
 *  - Subscribers never need to know which agent emitted an event.
 *  - Agent-to-agent message routing is handled centrally: any `message` event
 *    where `to !== "user"` is automatically forwarded to the registered target agent.
 *  - The bus is an *additive* layer — existing `.on("event")` wiring in index.tsx
 *    keeps working unchanged. The bus runs in parallel, not instead.
 *
 * Usage:
 *   // publish (called by httpAgent after this.emit):
 *   globalBus.publish(event)
 *
 *   // subscribe to one event type:
 *   const unsub = globalBus.subscribe("agent.state", (e) => console.log(e.state))
 *   unsub() // remove listener
 *
 *   // subscribe to all events (e.g. store.applyEvent):
 *   const unsub = globalBus.subscribeAll((e) => applyEvent(e))
 *
 *   // register an agent so message routing can find it:
 *   globalBus.registerAgent(id, { sendCommand: (cmd) => agent.sendCommand(cmd) })
 *   globalBus.unregisterAgent(id) // on agent teardown
 */

import { EventEmitter } from "node:events";
import type { TuiEvent, AgentCommand } from "../protocol.js";

export type BusPayload = TuiEvent;

// ── Append-only ring buffer log ────────────────────────────────────────────
// Every published event is appended here (monotone offset). Oldest entries
// are evicted once the buffer exceeds LOG_RING_SIZE. Subscribers can call
// getLog(sinceOffset) to pull incremental slices without re-reading history.

export interface LogEntry {
  offset: number;   // monotonically increasing, process-lifetime unique
  ts: number;       // Date.now() at publish time
  event: BusPayload;
}

const LOG_RING_SIZE = Math.max(100, parseInt(process.env.BUS_LOG_SIZE ?? "500", 10));

type TypedHandler<T extends BusPayload["type"]> = (
  event: Extract<BusPayload, { type: T }>,
) => void;
type WildcardHandler = (event: BusPayload) => void;

export interface AgentRef {
  sendCommand(cmd: AgentCommand): void;
}

const WILDCARD = "*" as const;

export class SpawnBus {
  private readonly ee = new EventEmitter();
  private readonly agents = new Map<string, AgentRef>();
  /** Maps logical (requested) agent ID → actual (renamed) agent ID for collision recovery. */
  private readonly aliases = new Map<string, string>();

  // ── Ring buffer log ──────────────────────────────────────────────────────
  private readonly _log: LogEntry[] = [];
  private _nextOffset = 0;

  constructor() {
    this.ee.setMaxListeners(200);
  }

  // ─── Agent registry ────────────────────────────────────────────────────────

  registerAgent(id: string, agent: AgentRef): void {
    this.agents.set(id, agent);
  }

  unregisterAgent(id: string): void {
    this.agents.delete(id);
    // Clean up any alias that pointed to this agent.
    for (const [alias, target] of this.aliases) {
      if (target === id) this.aliases.delete(alias);
    }
  }

  hasAgent(id: string): boolean {
    return this.agents.has(id) || this.agents.has(this.aliases.get(id) ?? "");
  }

  /** Register a logical→physical ID alias so routeMessage("old-id") reaches "new-id". */
  addAlias(logicalId: string, physicalId: string): void {
    this.aliases.set(logicalId, physicalId);
  }

  // ─── Publish ───────────────────────────────────────────────────────────────

  publish(event: BusPayload): void {
    // Fan out to typed subscribers.
    this.ee.emit(event.type, event);
    // Fan out to wildcard subscribers (applyEvent, feishu bridge, etc.).
    this.ee.emit(WILDCARD, event);
    // Append to ring buffer — evict oldest when full.
    this._log.push({ offset: this._nextOffset++, ts: Date.now(), event });
    if (this._log.length > LOG_RING_SIZE) this._log.shift();
  }

  // ── Log query API ─────────────────────────────────────────────────────────

  /** Current head offset (= total events published, not clamped to ring size). */
  getHeadOffset(): number { return this._nextOffset; }

  /**
   * Return all log entries with offset >= sinceOffset.
   * If sinceOffset falls before the oldest entry in the ring, returns what's available.
   */
  getLog(sinceOffset = 0): { entries: LogEntry[]; headOffset: number } {
    const entries = this._log.filter((e) => e.offset >= sinceOffset);
    return { entries, headOffset: this._nextOffset };
  }

  /** Diagnostic snapshot — ring size, head offset, oldest retained offset. */
  logStats(): { size: number; headOffset: number; oldestOffset: number } {
    return {
      size: this._log.length,
      headOffset: this._nextOffset,
      oldestOffset: this._log[0]?.offset ?? 0,
    };
  }

  /**
   * Route an agent-to-agent message to its target.
   * Called by index.tsx routing logic — centralises the lookup so callers don't
   * need to import `agents` directly. Returns false if the target is not found.
   *
   * NOTE: index.tsx still handles the illegal-message interception (worker→user,
   * worker→worker) with its own correction logic; this method is only invoked for
   * the normal forwarding path after those guards pass.
   */
  routeMessage(
    fromId: string,
    toId: string,
    text: string,
    opts?: { prefix?: string },
  ): boolean {
    const resolvedId = this.aliases.get(toId) ?? toId;
    const target = this.agents.get(resolvedId);
    if (!target) return false;
    const prefix = opts?.prefix ?? `[${fromId}]`;
    target.sendCommand({ type: "user.message", text: `${prefix} ${text}` });
    return true;
  }

  // ─── Subscribe (typed) ─────────────────────────────────────────────────────

  subscribe<T extends BusPayload["type"]>(
    type: T,
    handler: TypedHandler<T>,
  ): () => void {
    // Cast: the EventEmitter doesn't know about our type narrowing, but the
    // handler only fires for events of the requested type, so this is safe.
    const h = handler as WildcardHandler;
    this.ee.on(type, h);
    return () => this.ee.off(type, h);
  }

  // ─── Subscribe all (wildcard) ──────────────────────────────────────────────

  subscribeAll(handler: WildcardHandler): () => void {
    this.ee.on(WILDCARD, handler);
    return () => this.ee.off(WILDCARD, handler);
  }

  // ─── Diagnostics ──────────────────────────────────────────────────────────

  /** Snapshot of registered agent IDs — for debugging / tests only. */
  registeredAgents(): string[] {
    return [...this.agents.keys()];
  }

  /** Total subscriber count across all channels — for debugging / tests only. */
  listenerCount(): number {
    return this.ee.eventNames().reduce(
      (sum, name) => sum + this.ee.listenerCount(name as string),
      0,
    );
  }
}

/** Process-wide singleton. Import and use directly. */
export const globalBus = new SpawnBus();
