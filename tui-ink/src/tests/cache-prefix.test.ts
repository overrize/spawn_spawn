import { describe, it } from "node:test";
import { strict as assert } from "node:assert/strict";
import { serializeCachePrefix } from "../cache/CachePrefixManager.js";
import type { CacheSafeParams } from "../cache/CachePrefixManager.js";

describe("serializeCachePrefix", () => {
  const baseParams: CacheSafeParams = {
    systemPrompt: "You are a helpful assistant.",
    userContext: "User has requested a task.",
    systemContext: "System is running in test mode.",
    toolPool: JSON.stringify([
      { name: "read", description: "Read a file" },
      { name: "write", description: "Write a file" },
    ]),
    conversationHistoryPrefix: "Previous messages...",
  };

  it("should produce identical output for identical input (same reference)", () => {
    const a = serializeCachePrefix(baseParams);
    const b = serializeCachePrefix(baseParams);
    assert.equal(a, b);
  });

  it("should produce identical output for deep-equal but different reference input", () => {
    const toolPoolStr = JSON.stringify([
      { name: "read", description: "Read a file" },
      { name: "write", description: "Write a file" },
    ]);
    const params1: CacheSafeParams = {
      systemPrompt: "You are a helpful assistant.",
      userContext: "User has requested a task.",
      systemContext: "System is running in test mode.",
      toolPool: toolPoolStr,
      conversationHistoryPrefix: "Previous messages...",
    };
    const params2: CacheSafeParams = { ...params1 };
    assert.equal(serializeCachePrefix(params1), serializeCachePrefix(params2));
  });

  it("should produce different output for different systemPrompt", () => {
    const a = serializeCachePrefix({ ...baseParams, systemPrompt: "You are a helpful assistant." });
    const b = serializeCachePrefix({ ...baseParams, systemPrompt: "You are a different assistant." });
    assert.notEqual(a, b);
  });

  it("should produce different output for different toolPool order", () => {
    const a = serializeCachePrefix({
      ...baseParams,
      toolPool: JSON.stringify([
        { name: "read", description: "Read a file" },
        { name: "write", description: "Write a file" },
      ]),
    });
    const b = serializeCachePrefix({
      ...baseParams,
      toolPool: JSON.stringify([
        { name: "write", description: "Write a file" },
        { name: "read", description: "Read a file" },
      ]),
    });
    assert.notEqual(a, b);
  });

  it("should produce consistent output for empty strings", () => {
    const emptyParams: CacheSafeParams = {
      systemPrompt: "",
      userContext: "",
      systemContext: "",
      toolPool: "",
      conversationHistoryPrefix: "",
    };
    const a = serializeCachePrefix(emptyParams);
    const b = serializeCachePrefix(emptyParams);
    assert.equal(a, b);
    // Verify structure: should contain 4 separators (5 fields)
    const SEP = "\n\n--- CACHE_PREFIX_SEPARATOR ---\n\n";
    assert.equal(a.split(SEP).length, 5);
  });
});
