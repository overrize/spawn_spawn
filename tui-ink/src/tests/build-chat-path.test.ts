import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildChatPath } from "../adapters/httpAgent.js";

describe("buildChatPath: baseUrl → /v1/chat/completions path", () => {

  it("bare hostname (OpenAI, DeepSeek) → /v1/chat/completions", () => {
    assert.equal(buildChatPath("https://api.openai.com"),   "/v1/chat/completions");
    assert.equal(buildChatPath("https://api.deepseek.com"), "/v1/chat/completions");
    assert.equal(buildChatPath("http://localhost:11434"),   "/v1/chat/completions");
  });

  it("trailing slash on bare hostname is tolerated", () => {
    assert.equal(buildChatPath("https://api.openai.com/"), "/v1/chat/completions");
  });

  it("baseUrl already ends with /v1 (DashScope) → no double /v1", () => {
    assert.equal(
      buildChatPath("https://dashscope.aliyuncs.com/compatible-mode/v1"),
      "/compatible-mode/v1/chat/completions",
    );
  });

  it("DashScope with trailing slash → same result", () => {
    assert.equal(
      buildChatPath("https://dashscope.aliyuncs.com/compatible-mode/v1/"),
      "/compatible-mode/v1/chat/completions",
    );
  });

  it("arbitrary prefix without /v1 → prefix + /v1/chat/completions", () => {
    assert.equal(buildChatPath("http://proxy.internal/api"), "/api/v1/chat/completions");
  });

  it("arbitrary prefix already ending with /v1 → no duplicate", () => {
    assert.equal(buildChatPath("http://localhost:8080/api/v1"), "/api/v1/chat/completions");
  });
});
