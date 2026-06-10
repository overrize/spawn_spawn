/**
 * Manual eval script: Stage 0 fast-answer gate.
 *
 * Tests whether the PM (with full system prompt) correctly short-circuits
 * simple Q&A via Stage 0 vs spawning for complex tasks.
 *
 * Usage:
 *   npx tsx src/tests/scripts/eval-stage0.ts
 *
 * Supported keys (in priority order):
 *   ANTHROPIC_API_KEY  → anthropic provider, claude-haiku-4-5-20251001
 *   OPENAI_API_KEY     → openai provider,    gpt-4o-mini
 *   DASHSCOPE_API_KEY  → openai provider,    qwen-plus (dashscope compat endpoint)
 */

import { HttpConvAgent } from "../../adapters/httpAgent.js";
import type { TuiEvent } from "../../protocol.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, "../../../../prompts");

// ── Build PM system prompt (same logic as index.tsx buildSystemPrompt) ────────
function loadPmSystemPrompt(): string {
  const base = fs.existsSync(path.join(PROMPTS_DIR, "_base.md"))
    ? fs.readFileSync(path.join(PROMPTS_DIR, "_base.md"), "utf8")
    : "";
  const pm = fs.existsSync(path.join(PROMPTS_DIR, "pm.md"))
    ? fs.readFileSync(path.join(PROMPTS_DIR, "pm.md"), "utf8")
    : "";
  return `${base}\n\n---\n\n${pm}`;
}

// ── Provider selection ────────────────────────────────────────────────────────
function resolveProvider(): { provider: "anthropic" | "openai"; model: string; apiKey: string; baseUrl?: string } {
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", model: "claude-haiku-4-5-20251001", apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (process.env.OPENAI_API_KEY) {
    return { provider: "openai", model: "gpt-4o-mini", apiKey: process.env.OPENAI_API_KEY };
  }
  if (process.env.DASHSCOPE_API_KEY) {
    return {
      provider: "openai",
      model: "qwen-plus",
      apiKey: process.env.DASHSCOPE_API_KEY,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    };
  }
  console.error("No API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or DASHSCOPE_API_KEY");
  process.exit(1);
}

// ── Test cases ────────────────────────────────────────────────────────────────
interface Case {
  label: string;
  input: string;
  expectSpawn: boolean;
}

const CASES: Case[] = [
  // Stage 0 — should answer directly, NO spawn
  { label: "concept-diff",      input: "React 和 Vue 的核心区别是什么？",          expectSpawn: false },
  { label: "http-status",       input: "HTTP 301 和 302 的区别",                   expectSpawn: false },
  { label: "rebase-vs-merge",   input: "git rebase 和 merge 哪个更适合功能分支？",  expectSpawn: false },
  { label: "simple-advice",     input: "TypeScript 的 interface 和 type 有什么区别？", expectSpawn: false },
  // Must spawn — violates Stage 0 conditions
  { label: "multi-file-analysis", input: "帮我分析一下 src/ 下的代码质量",         expectSpawn: true  },
  { label: "write-file",          input: "把 API 文档写到 README.md",               expectSpawn: true  },
];

// ── Runner ────────────────────────────────────────────────────────────────────
const providerCfg = resolveProvider();
const systemPrompt = loadPmSystemPrompt();

console.log(`\nProvider: ${providerCfg.provider}  Model: ${providerCfg.model}`);
console.log(`System prompt: ${systemPrompt.length} chars (${systemPrompt.split("\n").length} lines)\n`);

interface Result {
  pass: boolean;
  hasSpawn: boolean;
  hasUserMessage: boolean;
  ttftMs: number;
  totalMs: number;
}

async function runCase(c: Case): Promise<Result> {
  const agent = new HttpConvAgent({
    id: `eval-${c.label}`,
    role: "Leader",
    providerCfg: {
      provider: providerCfg.provider,
      model: providerCfg.model,
      apiKey: providerCfg.apiKey,
      ...(providerCfg.baseUrl ? { baseUrl: providerCfg.baseUrl } : {}),
    },
    systemPrompt,
  });

  let hasSpawn = false;
  let hasUserMessage = false;
  let ttftMs = 0;
  let totalMs = 0;

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after 45s`)), 45_000);
    agent.on("event", (ev: TuiEvent) => {
      if (ev.type === "spawn")   hasSpawn = true;
      if (ev.type === "message" && (ev as { to?: string }).to === "user") hasUserMessage = true;
      if (ev.type === "token.usage") {
        if (ev.ttft_ms  !== undefined) ttftMs  = ev.ttft_ms;
        if (ev.total_ms !== undefined) totalMs = ev.total_ms;
      }
      if (ev.type === "agent.state" && (ev.state === "idle" || ev.state === "err")) {
        clearTimeout(t);
        resolve();
      }
      if (ev.type === "agent.error") {
        clearTimeout(t);
        reject(new Error((ev as { detail?: string }).detail ?? "agent.error"));
      }
    });
    agent.send(c.input);
  });

  const pass = c.expectSpawn ? hasSpawn : (!hasSpawn && hasUserMessage);
  return { pass, hasSpawn, hasUserMessage, ttftMs, totalMs };
}

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;

  const WIDTH = 24;
  console.log(`  ${"case".padEnd(WIDTH)}  result   spawn  msg    ttft    total`);
  console.log(`  ${"─".repeat(WIDTH)}  ───────  ─────  ───    ────    ─────`);

  for (const c of CASES) {
    process.stdout.write(`  ${c.label.padEnd(WIDTH)}  `);
    try {
      const r = await runCase(c);
      const label = r.pass ? "PASS   " : `FAIL   `;
      const spawnMark = r.hasSpawn ? "yes  " : "no   ";
      const msgMark   = r.hasUserMessage ? "yes" : "no ";
      const ttft  = r.ttftMs  ? `${r.ttftMs}ms`.padStart(6)  : "   n/a";
      const total = r.totalMs ? `${r.totalMs}ms`.padStart(7) : "    n/a";
      console.log(`${label}  ${spawnMark}  ${msgMark}    ${ttft}  ${total}`);
      if (r.pass) passed++; else failed++;
    } catch (err) {
      console.log(`ERROR    ${(err as Error).message.slice(0, 50)}`);
      failed++;
    }
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`${passed}/${CASES.length} passed`);
  if (failed > 0) {
    console.log(`\n⚠️  Stage 0 命中率: ${Math.round(passed / CASES.length * 100)}%`);
  } else {
    console.log(`✅  Stage 0 命中率: 100%`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
