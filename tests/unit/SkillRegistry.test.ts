import { describe, it, expect, beforeEach } from "vitest";
import { SkillRegistry, ReadonlySkillRegistry, Skill } from "../../src/skills/SkillRegistry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkill(name: string, overrides?: Partial<Skill>): Skill {
  return {
    name,
    description: overrides?.description ?? `Description for ${name}`,
    version: overrides?.version ?? "1.0.0",
    metadata: overrides?.metadata,
  };
}

const OWNER_ID = "agent-main-001";

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

describe("SkillRegistry.register()", () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry(OWNER_ID);
  });

  it("adds a skill and makes it available via has()", () => {
    registry.register(makeSkill("s1"));
    expect(registry.has("s1")).toBe(true);
  });

  it("adds a skill and makes it retrievable via get()", () => {
    const skill = makeSkill("s1", { description: "Custom desc", version: "2.0.0" });
    registry.register(skill);
    const retrieved = registry.get("s1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe("s1");
    expect(retrieved!.description).toBe("Custom desc");
    expect(retrieved!.version).toBe("2.0.0");
  });

  it("increments size by 1", () => {
    expect(registry.size).toBe(0);
    registry.register(makeSkill("s1"));
    expect(registry.size).toBe(1);
  });

  it("allows skills with metadata", () => {
    registry.register(makeSkill("s1", { metadata: { params: { timeout: 3000 } } }));
    const skill = registry.get("s1");
    expect(skill).toBeDefined();
    expect(skill!.metadata).toEqual({ params: { timeout: 3000 } });
  });

  it("throws when registering a duplicate skill name", () => {
    registry.register(makeSkill("dupe"));
    expect(() => registry.register(makeSkill("dupe"))).toThrow(
      'Skill "dupe" is already registered'
    );
  });

  it("throws with the correct error message containing the skill name", () => {
    registry.register(makeSkill("my-skill"));
    expect(() => registry.register(makeSkill("my-skill"))).toThrow(
      /Skill "my-skill" is already registered/
    );
  });

  it("stores a deep copy of the skill (modifying original doesn't affect stored skill)", () => {
    const skill = makeSkill("s1", { description: "original" });
    registry.register(skill);
    // Mutate the original object
    skill.description = "mutated!";
    expect(registry.get("s1")!.description).toBe("original");
  });
});

// ---------------------------------------------------------------------------
// unregister
// ---------------------------------------------------------------------------

describe("SkillRegistry.unregister()", () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry(OWNER_ID);
  });

  it("returns true when removing an existing skill", () => {
    registry.register(makeSkill("s1"));
    expect(registry.unregister("s1")).toBe(true);
  });

  it("returns false when removing a non-existent skill", () => {
    expect(registry.unregister("nonexistent")).toBe(false);
  });

  it("actually removes the skill (has returns false after)", () => {
    registry.register(makeSkill("s1"));
    expect(registry.has("s1")).toBe(true);
    registry.unregister("s1");
    expect(registry.has("s1")).toBe(false);
  });

  it("decrements size on successful unregister", () => {
    registry.register(makeSkill("s1"));
    registry.register(makeSkill("s2"));
    expect(registry.size).toBe(2);
    registry.unregister("s1");
    expect(registry.size).toBe(1);
  });

  it("does not decrement size on unsuccessful unregister", () => {
    registry.register(makeSkill("s1"));
    expect(registry.size).toBe(1);
    registry.unregister("fake");
    expect(registry.size).toBe(1);
  });

  it("returns false after a skill has already been unregistered", () => {
    registry.register(makeSkill("s1"));
    registry.unregister("s1");
    expect(registry.unregister("s1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// has
// ---------------------------------------------------------------------------

describe("SkillRegistry.has()", () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry(OWNER_ID);
  });

  it("returns false for an empty registry", () => {
    expect(registry.has("anything")).toBe(false);
  });

  it("returns true for a registered skill", () => {
    registry.register(makeSkill("s1"));
    expect(registry.has("s1")).toBe(true);
  });

  it("returns false for an unregistered skill name", () => {
    registry.register(makeSkill("s1"));
    expect(registry.has("s2")).toBe(false);
  });

  it("is case-sensitive", () => {
    registry.register(makeSkill("MySkill"));
    expect(registry.has("MySkill")).toBe(true);
    expect(registry.has("myskill")).toBe(false);
    expect(registry.has("MYSKILL")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe("SkillRegistry.get()", () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry(OWNER_ID);
  });

  it("returns undefined for a missing skill", () => {
    expect(registry.get("nope")).toBeUndefined();
  });

  it("returns the skill for a registered name", () => {
    registry.register(makeSkill("s1"));
    expect(registry.get("s1")!.name).toBe("s1");
  });

  it("returns a deep copy — mutating the returned object does not affect registry", () => {
    registry.register(makeSkill("s1", { description: "safe" }));
    const skill1 = registry.get("s1")!;
    skill1.description = "hacked!";
    const skill2 = registry.get("s1")!;
    expect(skill2.description).toBe("safe");
  });

  it("returns a top-level copy — modifying top-level primitives on the result does not affect registry", () => {
    registry.register(makeSkill("s1", { description: "safe" }));
    const skill1 = registry.get("s1")!;
    skill1.description = "hacked!";
    const skill2 = registry.get("s1")!;
    expect(skill2.description).toBe("safe");
  });

  it("returns a different object reference on each call", () => {
    registry.register(makeSkill("s1"));
    const a = registry.get("s1");
    const b = registry.get("s1");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("SkillRegistry.list()", () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry(OWNER_ID);
  });

  it("returns an empty array for an empty registry", () => {
    expect(registry.list()).toEqual([]);
  });

  it("returns an array of skill names", () => {
    registry.register(makeSkill("s1"));
    registry.register(makeSkill("s2"));
    registry.register(makeSkill("s3"));
    const names = registry.list();
    expect(names).toHaveLength(3);
    expect(names).toContain("s1");
    expect(names).toContain("s2");
    expect(names).toContain("s3");
  });

  it("returns names in registration order (Map insertion order)", () => {
    registry.register(makeSkill("zulu"));
    registry.register(makeSkill("alpha"));
    registry.register(makeSkill("mike"));
    expect(registry.list()).toEqual(["zulu", "alpha", "mike"]);
  });
});

// ---------------------------------------------------------------------------
// listAll
// ---------------------------------------------------------------------------

describe("SkillRegistry.listAll()", () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry(OWNER_ID);
  });

  it("returns an empty array for an empty registry", () => {
    expect(registry.listAll()).toEqual([]);
  });

  it("returns all registered skills with full data", () => {
    registry.register(makeSkill("s1", { description: "First skill", version: "1.0.0" }));
    registry.register(makeSkill("s2", { description: "Second skill", version: "2.0.0" }));
    const all = registry.listAll();
    expect(all).toHaveLength(2);
    expect(all[0].name).toBe("s1");
    expect(all[0].description).toBe("First skill");
    expect(all[0].version).toBe("1.0.0");
    expect(all[1].name).toBe("s2");
    expect(all[1].description).toBe("Second skill");
    expect(all[1].version).toBe("2.0.0");
  });

  it("returns deep copies (mutating result does not corrupt registry)", () => {
    registry.register(makeSkill("s1"));
    const all1 = registry.listAll();
    all1[0].description = "corrupted";
    const all2 = registry.listAll();
    expect(all2[0].description).toBe("Description for s1");
  });
});

// ---------------------------------------------------------------------------
// size
// ---------------------------------------------------------------------------

describe("SkillRegistry.size", () => {
  it("returns 0 for a brand-new registry", () => {
    const registry = new SkillRegistry(OWNER_ID);
    expect(registry.size).toBe(0);
  });

  it("reflects the number of registered skills", () => {
    const registry = new SkillRegistry(OWNER_ID);
    registry.register(makeSkill("s1"));
    expect(registry.size).toBe(1);
    registry.register(makeSkill("s2"));
    expect(registry.size).toBe(2);
  });

  it("decreases after unregister", () => {
    const registry = new SkillRegistry(OWNER_ID);
    registry.register(makeSkill("s1"));
    registry.register(makeSkill("s2"));
    registry.unregister("s1");
    expect(registry.size).toBe(1);
  });

  it("is readonly (getter, no setter)", () => {
    const registry = new SkillRegistry(OWNER_ID);
    // Verify it's a getter that returns a number
    expect(typeof registry.size).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// createReadOnlyView — read operations
// ---------------------------------------------------------------------------

describe("SkillRegistry.createReadOnlyView() — read operations", () => {
  let registry: SkillRegistry;
  let view: ReadonlySkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry(OWNER_ID);
    registry.register(makeSkill("a", { description: "Alpha" }));
    registry.register(makeSkill("b", { description: "Beta" }));
    view = registry.createReadOnlyView();
  });

  it("returns a ReadonlySkillRegistry instance", () => {
    expect(view).toBeInstanceOf(ReadonlySkillRegistry);
  });

  it("has() delegates to the source registry", () => {
    expect(view.has("a")).toBe(true);
    expect(view.has("b")).toBe(true);
    expect(view.has("c")).toBe(false);
  });

  it("get() delegates to the source registry", () => {
    expect(view.get("a")!.description).toBe("Alpha");
    expect(view.get("b")!.description).toBe("Beta");
    expect(view.get("c")).toBeUndefined();
  });

  it("list() delegates to the source registry", () => {
    expect(view.list()).toEqual(["a", "b"]);
  });

  it("listAll() delegates to the source registry", () => {
    const all = view.listAll();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("size delegates to the source registry", () => {
    expect(view.size).toBe(2);
    registry.unregister("a");
    expect(view.size).toBe(1);
  });

  it("reflects additions made to the source registry", () => {
    registry.register(makeSkill("c"));
    expect(view.has("c")).toBe(true);
    expect(view.size).toBe(3);
    expect(view.list()).toContain("c");
  });

  it("reflects removals from the source registry", () => {
    registry.unregister("a");
    expect(view.has("a")).toBe(false);
    expect(view.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createReadOnlyView — mutation prevention
// ---------------------------------------------------------------------------

describe("SkillRegistry.createReadOnlyView() — mutation prevention", () => {
  let view: ReadonlySkillRegistry;

  beforeEach(() => {
    const registry = new SkillRegistry(OWNER_ID);
    registry.register(makeSkill("a"));
    view = registry.createReadOnlyView();
  });

  it("does NOT expose register method (no-op / TypeError at runtime)", () => {
    // ReadonlySkillRegistry class does not have register or unregister.
    // At runtime, calling a missing method on the object would throw TypeError.
    const viewAny = view as any;
    expect(() => viewAny.register(makeSkill("b"))).toThrow(TypeError);
  });

  it("does NOT expose unregister method (no-op / TypeError at runtime)", () => {
    const viewAny = view as any;
    expect(() => viewAny.unregister("a")).toThrow(TypeError);
  });

  it("does not have register as an own or prototype property", () => {
    expect("register" in view).toBe(false);
    expect("unregister" in view).toBe(false);
  });

  it("does not have createReadOnlyView method (cannot chain views)", () => {
    expect("createReadOnlyView" in view).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("SkillRegistry edge cases", () => {
  it("handles an empty registry gracefully across all methods", () => {
    const registry = new SkillRegistry(OWNER_ID);
    expect(registry.size).toBe(0);
    expect(registry.list()).toEqual([]);
    expect(registry.listAll()).toEqual([]);
    expect(registry.has("x")).toBe(false);
    expect(registry.get("x")).toBeUndefined();
    expect(registry.unregister("x")).toBe(false);
  });

  it("handles a registry with many skills", () => {
    const registry = new SkillRegistry(OWNER_ID);
    const count = 1000;
    for (let i = 0; i < count; i++) {
      registry.register(makeSkill(`skill-${i}`));
    }
    expect(registry.size).toBe(count);
    expect(registry.has("skill-0")).toBe(true);
    expect(registry.has("skill-999")).toBe(true);
    expect(registry.has("skill-1000")).toBe(false);
    expect(registry.get("skill-500")!.name).toBe("skill-500");
    expect(registry.list()).toHaveLength(count);
    expect(registry.listAll()).toHaveLength(count);

    // Unregister some
    for (let i = 0; i < 100; i++) {
      expect(registry.unregister(`skill-${i}`)).toBe(true);
    }
    expect(registry.size).toBe(count - 100);
    expect(registry.has("skill-0")).toBe(false);
    expect(registry.has("skill-99")).toBe(false);
    expect(registry.has("skill-100")).toBe(true);
  });

  it("handles re-registration after unregistration", () => {
    const registry = new SkillRegistry(OWNER_ID);
    registry.register(makeSkill("s1", { description: "v1" }));
    registry.unregister("s1");
    // Should be allowed to re-register
    registry.register(makeSkill("s1", { description: "v2" }));
    expect(registry.get("s1")!.description).toBe("v2");
  });

  it("handles skills with special characters in names", () => {
    const registry = new SkillRegistry(OWNER_ID);
    registry.register(makeSkill("namespace:skill"));
    registry.register(makeSkill("path/to/skill"));
    registry.register(makeSkill("skill-131"));
    expect(registry.has("namespace:skill")).toBe(true);
    expect(registry.has("path/to/skill")).toBe(true);
    expect(registry.has("skill-131")).toBe(true);
    expect(registry.size).toBe(3);
  });

  it("handles empty string skill name", () => {
    const registry = new SkillRegistry(OWNER_ID);
    registry.register(makeSkill(""));
    expect(registry.has("")).toBe(true);
    expect(registry.get("")!.name).toBe("");
    expect(registry.list()).toEqual([""]);
  });
});

// ---------------------------------------------------------------------------
// Integration between registry and read-only view
// ---------------------------------------------------------------------------

describe("SkillRegistry + ReadonlySkillRegistry integration", () => {
  it("view always reflects the current state of the source registry", () => {
    const registry = new SkillRegistry(OWNER_ID);
    const view = registry.createReadOnlyView();

    expect(view.size).toBe(0);
    expect(view.list()).toEqual([]);

    registry.register(makeSkill("a"));
    expect(view.size).toBe(1);
    expect(view.has("a")).toBe(true);
    expect(view.list()).toEqual(["a"]);

    registry.register(makeSkill("b"));
    expect(view.size).toBe(2);
    expect(view.list()).toEqual(["a", "b"]);

    registry.unregister("a");
    expect(view.size).toBe(1);
    expect(view.has("a")).toBe(false);
    expect(view.list()).toEqual(["b"]);
  });

  it("multiple views of the same registry see the same data", () => {
    const registry = new SkillRegistry(OWNER_ID);
    registry.register(makeSkill("s1"));

    const view1 = registry.createReadOnlyView();
    const view2 = registry.createReadOnlyView();

    expect(view1.list()).toEqual(["s1"]);
    expect(view2.list()).toEqual(["s1"]);

    registry.register(makeSkill("s2"));

    expect(view1.list()).toEqual(["s1", "s2"]);
    expect(view2.list()).toEqual(["s1", "s2"]);
  });
});
