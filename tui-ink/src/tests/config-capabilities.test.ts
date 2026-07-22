/**
 * M2-1 · provider capabilities → rail selection.
 * Anthropic + first-party OpenAI → native rail; other OpenAI-compatible
 * endpoints default to text rail; explicit config overrides.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveCapabilities, selectRail } from "../config.js";

describe("M2-1 resolveCapabilities / selectRail", () => {
  it("anthropic → native rail", () => {
    assert.deepEqual(resolveCapabilities({ provider: "anthropic" }), { nativeFC: true, structuredOutput: true });
    assert.equal(selectRail({ provider: "anthropic" }), "native");
  });

  it("first-party OpenAI → native rail", () => {
    assert.equal(selectRail({ provider: "openai", baseUrl: "https://api.openai.com" }), "native");
    assert.equal(selectRail({ provider: "openai" }), "native"); // default baseUrl is api.openai.com
  });

  it("OpenAI-compatible endpoints → text rail (native reliability varies)", () => {
    for (const base of [
      "https://api.moonshot.cn/v1",       // Kimi
      "https://api.deepseek.com",         // DeepSeek
      "http://localhost:11434",           // ollama
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    ]) {
      assert.equal(selectRail({ provider: "openai", baseUrl: base }), "text", base);
    }
  });

  it("explicit capabilities override the inference", () => {
    assert.equal(
      selectRail({ provider: "openai", baseUrl: "https://api.moonshot.cn/v1", capabilities: { nativeFC: true, structuredOutput: true } }),
      "native",
    );
    assert.equal(
      selectRail({ provider: "anthropic", capabilities: { nativeFC: false, structuredOutput: false } }),
      "text",
    );
  });

  it("does not false-match api.openai.com.evil.example", () => {
    assert.equal(selectRail({ provider: "openai", baseUrl: "https://api.openai.com.evil.example/v1" }), "text");
  });
});
