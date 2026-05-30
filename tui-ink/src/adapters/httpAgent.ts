import { EventEmitter } from "node:events";
import https from "node:https";
import http from "node:http";
import type { TuiEvent, AgentCommand, DispatchSpec, CacheSafeParams } from "../protocol.js";
import type { ProviderConfig } from "../config.js";
import { loadMessages } from "../memory/MemoryStore.js";
import { serializeCachePrefix } from "../cache/CachePrefixManager.js";

const VALID_TYPES = new Set([
  "todo.set", "step", "tool.call", "tool.result", "message",
  "spawn", "agent.done", "agent.error", "agent.state",
  // S6 events
  "unit.handup", "memory.snapshot", "shutdown.start",
  "pm.alert", "proposal.new", "proposal.decision",
  // Bash approval protocol: leader approves/rejects destructive worker commands
  "tool.approved", "tool.rejected",
]);
const LOG = !!process.env.LOG_EVENTS;

export class HttpConvAgent extends EventEmitter {
  pendingPermId: string | null = null;
  proc: null = null; // compat with index.tsx type
  private messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  private _busy = false;
  private _abort: AbortController | null = null;
  private _queue: string[] = []; // outbound message queue when busy
  private _cachePrefix: CacheSafeParams | null = null; // 当前缓存前缀参数（Fork 时共享）
  private _cachePrefixSerialized: string = "";       // 缓存前缀序列化字符串
  private _cacheDispatch: DispatchSpec | null = null;  // 当前 DispatchSpec（Fork 时传递）
  private _loopIdx = 0;                               // 单调递增循环计数

  constructor(public cfg: {
    id: string;
    role: string;
    providerCfg: ProviderConfig;
    systemPrompt?: string;
    resumeFrom?: string; // S3: agentId to resume messages from
    dispatch?: DispatchSpec; // S1: for Fork cache prefix reuse
  }) {
    super();
    // 如果 dispatch 携带 cachePrefix，初始化 _cachePrefix
    if (cfg.dispatch?.cachePrefix) {
      this._cachePrefix = cfg.dispatch.cachePrefix;
      this._cachePrefixSerialized = serializeCachePrefix(cfg.dispatch.cachePrefix);
      this._cacheDispatch = cfg.dispatch;
    }
    // S3: load conversation history for resume, with token-budget guard
    if (cfg.resumeFrom) {
      const RESUME_CHAR_BUDGET = 60_000; // ≈ 15K tokens — leaves room for system prompt + new response
      const raw = loadMessages(cfg.resumeFrom);
      const all = raw.map((m) => ({ role: m.role, content: m.content }));
      const total = all.reduce((s, m) => s + m.content.length, 0);
      if (total <= RESUME_CHAR_BUDGET) {
        this.messages = all;
      } else {
        // Walk newest→oldest; include messages until budget full.
        // Last 4 messages are always kept regardless of size.
        const kept: typeof all = [];
        let size = 0;
        for (let i = all.length - 1; i >= 0; i--) {
          const m = all[i]!;
          const required = i >= all.length - 4;
          if (!required && size + m.content.length > RESUME_CHAR_BUDGET) break;
          kept.unshift(m);
          size += m.content.length;
        }
        process.stderr.write(
          `[${cfg.id}] resume: history truncated ${all.length}→${kept.length} msgs (${total}→${size} chars)\n`,
        );
        this.messages = kept;
      }
    }
  }

  /**
   * setCachePrefix — 设置/更新当前缓存前缀参数
   * 供 Fork 子 agent 在初始化后复用父 agent 的缓存前缀
   */
  setCachePrefix(params: CacheSafeParams): void {
    this._cachePrefix = params;
    this._cachePrefixSerialized = serializeCachePrefix(params);
  }

  /**
   * getCachePrefix — 返回当前缓存前缀参数（如果已设置）
   * 供 Fork 子 agent 读取共享缓存前缀
   */
  getCachePrefix(): CacheSafeParams | null {
    return this._cachePrefix;
  }

  /**
   * getCachePrefixSerialized — 返回序列化的缓存前缀字符串
   * （内部使用，用于 Anthropic API 请求体组装）
   */
  getCachePrefixSerialized(): string {
    return this._cachePrefixSerialized;
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

  private static _isRetryable(err: any): boolean {
    const msg: string = err?.message ?? "";
    // HTTP 429 (rate limit) and 5xx (server errors) are retryable
    if (/^HTTP (429|500|502|503|504):/.test(msg)) return true;
    return (
      err?.code === "ECONNRESET" ||
      msg.includes("socket hang up") ||
      msg.includes("ECONNRESET") ||
      msg.includes("ETIMEDOUT") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("request timeout") ||
      msg.includes("stream idle timeout")
    );
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

    const MAX_RETRIES = 3;
    let lastErr: any;
    let fullText = "";

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with jitter: base 2s * attempt, ±30% random
        const base = attempt * 2;
        const jitter = base * 0.3 * (Math.random() * 2 - 1);
        const delaySec = Math.max(1, Math.round(base + jitter));
        process.stderr.write(`[${this.cfg.id}] network error, retry ${attempt}/${MAX_RETRIES} in ${delaySec}s…\n`);
        this.emit("event", {
          v: 1, type: "agent.state", agent: this.cfg.id,
          state: "run", sub: `retry ${attempt}/${MAX_RETRIES}…`,
        } as TuiEvent);
        await new Promise((r) => setTimeout(r, delaySec * 1000));
      }
      try {
        const pc = this.cfg.providerCfg;
        fullText = pc.provider === "anthropic"
          ? await this._callAnthropic()
          : await this._callOpenAI();
        lastErr = null;
        break; // success
      } catch (err: any) {
        if (err.name === "AbortError") return;
        lastErr = err;
        if (!HttpConvAgent._isRetryable(err) || attempt >= MAX_RETRIES) break;
      }
    }

    try {
      if (lastErr) throw lastErr;

      this.messages.push({ role: "assistant", content: fullText });
      // S2: notify SecretaryProxy for message persistence
      this.emit("_raw_message", { role: "assistant", content: fullText });

      if (LOG) process.stderr.write(`[${this.cfg.id}] raw response:\n${fullText}\n---\n`);

      // 解析协议 JSON。支持单行和多行格式，用大括号深度计数累积完整对象。
      let jsonBuf = "";
      let depth = 0;

      // Repair JSON strings that contain literal newlines/CR (non-standard agent output).
      // Scans with the same inStr/esc tracking as the depth counter.
      const repairJsonLiterals = (s: string): string => {
        let out = "", inStr = false, esc = false;
        for (const ch of s) {
          if (esc)                    { esc = false; out += ch; continue; }
          if (ch === "\\" && inStr)   { esc = true;  out += ch; continue; }
          if (ch === '"')             { inStr = !inStr; out += ch; continue; }
          if (inStr && ch === "\n")   { out += "\\n"; continue; }
          if (inStr && ch === "\r")   { out += "\\r"; continue; }
          if (inStr && ch === "\t")   { out += "\\t"; continue; }
          out += ch;
        }
        return out;
      };

      const emitParsed = (raw: string) => {
        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          try { parsed = JSON.parse(repairJsonLiterals(raw)); } catch { parsed = null; }
        }
        if (parsed) try {
          // Internal thinking block — show as step status, never as conversation message
          if (parsed?.type === "think") {
            const thought = String(parsed.thought ?? parsed.text ?? "").slice(0, 120);
            if (thought) this.emit("event", {
              v: 1, type: "step", agent: this.cfg.id, text: `💭 ${thought}`,
            } as TuiEvent);
            return;
          }
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

        // 计大括号深度，正确跳过字符串内的括号
        jsonBuf += (jsonBuf ? "\n" : "") + trimmed;
        let inStr = false, esc = false;
        for (const ch of trimmed) {
          if (esc)            { esc = false; continue; }
          if (ch === "\\" && inStr) { esc = true;  continue; }
          if (ch === '"')     { inStr = !inStr; continue; }
          if (inStr)          continue;
          if (ch === "{")     depth++;
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

  // Trim history to avoid oversized requests. Keeps first message (initial context) +
  // the most recent messages. Drops the oldest middle messages first.
  private _trimmedHistory(): typeof this.messages {
    const MAX_CHARS = 80_000;
    const msgs = this.messages;
    let total = msgs.reduce((s, m) => s + m.content.length, 0);
    if (total <= MAX_CHARS) return msgs;
    // Always keep index 0 (initial user task) and never drop the last 4 messages.
    const result = [...msgs];
    let i = 1;
    while (total > MAX_CHARS && i < result.length - 4) {
      total -= result[i]!.content.length;
      result.splice(i, 1);
      // Don't advance i — splice shifts everything down
    }
    process.stderr.write(`[${this.cfg.id}] history trimmed to ${result.length} msgs (${total} chars)\n`);
    return result;
  }

  private async _callAnthropic(): Promise<string> {
    const pc = this.cfg.providerCfg;

    // ── Prompt caching 支持 ────────────────────────────────────────────
    // 如果 systemPrompt 存在，用数组格式并标记 cache_control: ephemeral
    const systemBlock = this.cfg.systemPrompt
      ? [{ type: "text", text: this.cfg.systemPrompt, cache_control: { type: "ephemeral" } }]
      : undefined;

    // messages 统一用数组格式（Anthropic 要求同一请求所有 content 类型一致）
    // 最后一条 user message 标记 cache_control: ephemeral 作为缓存断点
    const trimmedHistory = this._trimmedHistory();
    const messages = trimmedHistory.map((m, i) => {
      const isLastUser = i === trimmedHistory.length - 1 && m.role === "user";
      return {
        role: m.role,
        content: [{
          type: "text",
          text: m.content,
          ...(isLastUser ? { cache_control: { type: "ephemeral" as const } } : {}),
        }],
      };
    });

    const body = JSON.stringify({
      model: pc.model,
      max_tokens: 8192,
      ...(systemBlock ? { system: systemBlock } : {}),
      messages,
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
        ...this._trimmedHistory().map((m) => ({ role: m.role, content: m.content })),
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
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const IDLE_TIMEOUT_MS = 120_000; // 2min: accommodates slow chain-of-thought models

      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          stream.removeAllListeners("data");
          stream.removeAllListeners("end");
          stream.removeAllListeners("error");
          reject(new Error("stream idle timeout"));
        }, IDLE_TIMEOUT_MS);
      };

      resetIdleTimer();

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
            resetIdleTimer();
          }
        }
      });

      stream.on("end", () => {
        if (idleTimer) clearTimeout(idleTimer);
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
      stream.on("error", (err) => {
        if (idleTimer) clearTimeout(idleTimer);
        reject(err);
      });
    });
  }
}
