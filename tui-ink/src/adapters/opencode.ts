import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { TuiEvent } from "../protocol.js";

export interface OpenCodeConfig {
  id: string;
  role: "Secretary" | "Worker";
  goal: string;
  model: string;
  cwd?: string;
}

export class OpenCodeAgent extends EventEmitter {
  proc: ChildProcess | null = null;
  pendingPermId: string | null = null;
  private _failStreak = 0;

  constructor(public cfg: OpenCodeConfig) {
    super();
  }

  start(): void {
    const args = [
      "run", "--print",
      "--model", this.cfg.model,
      this.cfg.goal,
    ];

    this.emit("event", {
      v: 1, type: "agent.state", agent: this.cfg.id,
      state: "run", sub: `spawning ${this.cfg.model}…`,
    } as TuiEvent);

    try {
      this.proc = spawn("opencode", args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: this.cfg.cwd,
        env: { ...process.env },
      });
    } catch (err: any) {
      this.emit("event", {
        v: 1, type: "agent.error", agent: this.cfg.id,
        code: "spawn_failed", detail: err.message,
      } as TuiEvent);
      return;
    }

    const rl = readline.createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => this.handleLine(line));

    this.proc.stderr?.on("data", (d: Buffer) => {
      const detail = d.toString().trim();
      if (!detail) return;
      this.emit("event", {
        v: 1, type: "agent.error", agent: this.cfg.id,
        code: "stderr", detail: detail.slice(0, 200),
      } as TuiEvent);
    });

    this.proc.on("exit", (code) => {
      this.emit("event", {
        v: 1, type: "agent.state", agent: this.cfg.id,
        state: code === 0 ? "done" : "err",
      } as TuiEvent);
    });

    this.proc.on("error", (err: any) => {
      this.emit("event", {
        v: 1, type: "agent.error", agent: this.cfg.id,
        code: "proc_error", detail: err.message,
      } as TuiEvent);
    });
  }

  private handleLine(line: string): void {
    const id = this.cfg.id;
    const stripped = line.trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/, "")
      .replace(/```$/, "")
      .trim();
    if (!stripped) return;

    try {
      const parsed = JSON.parse(stripped);
      if (parsed?.v === 1 && parsed?.type) {
        this._failStreak = 0;
        this.emit("event", { ...parsed, agent: parsed.agent ?? id } as TuiEvent);
        return;
      }
    } catch { /* 非 JSON */ }

    if (++this._failStreak >= 3) {
      this._failStreak = 0;
      this.emit("event", {
        v: 1, type: "agent.error", agent: id,
        code: "parse_failure",
        detail: `non-JSON output: ${stripped.slice(0, 100)}`,
      } as TuiEvent);
    }
  }

  sendCommand(cmd: import("../protocol.js").AgentCommand): void {
    if (!this.proc?.stdin || this.proc.killed) return;
    if (cmd.type === "user.message") {
      this.proc.stdin.write(cmd.text + "\n");
    }
  }

  kill(): void {
    this.proc?.kill("SIGTERM");
  }
}
