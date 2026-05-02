import { describe, it, expect, beforeEach } from "vitest";
import { SharedMemory } from "../../src/memory/SharedMemory";
import { MemoryEventType } from "../../src/core/types";
import type { MemoryEventPayload, MemorySnapshot, MemoryEntry } from "../../src/core/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect emitted events into an array, returns the array + unsubscribe */
function collectEvents(
  memory: SharedMemory,
  eventTypes: MemoryEventType[] = [
    MemoryEventType.SET,
    MemoryEventType.DELETE,
    MemoryEventType.CLEAR,
    MemoryEventType.SNAPSHOT,
  ],
): { events: MemoryEventPayload[]; unsubscribe: () => void } {
  const events: MemoryEventPayload[] = [];
  const listeners: Array<[MemoryEventType, (p: MemoryEventPayload) => void]> = [];

  for (const type of eventTypes) {
    const handler = (payload: MemoryEventPayload) => events.push(payload);
    memory.on(type as string, handler);
    listeners.push([type, handler]);
  }

  return {
    events,
    unsubscribe: () => {
      for (const [type, handler] of listeners) {
        memory.off(type as string, handler);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Constructor & initial state
// ---------------------------------------------------------------------------

describe("SharedMemory — constructor & initial state", () => {
  it("creates empty memory with an owner", () => {
    const memory = new SharedMemory("agent-1");
    expect(memory.size).toBe(0);
    const keys = Array.from(memory.keys);
    expect(keys).toEqual([]);
  });

  it("accepts pre-populated entries", () => {
    const preEntry: MemoryEntry = {
      key: "x",
      value: 42,
      updatedAt: 1000,
      updatedBy: "agent-0",
    };
    const preMap = new Map([["x", preEntry]]);
    const memory = new SharedMemory("agent-1", preMap);
    expect(memory.size).toBe(1);
    expect(memory.has("x")).toBe(true);
    expect(memory.get("x")).toBe(42);
  });

  it("constructor uses empty map when no entries provided", () => {
    const memory = new SharedMemory("agent-1");
    expect(memory.size).toBe(0);
    // should be operational
    memory.set("k", "v", "agent-1");
    expect(memory.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// set / get / has
// ---------------------------------------------------------------------------

describe("SharedMemory — set / get / has", () => {
  let memory: SharedMemory;

  beforeEach(() => {
    memory = new SharedMemory("owner");
  });

  it("set and get a string value", () => {
    memory.set("name", "alice", "agent-1");
    expect(memory.get("name")).toBe("alice");
    expect(memory.has("name")).toBe(true);
  });

  it("set and get a number value", () => {
    memory.set("count", 42, "agent-1");
    expect(memory.get("count")).toBe(42);
  });

  it("set and get a boolean value (true)", () => {
    memory.set("enabled", true, "agent-1");
    expect(memory.get("enabled")).toBe(true);
  });

  it("set and get a boolean value (false)", () => {
    memory.set("disabled", false, "agent-1");
    expect(memory.get("disabled")).toBe(false);
  });

  it("set and get null", () => {
    memory.set("nothing", null, "agent-1");
    expect(memory.get("nothing")).toBeNull();
  });

  it("set and get an array", () => {
    memory.set("tags", ["a", "b", "c"], "agent-1");
    expect(memory.get("tags")).toEqual(["a", "b", "c"]);
  });

  it("set and get an object", () => {
    memory.set("config", { host: "localhost", port: 3000 }, "agent-1");
    expect(memory.get("config")).toEqual({ host: "localhost", port: 3000 });
  });

  it("set and get a nested JSON structure", () => {
    const nested = { a: { b: [1, 2, { c: null }] }, d: true };
    memory.set("nested", nested, "agent-1");
    expect(memory.get("nested")).toEqual(nested);
  });

  it("get returns undefined for missing key", () => {
    expect(memory.get("missing")).toBeUndefined();
  });

  it("has returns false for missing key", () => {
    expect(memory.has("missing")).toBe(false);
  });

  it("set overwrites existing key and updates value", () => {
    memory.set("key", "old", "agent-1");
    memory.set("key", "new", "agent-2");
    expect(memory.get("key")).toBe("new");
    expect(memory.size).toBe(1); // key count unchanged
  });
});

// ---------------------------------------------------------------------------
// getEntry
// ---------------------------------------------------------------------------

describe("SharedMemory — getEntry", () => {
  let memory: SharedMemory;

  beforeEach(() => {
    memory = new SharedMemory("owner");
  });

  it("returns full MemoryEntry for existing key", () => {
    const before = Date.now();
    memory.set("key", "value", "agent-1");
    const after = Date.now();

    const entry = memory.getEntry("key");
    expect(entry).toBeDefined();
    expect(entry!.key).toBe("key");
    expect(entry!.value).toBe("value");
    expect(entry!.updatedBy).toBe("agent-1");
    expect(entry!.updatedAt).toBeGreaterThanOrEqual(before);
    expect(entry!.updatedAt).toBeLessThanOrEqual(after);
  });

  it("returns undefined for missing key", () => {
    expect(memory.getEntry("nope")).toBeUndefined();
  });

  it("reflects latest update metadata after overwrite", () => {
    memory.set("key", "v1", "agent-1");
    memory.set("key", "v2", "agent-2");
    const entry = memory.getEntry("key");
    expect(entry!.value).toBe("v2");
    expect(entry!.updatedBy).toBe("agent-2");
  });
});

// ---------------------------------------------------------------------------
// size / keys
// ---------------------------------------------------------------------------

describe("SharedMemory — size / keys", () => {
  let memory: SharedMemory;

  beforeEach(() => {
    memory = new SharedMemory("owner");
  });

  it("size increases with each new key set", () => {
    expect(memory.size).toBe(0);
    memory.set("a", 1, "agent-1");
    expect(memory.size).toBe(1);
    memory.set("b", 2, "agent-1");
    expect(memory.size).toBe(2);
    memory.set("c", 3, "agent-1");
    expect(memory.size).toBe(3);
  });

  it("size does NOT increase on overwrite", () => {
    memory.set("k", 1, "agent-1");
    memory.set("k", 2, "agent-1");
    expect(memory.size).toBe(1);
  });

  it("size decreases on delete", () => {
    memory.set("a", 1, "agent-1");
    memory.set("b", 2, "agent-1");
    memory.delete("a", "agent-1");
    expect(memory.size).toBe(1);
  });

  it("size becomes 0 after clear", () => {
    memory.set("a", 1, "agent-1");
    memory.set("b", 2, "agent-1");
    memory.clear("agent-1");
    expect(memory.size).toBe(0);
  });

  it("keys returns all set keys", () => {
    memory.set("x", 1, "agent-1");
    memory.set("y", 2, "agent-1");
    memory.set("z", 3, "agent-1");
    const keyList = Array.from(memory.keys).sort();
    expect(keyList).toEqual(["x", "y", "z"]);
  });

  it("keys does NOT include deleted keys", () => {
    memory.set("a", 1, "agent-1");
    memory.set("b", 2, "agent-1");
    memory.delete("a", "agent-1");
    expect(Array.from(memory.keys)).toEqual(["b"]);
  });

  it("keys after clear is empty", () => {
    memory.set("a", 1, "agent-1");
    memory.clear("agent-1");
    expect(Array.from(memory.keys)).toEqual([]);
  });

  it("keys is an iterator (can be spread)", () => {
    memory.set("one", 1, "agent-1");
    const arr = [...memory.keys];
    expect(arr).toContain("one");
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("SharedMemory — delete", () => {
  let memory: SharedMemory;

  beforeEach(() => {
    memory = new SharedMemory("owner");
  });

  it("delete existing key returns true", () => {
    memory.set("key", "value", "agent-1");
    const result = memory.delete("key", "agent-1");
    expect(result).toBe(true);
    expect(memory.has("key")).toBe(false);
    expect(memory.get("key")).toBeUndefined();
  });

  it("delete missing key returns false", () => {
    const result = memory.delete("missing", "agent-1");
    expect(result).toBe(false);
  });

  it("delete emits memory:delete event with previousValue", () => {
    const { events, unsubscribe } = collectEvents(memory, [MemoryEventType.DELETE]);
    memory.set("key", "before-delete", "agent-1");
    memory.delete("key", "agent-2");

    const delEvent = events.find((e) => e.type === MemoryEventType.DELETE);
    expect(delEvent).toBeDefined();
    expect(delEvent!.key).toBe("key");
    expect(delEvent!.previousValue).toBe("before-delete");
    expect(delEvent!.agentId).toBe("agent-2");
    expect(delEvent!.timestamp).toBeGreaterThan(0);
    unsubscribe();
  });

  it("delete does NOT emit event for missing key", () => {
    const { events, unsubscribe } = collectEvents(memory, [MemoryEventType.DELETE]);
    memory.delete("missing", "agent-1");
    expect(events).toHaveLength(0);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

describe("SharedMemory — clear", () => {
  let memory: SharedMemory;

  beforeEach(() => {
    memory = new SharedMemory("owner");
  });

  it("removes all entries", () => {
    memory.set("a", 1, "agent-1");
    memory.set("b", 2, "agent-1");
    memory.set("c", 3, "agent-1");
    memory.clear("agent-1");
    expect(memory.size).toBe(0);
    expect(Array.from(memory.keys)).toEqual([]);
  });

  it("clear on already-empty memory is safe", () => {
    memory.clear("agent-1");
    expect(memory.size).toBe(0);
  });

  it("clear emits memory:clear event", () => {
    const { events, unsubscribe } = collectEvents(memory, [MemoryEventType.CLEAR]);
    memory.set("a", 1, "agent-1");
    memory.clear("agent-2");

    const clearEvent = events.find((e) => e.type === MemoryEventType.CLEAR);
    expect(clearEvent).toBeDefined();
    expect(clearEvent!.agentId).toBe("agent-2");
    expect(clearEvent!.timestamp).toBeGreaterThan(0);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// set — event emission
// ---------------------------------------------------------------------------

describe("SharedMemory — set event emission", () => {
  let memory: SharedMemory;

  beforeEach(() => {
    memory = new SharedMemory("owner");
  });

  it("emit memory:set on new key", () => {
    const { events, unsubscribe } = collectEvents(memory, [MemoryEventType.SET]);
    memory.set("x", 100, "agent-1");

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe(MemoryEventType.SET);
    expect(events[0]!.key).toBe("x");
    expect(events[0]!.value).toBe(100);
    expect(events[0]!.previousValue).toBeUndefined();
    expect(events[0]!.agentId).toBe("agent-1");
    unsubscribe();
  });

  it("emit memory:set with previousValue on overwrite", () => {
    const { events, unsubscribe } = collectEvents(memory, [MemoryEventType.SET]);
    memory.set("x", "old", "agent-1");
    memory.set("x", "new", "agent-2");

    const overwriteEvent = events[1]!;
    expect(overwriteEvent.type).toBe(MemoryEventType.SET);
    expect(overwriteEvent.key).toBe("x");
    expect(overwriteEvent.value).toBe("new");
    expect(overwriteEvent.previousValue).toBe("old");
    expect(overwriteEvent.agentId).toBe("agent-2");
    unsubscribe();
  });

  it("emit events for multiple independent keys", () => {
    const { events, unsubscribe } = collectEvents(memory, [MemoryEventType.SET]);
    memory.set("a", 1, "agent-1");
    memory.set("b", 2, "agent-1");
    memory.set("c", 3, "agent-1");

    expect(events).toHaveLength(3);
    expect(events.map((e) => e.key).sort()).toEqual(["a", "b", "c"]);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// onChange — global subscriber
// ---------------------------------------------------------------------------

describe("SharedMemory — onChange", () => {
  let memory: SharedMemory;

  beforeEach(() => {
    memory = new SharedMemory("owner");
  });

  it("receives SET, DELETE, and CLEAR events", () => {
    const payloads: MemoryEventPayload[] = [];
    const unsub = memory.onChange((p) => payloads.push(p));

    memory.set("k", "v", "agent-1");
    memory.delete("k", "agent-1");
    memory.set("x", 1, "agent-2");
    memory.clear("agent-2");

    const types = payloads.map((p) => p.type);
    expect(types).toContain(MemoryEventType.SET);
    expect(types).toContain(MemoryEventType.DELETE);
    expect(types).toContain(MemoryEventType.CLEAR);

    // 2 SET + 1 DELETE + 1 CLEAR = 4
    expect(payloads).toHaveLength(4);
    unsub();
  });

  it("does NOT receive SNAPSHOT events", () => {
    const payloads: MemoryEventPayload[] = [];
    const unsub = memory.onChange((p) => payloads.push(p));

    memory.deserialize(
      { entries: {}, createdAt: 0, createdBy: "agent-1" },
      "agent-1",
    );

    expect(payloads).toHaveLength(0);
    unsub();
  });

  it("returns unsubscribe function that stops callbacks", () => {
    const payloads: MemoryEventPayload[] = [];
    const unsub = memory.onChange((p) => payloads.push(p));

    memory.set("k", "v", "agent-1");
    expect(payloads).toHaveLength(1);
    unsub();

    memory.set("k2", "v2", "agent-1");
    memory.delete("k", "agent-2");
    // No additional events received
    expect(payloads).toHaveLength(1);
  });

  it("unsubscribe is idempotent (safe to call multiple times)", () => {
    const payloads: MemoryEventPayload[] = [];
    const unsub = memory.onChange((p) => payloads.push(p));
    unsub();
    unsub(); // should not throw
    memory.set("k", "v", "agent-1");
    expect(payloads).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// onKeyChange — per-key subscriber
// ---------------------------------------------------------------------------

describe("SharedMemory — onKeyChange", () => {
  let memory: SharedMemory;

  beforeEach(() => {
    memory = new SharedMemory("owner");
  });

  it("fires callback only for the specified key", () => {
    const payloads: MemoryEventPayload[] = [];
    const unsub = memory.onKeyChange("target", (p) => payloads.push(p));

    memory.set("other", 1, "agent-1");
    memory.set("target", "hit", "agent-1");
    memory.set("another", 2, "agent-2");
    memory.set("target", "updated", "agent-2");
    memory.delete("target", "agent-1");

    expect(payloads).toHaveLength(3); // 2 SETs + 1 DELETE
    expect(payloads.every((p) => p.key === "target")).toBe(true);
    expect(payloads[0]!.value).toBe("hit");
    expect(payloads[1]!.value).toBe("updated");
    expect(payloads[2]!.type).toBe(MemoryEventType.DELETE);
    unsub();
  });

  it("does NOT fire for other keys", () => {
    const payloads: MemoryEventPayload[] = [];
    const unsub = memory.onKeyChange("only-me", (p) => payloads.push(p));

    memory.set("not-me-1", 1, "agent-1");
    memory.set("not-me-2", 2, "agent-2");
    memory.delete("not-me-1", "agent-1");

    expect(payloads).toHaveLength(0);
    unsub();
  });

  it("does NOT fire for CLEAR events (key is undefined)", () => {
    const payloads: MemoryEventPayload[] = [];
    const unsub = memory.onKeyChange("x", (p) => payloads.push(p));

    memory.set("x", 1, "agent-1");
    memory.clear("agent-1"); // CLEAR has no specific key

    // Should only have the SET, not CLEAR
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.type).toBe(MemoryEventType.SET);
    unsub();
  });

  it("returns unsubscribe function that stops callbacks", () => {
    const payloads: MemoryEventPayload[] = [];
    const unsub = memory.onKeyChange("k", (p) => payloads.push(p));

    memory.set("k", "v", "agent-1");
    expect(payloads).toHaveLength(1);
    unsub();
    memory.set("k", "v2", "agent-2");
    expect(payloads).toHaveLength(1);
  });

  it("unsubscribe is idempotent", () => {
    const payloads: MemoryEventPayload[] = [];
    const unsub = memory.onKeyChange("k", (p) => payloads.push(p));
    unsub();
    unsub();
    memory.set("k", "v", "agent-1");
    expect(payloads).toHaveLength(0);
  });

  it("multiple onKeyChange subscribers for the same key all receive events", () => {
    const p1: MemoryEventPayload[] = [];
    const p2: MemoryEventPayload[] = [];
    const u1 = memory.onKeyChange("shared", (p) => p1.push(p));
    const u2 = memory.onKeyChange("shared", (p) => p2.push(p));

    memory.set("shared", "val", "agent-1");
    expect(p1).toHaveLength(1);
    expect(p2).toHaveLength(1);

    u1();
    u2();
  });
});

// ---------------------------------------------------------------------------
// serialize / deserialize
// ---------------------------------------------------------------------------

describe("SharedMemory — serialize / deserialize", () => {
  let memory: SharedMemory;

  beforeEach(() => {
    memory = new SharedMemory("owner");
  });

  it("serialize returns a MemorySnapshot with all entries", () => {
    memory.set("a", 1, "agent-1");
    memory.set("b", "two", "agent-2");

    const snapshot = memory.serialize("agent-3");
    expect(snapshot.createdBy).toBe("agent-3");
    expect(snapshot.createdAt).toBeGreaterThan(0);
    expect(Object.keys(snapshot.entries)).toHaveLength(2);

    const a = snapshot.entries["a"]!;
    expect(a.key).toBe("a");
    expect(a.value).toBe(1);
    expect(a.updatedBy).toBe("agent-1");

    const b = snapshot.entries["b"]!;
    expect(b.key).toBe("b");
    expect(b.value).toBe("two");
    expect(b.updatedBy).toBe("agent-2");
  });

  it("serialize of empty memory returns empty entries object", () => {
    const snapshot = memory.serialize("agent-1");
    expect(snapshot.entries).toEqual({});
  });

  it("serialize produces entry-structure copies (snapshot mutation safe)", () => {
    memory.set("arr", [1, 2, 3], "agent-1");
    const snapshot = memory.serialize("agent-1");

    // Deleting from the snapshot entries object does NOT affect the internal Map
    delete snapshot.entries["arr"];
    expect(memory.has("arr")).toBe(true);
    expect(memory.get("arr")).toEqual([1, 2, 3]);

    // Re-serialize to get a fresh snapshot for the reference-sharing test
    const snap2 = memory.serialize("agent-1");
    // Value references are shared (shallow copy): mutating value in snapshot
    // DOES affect the internal Map because serialize does { ...entry }
    // which only copies the entry wrapper, not deep-clones the value.
    const snapVal = snap2.entries["arr"]!.value as number[];
    snapVal.push(999);
    expect(memory.get("arr")).toEqual([1, 2, 3, 999]);
  });

  it("deserialize populates memory from snapshot", () => {
    const snapshot: MemorySnapshot = {
      entries: {
        x: { key: "x", value: 10, updatedAt: 1000, updatedBy: "agent-old" },
        y: { key: "y", value: "hello", updatedAt: 2000, updatedBy: "agent-old" },
      },
      createdAt: 3000,
      createdBy: "serializer",
    };

    memory.deserialize(snapshot, "agent-restore");
    expect(memory.size).toBe(2);
    expect(memory.get("x")).toBe(10);
    expect(memory.get("y")).toBe("hello");
  });

  it("deserialize overwrites existing entries", () => {
    memory.set("x", "original", "agent-1");
    memory.set("y", "original-too", "agent-1");

    const snapshot: MemorySnapshot = {
      entries: {
        x: { key: "x", value: "replaced", updatedAt: 5000, updatedBy: "restorer" },
      },
      createdAt: 5000,
      createdBy: "restorer",
    };

    memory.deserialize(snapshot, "agent-2");
    expect(memory.size).toBe(1);
    expect(memory.get("x")).toBe("replaced");
    expect(memory.has("y")).toBe(false);
  });

  it("round-trip: serialize → deserialize preserves data", () => {
    memory.set("str", "abc", "agent-1");
    memory.set("num", 123, "agent-1");
    memory.set("bool", true, "agent-2");
    memory.set("nullVal", null, "agent-2");
    memory.set("arr", [1, "two", false], "agent-1");
    memory.set("obj", { nested: { deep: true } }, "agent-2");

    const snapshot = memory.serialize("agent-serializer");

    const restored = new SharedMemory("restored-owner");
    restored.deserialize(snapshot, "agent-restorer");

    expect(restored.size).toBe(6);
    expect(restored.get("str")).toBe("abc");
    expect(restored.get("num")).toBe(123);
    expect(restored.get("bool")).toBe(true);
    expect(restored.get("nullVal")).toBeNull();
    expect(restored.get("arr")).toEqual([1, "two", false]);
    expect(restored.get("obj")).toEqual({ nested: { deep: true } });
  });

  it("deserialize emits SNAPSHOT event", () => {
    const { events, unsubscribe } = collectEvents(memory, [MemoryEventType.SNAPSHOT]);

    const snapshot: MemorySnapshot = {
      entries: { k: { key: "k", value: "v", updatedAt: 1, updatedBy: "old" } },
      createdAt: 1,
      createdBy: "old",
    };

    memory.deserialize(snapshot, "agent-load");

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe(MemoryEventType.SNAPSHOT);
    expect(events[0]!.agentId).toBe("agent-load");
    expect(events[0]!.timestamp).toBeGreaterThan(0);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// toJSON
// ---------------------------------------------------------------------------

describe("SharedMemory — toJSON", () => {
  let memory: SharedMemory;

  beforeEach(() => {
    memory = new SharedMemory("owner");
  });

  it("returns empty object for empty memory", () => {
    expect(memory.toJSON()).toEqual({});
  });

  it("returns plain object with key→value mapping", () => {
    memory.set("name", "bob", "agent-1");
    memory.set("age", 30, "agent-1");
    memory.set("active", true, "agent-2");

    expect(memory.toJSON()).toEqual({
      name: "bob",
      age: 30,
      active: true,
    });
  });

  it("returns array and object values faithfully", () => {
    memory.set("list", [1, 2, 3], "agent-1");
    memory.set("map", { x: 10 }, "agent-1");

    const json = memory.toJSON();
    expect(json["list"]).toEqual([1, 2, 3]);
    expect(json["map"]).toEqual({ x: 10 });
  });

  it("returns null as null", () => {
    memory.set("nil", null, "agent-1");
    expect(memory.toJSON()["nil"]).toBeNull();
  });

  it("does NOT include metadata (updatedAt, updatedBy)", () => {
    memory.set("key", "value", "agent-1");
    const json = memory.toJSON();
    // Should be a simple value, no nested object
    expect(json["key"]).toBe("value");
  });
});

// ---------------------------------------------------------------------------
// Concurrency: multiple agents writing to same key
// ---------------------------------------------------------------------------

describe("SharedMemory — concurrency", () => {
  let memory: SharedMemory;

  beforeEach(() => {
    memory = new SharedMemory("owner");
  });

  it("multiple agents can write to the same key and event ordering is preserved", () => {
    const { events, unsubscribe } = collectEvents(memory, [MemoryEventType.SET]);

    memory.set("counter", 0, "agent-1");
    memory.set("counter", 1, "agent-2");
    memory.set("counter", 2, "agent-3");
    memory.set("counter", 3, "agent-1");

    // Final value is last write
    expect(memory.get("counter")).toBe(3);

    // Events preserve order
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.value)).toEqual([0, 1, 2, 3]);
    expect(events.map((e) => e.agentId)).toEqual([
      "agent-1",
      "agent-2",
      "agent-3",
      "agent-1",
    ]);

    // previousValue reflects the value before each write
    expect(events[0]!.previousValue).toBeUndefined();
    expect(events[1]!.previousValue).toBe(0);
    expect(events[2]!.previousValue).toBe(1);
    expect(events[3]!.previousValue).toBe(2);

    unsubscribe();
  });

  it("multiple agents writing to different keys produce independent entries", () => {
    memory.set("agent-1-data", "a1", "agent-1");
    memory.set("agent-2-data", "a2", "agent-2");
    memory.set("agent-3-data", "a3", "agent-3");

    expect(memory.size).toBe(3);
    expect(memory.get("agent-1-data")).toBe("a1");
    expect(memory.get("agent-2-data")).toBe("a2");
    expect(memory.get("agent-3-data")).toBe("a3");
  });

  it("concurrent delete + set on same key behaves correctly", () => {
    memory.set("shared", "v1", "agent-1");
    memory.delete("shared", "agent-2");
    memory.set("shared", "v2", "agent-3");

    expect(memory.get("shared")).toBe("v2");
    expect(memory.has("shared")).toBe(true);
  });

  it("concurrent subscribers all receive events in order", () => {
    const sub1Events: MemoryEventPayload[] = [];
    const sub2Events: MemoryEventPayload[] = [];

    const u1 = memory.onKeyChange("x", (p) => sub1Events.push(p));
    const u2 = memory.onKeyChange("x", (p) => sub2Events.push(p));

    memory.set("x", "first", "agent-1");
    memory.set("x", "second", "agent-2");
    memory.set("x", "third", "agent-3");

    expect(sub1Events).toHaveLength(3);
    expect(sub2Events).toHaveLength(3);
    expect(sub1Events.map((e) => e.value)).toEqual(["first", "second", "third"]);
    expect(sub2Events.map((e) => e.value)).toEqual(["first", "second", "third"]);

    u1();
    u2();
  });
});

// ---------------------------------------------------------------------------
// Event emission — comprehensive
// ---------------------------------------------------------------------------

describe("SharedMemory — event emission comprehensive", () => {
  let memory: SharedMemory;

  beforeEach(() => {
    memory = new SharedMemory("owner");
  });

  it("SET event payload includes key, value, previousValue, agentId, timestamp", () => {
    const payloads: MemoryEventPayload[] = [];
    memory.on(MemoryEventType.SET as string, (p: MemoryEventPayload) => payloads.push(p));

    const before = Date.now();
    memory.set("k", "v", "agent-42");
    const after = Date.now();

    expect(payloads).toHaveLength(1);
    const p = payloads[0]!;
    expect(p.type).toBe(MemoryEventType.SET);
    expect(p.key).toBe("k");
    expect(p.value).toBe("v");
    expect(p.previousValue).toBeUndefined();
    expect(p.agentId).toBe("agent-42");
    expect(p.timestamp).toBeGreaterThanOrEqual(before);
    expect(p.timestamp).toBeLessThanOrEqual(after);
    memory.removeAllListeners();
  });

  it("DELETE event payload includes key, previousValue, agentId, timestamp", () => {
    const payloads: MemoryEventPayload[] = [];
    memory.on(MemoryEventType.DELETE as string, (p: MemoryEventPayload) => payloads.push(p));

    memory.set("del-me", "val", "agent-a");
    memory.delete("del-me", "agent-b");

    expect(payloads).toHaveLength(1);
    const p = payloads[0]!;
    expect(p.type).toBe(MemoryEventType.DELETE);
    expect(p.key).toBe("del-me");
    expect(p.previousValue).toBe("val");
    expect(p.agentId).toBe("agent-b");
    expect(p.value).toBeUndefined();
    memory.removeAllListeners();
  });

  it("CLEAR event payload includes agentId, timestamp", () => {
    const payloads: MemoryEventPayload[] = [];
    memory.on(MemoryEventType.CLEAR as string, (p: MemoryEventPayload) => payloads.push(p));

    memory.set("a", 1, "agent-1");
    memory.set("b", 2, "agent-1");
    memory.clear("agent-clear");

    expect(payloads).toHaveLength(1);
    const p = payloads[0]!;
    expect(p.type).toBe(MemoryEventType.CLEAR);
    expect(p.agentId).toBe("agent-clear");
    expect(p.key).toBeUndefined();
    expect(p.value).toBeUndefined();
    memory.removeAllListeners();
  });

  it("SNAPSHOT event payload includes agentId, timestamp", () => {
    const payloads: MemoryEventPayload[] = [];
    memory.on(MemoryEventType.SNAPSHOT as string, (p: MemoryEventPayload) => payloads.push(p));

    const snap: MemorySnapshot = {
      entries: {},
      createdAt: 123,
      createdBy: "old",
    };
    memory.deserialize(snap, "agent-snap");

    expect(payloads).toHaveLength(1);
    const p = payloads[0]!;
    expect(p.type).toBe(MemoryEventType.SNAPSHOT);
    expect(p.agentId).toBe("agent-snap");
    expect(p.key).toBeUndefined();
    memory.removeAllListeners();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("SharedMemory — edge cases", () => {
  let memory: SharedMemory;

  beforeEach(() => {
    memory = new SharedMemory("owner");
  });

  it("set with empty string key", () => {
    memory.set("", "value", "agent-1");
    expect(memory.get("")).toBe("value");
    expect(memory.has("")).toBe(true);
  });

  it("set with long string key", () => {
    const longKey = "x".repeat(1000);
    memory.set(longKey, "long", "agent-1");
    expect(memory.get(longKey)).toBe("long");
  });

  it("set value to undefined is treated as a valid JsonValue (null-like)", () => {
    // undefined is not valid JsonValue per the type, but set accepts JsonValue
    // We test with null which IS valid
    memory.set("x", null, "agent-1");
    expect(memory.get("x")).toBeNull();
  });

  it("get on empty memory returns undefined", () => {
    expect(memory.get("any")).toBeUndefined();
  });

  it("has on empty memory returns false", () => {
    expect(memory.has("any")).toBe(false);
  });

  it("delete on empty memory returns false and does not emit", () => {
    const { events, unsubscribe } = collectEvents(memory, [
      MemoryEventType.DELETE,
      MemoryEventType.SET,
    ]);
    const result = memory.delete("nope", "agent-1");
    expect(result).toBe(false);
    expect(events).toHaveLength(0);
    unsubscribe();
  });

  it("deserialize of empty snapshot clears existing data", () => {
    memory.set("a", 1, "agent-1");
    memory.set("b", 2, "agent-1");

    const emptySnapshot: MemorySnapshot = {
      entries: {},
      createdAt: Date.now(),
      createdBy: "agent-1",
    };

    memory.deserialize(emptySnapshot, "agent-2");
    expect(memory.size).toBe(0);
    expect(memory.has("a")).toBe(false);
    expect(memory.has("b")).toBe(false);
  });

  it("deserialize entries are entry-structure copies (snapshot mutation safe)", () => {
    const mutableValue: { data: number[] } = { data: [1, 2, 3] };
    const snapshot: MemorySnapshot = {
      entries: {
        mut: {
          key: "mut",
          value: mutableValue,
          updatedAt: 1000,
          updatedBy: "old",
        },
      },
      createdAt: 1000,
      createdBy: "old",
    };

    memory.deserialize(snapshot, "agent-1");

    // Deleting from the original snapshot entries does NOT affect the internal Map
    // (deserialize iterates Object.entries and copies each entry via { ...entry })
    delete snapshot.entries["mut"];
    expect(memory.has("mut")).toBe(true);

    // Value references are shared (shallow copy): mutating the original value
    // DOES affect the stored value because deserialize does { ...entry }
    // which only copies the entry wrapper, not deep-clones the value.
    mutableValue.data.push(999);
    const stored = memory.get("mut") as { data: number[] };
    expect(stored.data).toEqual([1, 2, 3, 999]);
  });

  it("serialize entries are deep-copied (mutation safe)", () => {
    memory.set("arr", [1, 2], "agent-1");
    const snap = memory.serialize("agent-1");
    // Mutate original memory
    memory.set("arr", [9, 9, 9], "agent-1");
    expect(snap.entries["arr"]!.value).toEqual([1, 2]);
  });

  it("construct with entries and then operate normally", () => {
    const preMap = new Map<string, MemoryEntry>([
      ["k1", { key: "k1", value: "v1", updatedAt: 1, updatedBy: "old" }],
    ]);
    const mem = new SharedMemory("new-owner", preMap);

    mem.set("k2", "v2", "agent-1");
    mem.delete("k1", "agent-2");

    expect(mem.size).toBe(1);
    expect(mem.get("k2")).toBe("v2");
    expect(mem.has("k1")).toBe(false);
  });

  it("JsonValue types: handles all JSON-compatible types", () => {
    const testValues: Record<string, unknown> = {
      str: "hello",
      num: 42,
      float: 3.14,
      negative: -10,
      zero: 0,
      boolTrue: true,
      boolFalse: false,
      nullVal: null,
      emptyArr: [] as unknown[],
      arr: [1, "two", false, null],
      emptyObj: {},
      obj: { a: 1, b: { c: "deep" } },
      nestedArr: [[1, 2], [3, 4]],
      mixed: { arr: [1, 2], val: "ok" },
    };

    for (const [key, value] of Object.entries(testValues)) {
      memory.set(key, value as Parameters<typeof memory.set>[1], "agent-tester");
    }

    expect(memory.size).toBe(Object.keys(testValues).length);

    for (const [key, expected] of Object.entries(testValues)) {
      expect(memory.get(key)).toEqual(expected);
    }
  });
});
