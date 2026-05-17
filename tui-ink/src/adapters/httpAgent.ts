import { EventEmitter } from "node:events";
import https from "node:https";
import http from "node:http";
import type { TuiEvent, AgentCommand } from "../protocol.js";
import type { ProviderConfig } from "../config.js";
import { loadMessages } from "../memory/MemoryStore.js";

const VALID_TYPES = new Set([
  "todo.set", "step", "tool.call", "tool.result", "message",
  "spawn", "agent.done", "agent.error", "agent.state",
  // S6 events
  "unit.handup", "memory.snapshot", "shutdown.start",
  "pm.alert", "proposal.new", "proposal.decision",
]);
const LOG = !!process.env.LOG_EVENTS;

export class HttpConvAgent extends EventEmitter {
  pendingPermId: string | null = null;
  proc: null = null; // compat with index.tsx type
  private messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  private _busy = false;
  private _abort: AbortController | null = null;
  private _queue: string[] = []; // outbound message queue when busy

  constructor(public cfg: {
    id: string;
    role: string;
    providerCfg: ProviderConfig;
    systemPrompt?: string;
    resumeFrom?: string; // S3: agentId to resume messages from
  }) {
    super();
    // S3: load conversation history for resume
    if (cfg.resumeFrom) {
      this.messages = loadMessages(cfg.resumeFrom).map((m) => ({
        role: m.role,
        content: m.content,
      }));
    }
  }

  sendCommand(cmd: AgentCommand): void {
    if (cmd.type === "user.message") {
      this._enqueue(cmd.text);
    } else if (cmd.type === "tool.result") {
      const text = `[tool_result id="${cmd.id}" ok="${cmd.ok}"]\n${cmd.output}`;
      this._enqueue(text);
    }
  }

  private _enqueue(text: string): void {
    if (this._busy) {
      this._queue.push(text);
    } else {
      this.send(text);
    }
  }

  kill(): void {
    this._abort?.abort();
  }

  async send(text: string): Promise<void> {
    if (this._busy) return;
    this._busy = true;
    this._abort = new AbortController();
    this.messages.push({ role: "user", content: text });
    // S2: notify SecretaryProxy for message persistence
    this.emit("_raw_message", { role: "user", content: text });

    this.emit("event", {
      v: 1, type: "agent.state", agent: this.cfg.id,
      state: "run", sub: "thinking…",
    } as TuiEvent);

    try {
      const pc = this.cfg.providerCfg;
      const fullText = pc.provider === "anthropic"
        ? await this._callAnthropic()
        : await this._callOpenAI();

      this.messages.push({ role: "assistant", content: fullText });
      // S2: notify SecretaryProxy for message persistence
      this.emit("_raw_message", { role: "assistant", content: fullText });

      if (LOG) process.stderr.write(`[${this.cfg.id}] raw response:\n${fullText}\n---\n`);

      // 解析协议 JSON。支持单行和多行格式，用大括号深度计数累积完整对象。
      let jsonBuf = "";
      let depth = 0;

      const emitParsed = (raw: string) => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed?.type && VALID_TYPES.has(String(parsed.type))) {
            const ev = { v: 1 as const, ...parsed, agent: parsed.agent ?? this.cfg.id } as TuiEvent;
            if (LOG) process.stderr.write(`[${this.cfg.id}] event: ${JSON.stringify(ev)}\n`);
            this.emit("event", ev);
            return;
          }
        } catch { /* not valid protocol JSON */ }
        // 非协议 JSON 或解析失败 → 散文消息
        if (LOG) process.stderr.write(`[${this.cfg.id}] prose: ${raw}\n`);
        this.emit("event", {
          v: 1, type: "message", agent: this.cfg.id, to: "user", text: raw.trim(),
        } as TuiEvent);
      };

      for (const line of fullText.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          // 空行：如果当前不在 JSON 块里，忽略；否则继续累积（理论上不该有空行）
          if (depth === 0 && jsonBuf) { emitParsed(jsonBuf); jsonBuf = ""; }
          continue;
        }

        if (depth === 0 && !trimmed.startsWith("{")) {
          // 纯散文行（不以 { 开头）
          if (jsonBuf) { emitParsed(jsonBuf); jsonBuf = ""; }
          emitParsed(trimmed);
          continue;
        }

        // 计大括号深度（忽略字符串内的括号，简化实现）
        jsonBuf += (jsonBuf ? "\n" : "") + trimmed;
        for (const ch of trimmed) {
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
        }

        if (depth <= 0) {
          // 对象闭合
          emitParsed(jsonBuf);
          jsonBuf = "";
          depth = 0;
        }
      }
      if (jsonBuf.trim()) emitParsed(jsonBuf);

      this.emit("event", {
        v: 1, type: "agent.state", agent: this.cfg.id,
        state: "idle", sub: "",
      } as TuiEvent);
    } catch (err: any) {
      if (err.name === "AbortError") return;
      const detail = err.message?.slice(0, 200) ?? "unknown error";
      process.stderr.write(`[${this.cfg.id}] HTTP error: ${detail}\n`);
      this.emit("event", {
        v: 1, type: "agent.error", agent: this.cfg.id,
        code: "http_error", detail,
      } as TuiEvent);
      this.emit("event", {
        v: 1, type: "agent.state", agent: this.cfg.id,
        state: "err", sub: detail.slice(0, 40),
      } as TuiEvent);
    } finally {
      this._busy = false;
      this._abort = null;
      // Drain one queued message per turn so worker reports land in order
      if (this._queue.length > 0) {
        const next = this._queue.shift()!;
        setImmediate(() => this.send(next));
      }
    }
  }

  private async _callAnthropic(): Promise<string> {
    const pc = this.cfg.providerCfg;
    const body = JSON.stringify({
      model: pc.model,
      max_tokens: 8192,
      ...(this.cfg.systemPrompt ? { system: this.cfg.systemPrompt } : {}),
      messages: this.messages,
      stream: true,
    });

    const stream = await this._doStream(
      "api.anthropic.com",
      "POST",
      "/v1/messages",
      {
        "x-api-key": pc.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body,
    );

    return this._readStream(stream, (chunk) => {
      // Anthropic SSE: data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
      try {
        const parsed = JSON.parse(chunk);
        if (parsed?.type === "content_block_delta" && parsed.delta?.text) {
          return parsed.delta.text;
        }
      } catch { /* skip non-JSON */ }
      return null;
    });
  }

  private async _callOpenAI(): Promise<string> {
    const pc = this.cfg.providerCfg;
    const baseUrl = pc.baseUrl || "https://api.openai.com";
    const url = new URL(baseUrl);
    const port = url.port ? parseInt(url.port, 10) : undefined;
    const sysMsg = this.cfg.systemPrompt
      ? [{ role: "system" as const, content: this.cfg.systemPrompt }]
      : [];
    const body = JSON.stringify({
      model: pc.model,
      max_tokens: 8192,
      messages: [
        ...sysMsg,
        ...this.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      stream: true,
    });

    const stream = await this._doStream(
      url.hostname,
      "POST",
      url.pathname.replace(/\/?$/, "") + "/v1/chat/completions",
      {
        "Authorization": `Bearer ${pc.apiKey}`,
        "content-type": "application/json",
      },
      body,
      port,
    );

    return this._readStream(stream, (chunk) => {
      // OpenAI/DeepSeek SSE: data: {"choices":[{"delta":{"content":"...","reasoning_content":"..."}}]}
      // Reasoning models (deepseek-v4-flash, o1, etc.) stream thinking into reasoning_content
      // and the actual answer into content. We capture both: reasoning shown as step, content
      // accumulated as protocol output.
      if (chunk === "[DONE]") return null;
      try {
        const parsed = JSON.parse(chunk);
        const delta = parsed?.choices?.[0]?.delta;
        if (!delta) return null;

        // Reasoning/thinking phase — emit step event but don't add to fullText
        const reasoning = delta.reasoning_content;
        if (typeof reasoning === "string" && reasoning) {
          this.emit("event", {
            v: 1, type: "step", agent: this.cfg.id, text: "thinking…",
          } as TuiEvent);
          return null;
        }

        // Actual answer — accumulate into fullText for protocol parsing
        const content = delta.content;
        return typeof content === "string" && content ? content : null;
      } catch { return null; }
    });
  }

  private _doStream(
    hostname: string,
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string,
    port?: number,
  ): Promise<NodeJS.ReadableStream> {
    return new Promise((resolve, reject) => {
      const isHttps = !hostname.startsWith("localhost") && !hostname.startsWith("127.");
      const mod = isHttps ? https : http;

      const REQUEST_TIMEOUT_MS = 8 * 60 * 1000; // 8 min — well under PM's 60min kill
      const req = mod.request({
        hostname,
        port,
        path,
        method,
        headers: { ...headers, accept: "text/event-stream" },
        signal: this._abort?.signal,
        timeout: REQUEST_TIMEOUT_MS,
      }, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let errBody = "";
          res.on("data", (d: Buffer) => { errBody += d.toString(); });
          res.on("end", () => {
            try {
              const parsed = JSON.parse(errBody);
              const msg = parsed?.error?.message ?? parsed?.message ?? errBody.slice(0, 120);
              reject(new Error(`HTTP ${res.statusCode}: ${msg}`));
            } catch {
              reject(new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 120)}`));
            }
          });
          return;
        }
        resolve(res);
      });

      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("request timeout (8min)")));
      req.write(body);
      req.end();
    });
  }

  private _readStream(
    stream: NodeJS.ReadableStream,
    parseChunk: (data: string) => string | null,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let fullText = "";
      let buf = "";

      stream.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";

        for (const part of parts) {
          const lines = part.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (!data) continue;

            const delta = parseChunk(data);
            if (delta) {
              fullText += delta;
              this.emit("event", {
                v: 1, type: "step", agent: this.cfg.id, text: "generating…",
              } as TuiEvent);
            }
          }
        }
      });

      stream.on("end", () => {
        // Flush any remaining SSE event that lacked a trailing \n\n
        for (const line of buf.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          const delta = parseChunk(data);
          if (delta) fullText += delta;
        }
        resolve(fullText);
      });
      stream.on("error", reject);
    });
  }
}
