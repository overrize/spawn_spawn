/**
 * Manual eval script: Stage 0 fast-answer gate.
 *
 * NOT part of CI. Run manually to spot-check Stage 0 against a live LLM.
 * Usage:
 *   npx tsx src/tests/scripts/eval-stage0.ts
 *
 * Requires ANTHROPIC_API_KEY or OPENAI_API_KEY in env.
 * Prints PASS/FAIL for each test case with reason.
 */

import { HttpConvAgent } from "../../adapters/httpAgent.js";
import type { TuiEvent } from "../../protocol.js";

interface Case {
  label: string;
  input: string;
  expectSpawn: boolean;
}

const CASES: Case[] = [
  // Stage 0 — should answer directly, NO spawn
  { label: "concept-diff",      input: "React 和 Vue 的核心区别是什么？",         expectSpawn: false },
  { label: "http-status",       input: "HTTP 301 和 302 的区别",                  expectSpawn: false },
  { label: "single-file-read",  input: "package.json 里 react 版本是多少",        expectSpawn: false },
  { label: "rebase-vs-merge",   input: "git rebase 和 merge 哪个更适合功能分支？", expectSpawn: false },
  // Must spawn — should NOT short-circuit
  { label: "multi-file-analysis", input: "帮我分析一下 src/ 下的代码质量",        expectSpawn: true  },
  { label: "write-file",          input: "把 API 文档写到 README.md",              expectSpawn: true  },
];

const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY;
const provider = process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai";

if (!apiKey) {
  console.error("ANTHROPIC_API_KEY or OPENAI_API_KEY is required");
  process.exit(1);
}

async function runCase(c: Case): Promise<boolean> {
  const agent = new HttpConvAgent({
    id: `eval-${c.label}`,
    role: "Leader",
    providerCfg: {
      provider,
      model: provider === "anthropic" ? "claude-haiku-4-5-20251001" : "gpt-4o-mini",
      apiKey: apiKey!,
    },
  });

  let hasSpawn = false;
  let hasUserMessage = false;

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${c.label}`)), 30_000);
    agent.on("event", (ev: TuiEvent) => {
      if (ev.type === "spawn")   hasSpawn = true;
      if (ev.type === "message" && (ev as { to?: string }).to === "user") hasUserMessage = true;
      if (ev.type === "agent.state" && ev.state === "idle") {
        clearTimeout(t);
        resolve();
      }
    });
    agent.send(c.input);
  });

  const pass = c.expectSpawn ? hasSpawn : (!hasSpawn && hasUserMessage);
  return pass;
}

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;

  for (const c of CASES) {
    process.stdout.write(`  ${c.label.padEnd(22)} ... `);
    try {
      const ok = await runCase(c);
      if (ok) {
        console.log("PASS");
        passed++;
      } else {
        console.log(`FAIL  (expected spawn=${c.expectSpawn})`);
        failed++;
      }
    } catch (err) {
      console.log(`ERROR  ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\n${passed}/${CASES.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
