import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CONFIG_DIR  = path.join(os.homedir(), ".config", "multi-agent-tui");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export type PaletteName = "paper" | "green" | "amber";

export interface ProviderConfig {
  provider: "anthropic" | "openai";
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
}

/**
 * Return the max_tokens budget for a given agent role and depth.
 * PM (leader, depth=0) is conservative; TL (depth=1) larger; worker largest.
 * Callers pass providerCfg.maxTokens first — this is the fallback when unset.
 */
export function resolveMaxTokens(role: string, depth?: number): number {
  if (role === "Secretary") return 1024;
  if (role === "Worker")    return 8192;
  if (role === "Leader") {
    if (depth === 0) return 2048; // PM: conservative budget
    if (depth === 1) return 4096; // TL: more room for planning
    return 8192;                  // deep leaders or unknown depth
  }
  return 8192; // unknown role: safe default
}

export const PROVIDER_PRESETS: Record<string, Omit<ProviderConfig, "model" | "apiKey">> = {
  anthropic: { provider: "anthropic" },
  openai:    { provider: "openai", baseUrl: "https://api.openai.com" },
  deepseek:  { provider: "openai", baseUrl: "https://api.deepseek.com" },
  ollama:    { provider: "openai", baseUrl: "http://localhost:11434" },
  dashscope: { provider: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
};

interface Config {
  palette: PaletteName;
  layout: "v1" | "v3";
  agents: {
    leader: ProviderConfig;
    secretary: ProviderConfig;
    worker: ProviderConfig;
  };
}

const DEFAULT_PROVIDER: ProviderConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  apiKey: "",
};

const DEFAULT: Config = {
  palette: "paper",
  layout: "v1",
  agents: {
    leader:    { ...DEFAULT_PROVIDER },
    secretary: { ...DEFAULT_PROVIDER },
    worker:    { ...DEFAULT_PROVIDER },
  },
};

export function loadConfig(): Config {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<Config>;
    return { ...DEFAULT, ...parsed };
  } catch {
    return { ...DEFAULT };
  }
}

export function savePalette(name: PaletteName): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const existing = loadConfig();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...existing, palette: name }, null, 2));
  } catch { /* 静默失败，不影响 UI */ }
}

export function saveLayout(l: "v1" | "v3"): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const existing = loadConfig();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...existing, layout: l }, null, 2));
  } catch { /* 静默失败 */ }
}

export function saveAgentConfig(role: "leader" | "secretary" | "worker", cfg: ProviderConfig): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const existing = loadConfig();
    existing.agents[role] = cfg;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2));
  } catch { /* 静默失败 */ }
}
