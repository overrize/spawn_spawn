/**
 * TuiDriver — tmux-backed terminal driver for E2E tests.
 *
 * Each TuiDriver instance owns one tmux session, one temp config dir, and
 * one temp working dir (so .spawn/memory/ is isolated per test run).
 *
 * Prerequisites: apt install tmux   (checked at construction time)
 *
 * Usage:
 *   const driver = new TuiDriver({ mockPort: 9999 });
 *   await driver.start();
 *   await driver.sendLine("hello world");
 *   await driver.waitFor(/hello|AGENTS/);
 *   driver.destroy();
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const TUI_DIR = path.resolve(__dirname, "../../../.."); // tui-ink/

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TuiDriverOpts {
  /** Port of the MockLLMServer to point all agents at. */
  mockPort: number;
  /** Terminal width (default 180). Wider = less wrapping = easier text matching. */
  cols?: number;
  /** Terminal height (default 40). */
  rows?: number;
  /** Use --demo mode (no LLM calls at all). */
  demo?: boolean;
}

// ── Driver ────────────────────────────────────────────────────────────────────

export class TuiDriver {
  private sessionName: string;
  private configDir: string;
  private workDir: string;
  private started = false;

  constructor(private opts: TuiDriverOpts) {
    ensureTmux();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    this.sessionName = `tui-e2e-${id}`;
    this.configDir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-cfg-"));
    this.workDir   = fs.mkdtempSync(path.join(os.tmpdir(), "tui-wd-"));
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(timeoutMs = 20_000): Promise<void> {
    this.writeConfig();

    const cols = this.opts.cols ?? 180;
    const rows = this.opts.rows ?? 40;

    // Create detached tmux session
    this.tmux(`new-session -d -s "${this.sessionName}" -x ${cols} -y ${rows}`);

    // Build startup command — run from workDir so .spawn/memory is isolated
    const tsxBin = path.join(TUI_DIR, "node_modules", ".bin", "tsx");
    const entry  = path.join(TUI_DIR, "src", "index.tsx");
    const flags  = this.opts.demo ? "-- --demo" : "";
    const envs   = `XDG_CONFIG_HOME=${this.configDir}`;
    const cmd    = `cd ${this.workDir} && ${envs} ${tsxBin} ${entry} ${flags}`;

    this.tmux(`send-keys -t "${this.sessionName}" "${cmd}" Enter`);
    this.started = true;

    // Wait until the TUI renders its frame
    await this.waitFor("AGENTS", timeoutMs);
  }

  destroy(): void {
    if (this.started) {
      try { this.tmux(`kill-session -t "${this.sessionName}"`); } catch { /* already dead */ }
    }
    safeRm(this.configDir);
    safeRm(this.workDir);
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  /** Type text without pressing Enter. */
  async type(text: string): Promise<void> {
    // Escape single quotes for shell
    const safe = text.replace(/\\/g, "\\\\").replace(/'/g, "'\\''");
    this.tmux(`send-keys -t "${this.sessionName}" '${safe}' ""`);
    await sleep(30);
  }

  /** Press Enter. */
  async enter(): Promise<void> {
    this.tmux(`send-keys -t "${this.sessionName}" "" Enter`);
    await sleep(50);
  }

  /** Type text and press Enter. */
  async sendLine(text: string): Promise<void> {
    await this.type(text);
    await this.enter();
  }

  /**
   * Send a special key.
   * key: "Escape" | "Tab" | "Left" | "Right" | "Up" | "Down" | "BSpace"
   */
  async key(k: string): Promise<void> {
    this.tmux(`send-keys -t "${this.sessionName}" "${k}" ""`);
    await sleep(50);
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  /** Capture the entire visible pane as a string. */
  capture(): string {
    return this.tmux(`capture-pane -t "${this.sessionName}" -p`);
  }

  /**
   * Poll until pattern appears in the pane or timeout expires.
   * Returns the captured output when pattern is found.
   */
  async waitFor(
    pattern: string | RegExp,
    timeoutMs = 10_000,
    pollMs = 150,
  ): Promise<string> {
    const re = toRegExp(pattern);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const out = this.capture();
      if (re.test(out)) return out;
      await sleep(pollMs);
    }
    throw new Error(
      `waitFor(${pattern}) timed out after ${timeoutMs}ms\n` +
      `Last pane output:\n${this.capture()}`,
    );
  }

  /**
   * Assert the current pane contains pattern (instant, no polling).
   */
  assertContains(pattern: string | RegExp): void {
    const re = toRegExp(pattern);
    const out = this.capture();
    if (!re.test(out)) {
      throw new Error(`assertContains(${pattern}) failed\nPane:\n${out}`);
    }
  }

  /**
   * Assert the current pane does NOT contain pattern.
   */
  assertAbsent(pattern: string | RegExp): void {
    const re = toRegExp(pattern);
    const out = this.capture();
    if (re.test(out)) {
      throw new Error(`assertAbsent(${pattern}) — found but should be absent\nPane:\n${out}`);
    }
  }

  /** Count non-overlapping occurrences of pattern in current pane. */
  count(pattern: string | RegExp): number {
    const source = typeof pattern === "string" ? pattern : pattern.source;
    const flags  = typeof pattern === "string" ? "g" : (pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    return (this.capture().match(new RegExp(source, flags)) ?? []).length;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private tmux(args: string): string {
    return execSync(`tmux ${args}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  }

  private writeConfig(): void {
    const cfgDir = path.join(this.configDir, "multi-agent-tui");
    fs.mkdirSync(cfgDir, { recursive: true });

    const agentCfg = {
      provider: "openai",
      model: "mock-model",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${this.opts.mockPort}`,
    };

    const config = {
      palette: "paper",
      layout: "v1",
      agents: { leader: agentCfg, secretary: agentCfg, worker: agentCfg },
    };

    fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify(config));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureTmux(): void {
  try {
    execSync("tmux -V", { stdio: "pipe" });
  } catch {
    throw new Error(
      "tmux not found. Install it first:\n" +
      "  sudo apt install tmux   # Debian/Ubuntu\n" +
      "  brew install tmux       # macOS",
    );
  }
}

function toRegExp(p: string | RegExp): RegExp {
  return typeof p === "string" ? new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : p;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeRm(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
