// Agent — 一个 Claude Code 子进程的包装。
// 用 `claude -p --output-format stream-json` 拉起,把 Anthropic 的事件流
// adapt 成我们自己的 TuiEvent。

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { TuiEvent, AgentCommand } from "./protocol.js";

export interface AgentConfig {
  id: string;
  role: "Leader" | "Secretary" | "Worker";
  systemPromptFile: string;
  initialPrompt: string;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  cwd?: string;
  resumeSessionId?: string;
}

// 哪些工具需要审批 — Bash/写文件都得审,只读不用
const APPROVE_PREFIX = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"];
function needsApproval(name: string): boolean {
  return APPROVE_PREFIX.some((t) => name === t || name.startsWith(t));
}

export class Agent extends EventEmitter {
  proc: ChildProcess | null = null;
  sessionId: string | null = null;
  pendingPermId: string | null = null;
  private _permCounter = 0;

  constructor(public cfg: AgentConfig) {
    super();
  }

  start(): void {
    const resumeFlag: string[] = this.cfg.resumeSessionId
      ? ["--resume", this.cfg.resumeSessionId]
      : ["-p", this.cfg.initialPrompt];
    const args: string[] = [
      ...resumeFlag,
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--system-prompt-file", this.cfg.systemPromptFile,
      "--max-turns", String(this.cfg.maxTurns ?? 20),
      "--verbose",
      "--permission-mode", "plan",
    ];
    if (this.cfg.model) args.push("--model", this.cfg.model);
    if (this.cfg.allowedTools?.length) {
      args.push("--allowed-tools", this.cfg.allowedTools.join(","));
    }
    if (this.cfg.disallowedTools?.length) {
      args.push("--disallowed-tools", this.cfg.disallowedTools.join(","));
    }

    this.emit("event", {
      v: 1, type: "agent.state", agent: this.cfg.id,
      state: "run", sub: `spawning ${this.cfg.model ?? "claude"}…`,
    } as TuiEvent);

    try {
      this.proc = spawn("claude", args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: this.cfg.cwd,
        env: process.env,
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
      const raw = d.toString();
      const lines = raw.split("\n");
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;

        // 检测 Claude Code permission-mode plan 的审批提示
        // 关键特征：包含 "?" 且包含工具相关词
        const isPerm =
          (t.includes("Do you want") || t.includes("Allow") || t.includes("approve") ||
           t.includes("permission") || t.includes("Proceed")) &&
          (t.includes("?") || t.includes("(y/n)") || t.includes("[y/N]"));

        if (isPerm) {
          const permId = `perm-${++this._permCounter}`;
          this.pendingPermId = permId;
          // 从提示文本里尝试提取工具名
          const toolMatch = t.match(/\b(Read|Write|Edit|Bash|Glob|Grep|MultiEdit)\b/);
          const toolName = toolMatch?.[1] ?? "unknown";
          this.emit("event", {
            v: 1, type: "tool.call", agent: this.cfg.id,
            id: permId, name: toolName, args: { prompt: t.slice(0, 200) },
            needs_approval: true,
          } as TuiEvent);
        } else {
          // 非审批 stderr 静默丢弃，避免噪声
        }
      }
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

  sendCommand(cmd: AgentCommand): void {
    if (!this.proc?.stdin || this.proc.killed) return;
    switch (cmd.type) {
      case "user.message": {
        const payload = {
          type: "user",
          message: { role: "user", content: [{ type: "text", text: cmd.text }] },
        };
        this.proc.stdin.write(JSON.stringify(payload) + "\n");
        break;
      }
      case "control":
        if (cmd.action === "interrupt") this.proc.kill("SIGINT");
        else if (cmd.action === "pause")  this.proc.kill("SIGSTOP");
        else if (cmd.action === "resume") this.proc.kill("SIGCONT");
        break;
      default:
        break;
    }
  }

  kill(): void {
    this.proc?.kill("SIGTERM");
  }

  // ── Anthropic stream-json → TuiEvent adapter ──────────────────────────────
  private handleLine(line: string): void {
    let msg: any;
    try { msg = JSON.parse(line); }
    catch { return; } // 非 JSON 静默丢弃 (协议违规)
    const id = this.cfg.id;

    // system.init — claude 在初始化时发一次,带 session_id
    if (msg.type === "system" && msg.subtype === "init") {
      this.sessionId = msg.session_id ?? null;
      this.emit("event", {
        v: 1, type: "step", agent: id,
        text: `session ${(this.sessionId ?? "?").slice(0, 8)} ready`,
      } as TuiEvent);
      return;
    }

    // assistant — agent 的文本和工具调用
    if (msg.type === "assistant" && msg.message?.content) {
      for (const c of msg.message.content) {
        if (c.type === "text" && c.text?.trim()) {
          for (const line of c.text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            // 先尝试解析为协议 JSON
            try {
              const parsed = JSON.parse(trimmed);
              if (parsed?.v === 1 && parsed?.type) {
                // 合法协议事件，直接转发，补 agent 字段
                this.emit("event", { ...parsed, agent: parsed.agent ?? id } as TuiEvent);
                continue;
              }
            } catch { /* 非 JSON，走 fallback */ }
            // fallback：散文输出 → message 气泡
            this.emit("event", {
              v: 1, type: "message", agent: id, to: "user", text: trimmed,
            } as TuiEvent);
          }
        } else if (c.type === "tool_use") {
          this.emit("event", {
            v: 1, type: "tool.call", agent: id, id: c.id,
            name: c.name, args: c.input,
            needs_approval: needsApproval(c.name),
          } as TuiEvent);
        }
      }
      return;
    }

    // user (tool_result 回执 — Claude Code 自己注入的) — 我们也展示
    if (msg.type === "user" && msg.message?.content) {
      for (const c of msg.message.content) {
        if (c.type === "tool_result") {
          const out = typeof c.content === "string"
            ? c.content
            : JSON.stringify(c.content).slice(0, 200);
          this.emit("event", {
            v: 1, type: "tool.result", agent: id, id: c.tool_use_id,
            ok: !c.is_error, output: out.slice(0, 300),
          } as TuiEvent);
        }
      }
      return;
    }

    // result — 整个 -p 调用结束
    if (msg.type === "result") {
      this.emit("event", {
        v: 1, type: "agent.done", agent: id,
        success: msg.subtype === "success",
        reason: typeof msg.result === "string"
          ? msg.result.slice(0, 120)
          : msg.subtype,
      } as TuiEvent);
      return;
    }
  }
}
