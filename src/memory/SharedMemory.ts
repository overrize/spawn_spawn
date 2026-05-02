import { EventEmitter } from "events";
import {
  AgentId,
  JsonValue,
  MemoryEntry,
  MemorySnapshot,
  MemoryEventType,
  MemoryEventPayload,
} from "../core/types";

/**
 * SharedMemory — serializable, event-driven shared memory.
 *
 * SpawnAgents own a SharedMemory instance.
 * ForkAgents reference the SAME instance (not a copy).
 * All writes emit events so that sibling ForkAgents can react.
 *
 * Supports full JSON serialization for persistence.
 */
export class SharedMemory extends EventEmitter {
  private _entries: Map<string, MemoryEntry>;
  private _ownerId: AgentId;

  constructor(ownerId: AgentId, entries?: Map<string, MemoryEntry>) {
    super();
    this._ownerId = ownerId;
    this._entries = entries ?? new Map();
    // Increase max listeners — fork agents may subscribe heavily
    this.setMaxListeners(100);
  }

  /** Number of entries in memory */
  get size(): number {
    return this._entries.size;
  }

  /** All keys */
  get keys(): IterableIterator<string> {
    return this._entries.keys();
  }

  /**
   * Set a value in shared memory.
   * Emits `memory:set` event with old value.
   */
  set(key: string, value: JsonValue, agentId: AgentId): void {
    const previous = this._entries.get(key);
    const entry: MemoryEntry = {
      key,
      value,
      updatedAt: Date.now(),
      updatedBy: agentId,
    };
    this._entries.set(key, entry);

    const payload: MemoryEventPayload = {
      type: MemoryEventType.SET,
      key,
      value,
      previousValue: previous?.value,
      agentId,
      timestamp: entry.updatedAt,
    };
    this.emit(MemoryEventType.SET, payload);
  }

  /**
   * Get a value from shared memory.
   * Returns the raw JsonValue, or undefined if not found.
   */
  get(key: string): JsonValue | undefined {
    return this._entries.get(key)?.value;
  }

  /**
   * Get the full entry (includes metadata: updatedAt, updatedBy).
   */
  getEntry(key: string): MemoryEntry | undefined {
    return this._entries.get(key);
  }

  /**
   * Check if a key exists.
   */
  has(key: string): boolean {
    return this._entries.has(key);
  }

  /**
   * Delete a key.
   * Emits `memory:delete` event.
   */
  delete(key: string, agentId: AgentId): boolean {
    const previous = this._entries.get(key);
    if (!previous) return false;

    this._entries.delete(key);

    const payload: MemoryEventPayload = {
      type: MemoryEventType.DELETE,
      key,
      previousValue: previous.value,
      agentId,
      timestamp: Date.now(),
    };
    this.emit(MemoryEventType.DELETE, payload);
    return true;
  }

  /**
   * Clear all entries.
   * Emits `memory:clear` event.
   */
  clear(agentId: AgentId): void {
    this._entries.clear();

    const payload: MemoryEventPayload = {
      type: MemoryEventType.CLEAR,
      agentId,
      timestamp: Date.now(),
    };
    this.emit(MemoryEventType.CLEAR, payload);
  }

  /**
   * Subscribe to memory changes.
   * Returns an unsubscribe function.
   */
  onChange(callback: (payload: MemoryEventPayload) => void): () => void {
    this.on(MemoryEventType.SET, callback);
    this.on(MemoryEventType.DELETE, callback);
    this.on(MemoryEventType.CLEAR, callback);
    return () => {
      this.off(MemoryEventType.SET, callback);
      this.off(MemoryEventType.DELETE, callback);
      this.off(MemoryEventType.CLEAR, callback);
    };
  }

  /**
   * Subscribe to a specific key's changes.
   */
  onKeyChange(key: string, callback: (payload: MemoryEventPayload) => void): () => void {
    const handler = (payload: MemoryEventPayload) => {
      if (payload.key === key) callback(payload);
    };
    this.on(MemoryEventType.SET, handler);
    this.on(MemoryEventType.DELETE, handler);
    return () => {
      this.off(MemoryEventType.SET, handler);
      this.off(MemoryEventType.DELETE, handler);
    };
  }

  /**
   * Serialize the entire memory to a snapshot (for persistence).
   */
  serialize(agentId: AgentId): MemorySnapshot {
    const entries: Record<string, MemoryEntry> = {};
    for (const [key, entry] of this._entries) {
      entries[key] = { ...entry };
    }
    return {
      entries,
      createdAt: Date.now(),
      createdBy: agentId,
    };
  }

  /**
   * Deserialize a snapshot back into memory.
   * Overwrites current entries.
   */
  deserialize(snapshot: MemorySnapshot, agentId: AgentId): void {
    this._entries.clear();
    for (const [key, entry] of Object.entries(snapshot.entries)) {
      this._entries.set(key, { ...entry });
    }
    const payload: MemoryEventPayload = {
      type: MemoryEventType.SNAPSHOT,
      agentId,
      timestamp: Date.now(),
    };
    this.emit(MemoryEventType.SNAPSHOT, payload);
  }

  /**
   * Export as a plain object (for JSON.stringify).
   */
  toJSON(): Record<string, JsonValue> {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of this._entries) {
      result[key] = entry.value;
    }
    return result;
  }
}
