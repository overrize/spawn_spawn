import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getAgentProviderConfig,
  isAgentConfigRole,
  PROVIDER_PRESETS,
  resolveModelConfigInput,
} from "../config.js";

describe("provider presets", () => {
  it("supports Kimi OpenAI-compatible endpoints", () => {
    assert.deepEqual(PROVIDER_PRESETS.kimi, {
      provider: "openai",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k2.6",
    });
    assert.deepEqual(PROVIDER_PRESETS["kimi-k3"], {
      provider: "openai",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k3",
    });
    assert.deepEqual(PROVIDER_PRESETS["kimi-cn"], {
      provider: "openai",
      baseUrl: "https://api.moonshot.cn/v1",
    });
  });

  it("resolves preset defaults for model registration", () => {
    assert.deepEqual(resolveModelConfigInput("kimi", "moonshot-key"), {
      provider: "openai",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k2.6",
      apiKey: "moonshot-key",
    });
  });

  it("allows explicit model overrides", () => {
    assert.deepEqual(resolveModelConfigInput("kimi", "kimi-k3-preview", "moonshot-key"), {
      provider: "openai",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k3-preview",
      apiKey: "moonshot-key",
    });
  });

  it("resolves role model references through the model registry", () => {
    const cfg = {
      palette: "paper" as const,
      layout: "v1" as const,
      models: {
        kimi: {
          provider: "openai" as const,
          baseUrl: "https://api.moonshot.cn/v1",
          model: "kimi-k2.6",
          apiKey: "moonshot-key",
        },
      },
      agents: {
        leader: { model: "kimi" },
        worker: { model: "kimi", maxTokens: 4096 },
        secretary: { model: "kimi" },
      },
      web: {
        search: { enabled: true, provider: "serper" },
        providers: {},
      },
    };
    assert.deepEqual(getAgentProviderConfig(cfg, "worker"), {
      provider: "openai",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k2.6",
      apiKey: "moonshot-key",
      maxTokens: 4096,
    });
  });

  it("defines web search defaults for config-backed providers", () => {
    const cfg = {
      palette: "paper" as const,
      layout: "v1" as const,
      models: {},
      agents: {
        leader: { model: "claude-sonnet-4-5" },
        worker: { model: "claude-sonnet-4-5" },
        secretary: { model: "claude-sonnet-4-5" },
      },
      web: {
        search: { enabled: true, provider: "serper", maxResults: 5, timeoutSeconds: 10 },
        providers: {
          serper: { type: "serper" as const, apiKey: "key", hl: "zh-cn" },
        },
      },
    };
    assert.equal(cfg.web.search.provider, "serper");
    assert.equal(cfg.web.providers.serper.hl, "zh-cn");
  });

  it("validates configurable agent roles", () => {
    assert.equal(isAgentConfigRole("leader"), true);
    assert.equal(isAgentConfigRole("worker"), true);
    assert.equal(isAgentConfigRole("secretary"), true);
    assert.equal(isAgentConfigRole("pm"), false);
  });
});
