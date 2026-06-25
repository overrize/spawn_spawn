import { EventEmitter } from "node:events";
import https from "node:https";
import http from "node:http";
import type { TuiEvent, AgentCommand, DispatchSpec, CacheSafeParams } from "../protocol.js";
import type { ProviderConfig } from "../config.js";
import { resolveMaxTokens } from "../config.js";
import { loadMessages } from "../memory/MemoryStore.js";
import { serializeCachePrefix } from "../cache/CachePrefixManager.js";
import { globalBus } from "../bus/Bus.js";
import { parseAgentOutput } from "../protocol/normalizer.js";
import { buildLogContext, shadowDiff, logShadowDiff } from "../context/LogContextBuilder.js";

const USE_LOG_CONTEXT = !!process.env.USE_LOG_CONTEXT;
const SHADOW_MODE     = process.env.SHADOW_MODE !== "false"; // default true when USE_LOG_CONTEXT is on

/**
 * Build the /chat/completions path from a baseUrl.
 *
 * Callers pass the full baseUrl (e.g. "https://api.openai.com" or
 * "https://dashscope.aliyuncs.com/compatible-mode/v1"). We always want to
 * hit <root>/v1/chat/completions, so we only append "/v1" when the pathname
 * does not already end with it.
 *
 * Examples:
 *   "https://api.openai.com"                          → /v1/chat/completions
 *   "https://api.deepseek.com"                        → /v1/chat/completions
 *   "http://localhost:11434"                          → /v1/chat/completions
 *   "https://dashscope.aliyuncs.com/compatible-mode/v1" → /compatible-mode/v1/chat/completions
 *   "http://localhost:8080/api/v1"                    → /api/v1/chat/completions
 */
export function buildChatPath(baseUrl: string): string {
  const { pathname } = new URL(baseUrl);
  const base = pathname.replace(/\/?$/, ""); // strip trailing slash
  return base.endsWith("/v1")
    ? base + "/chat/completions"
    : base + "/v1/chat/completions";
}

export { parseAgentOutput, getFallbackCount, resetFallbackCount } from "../protocol/normalizer.js";

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
    depth?: number;
    providerCfg: ProviderConfig;
    systemPrompt?: string;
    resumeFrom?: string; // S3: agentId to resume messages from
    dispatch?: DispatchSpec; // S1: for Fork cache prefix reuse
    /** Pre-built history snapshot for forked PM' instances (takes priority over resumeFrom). */
    initialMessages?: Array<{ role: "user" | "assistant"; content: string }>;
  }) {
    super();
    // 如果 dispatch 携带 cachePrefix，初始化 _cachePrefix
    if (cfg.dispatch?.cachePrefix) {
      this._cachePrefix = cfg.dispatch.cachePrefix;
      this._cachePrefixSerialized = serializeCachePrefix(cfg.dispatch.cachePrefix);
      this._cacheDispatch = cfg.dispatch;
    }
    // Fork snapshot: directly inject history, skip file-based resume.
    if (cfg.initialMessages?.length) {
      this.messages = cfg.initialMessages.slice();
    } else if (cfg.resumeFrom) {
      const RESUME_CHAR_BUDGET = 60_000; // ≈ 15K tokens — leaves room for system prompt + new response
      const raw = loadMessages(cfg.resumeFrom);
      const all = raw.map((m) => ({ role: m.role, content: m.content }));
      const total = all.reduce((s, m) => s + m.content.length, 0);
      process.stderr.write(`[${cfg.id}] resume: loaded ${all.length} msgs (${total} chars) from "${cfg.resumeFrom}"\n`);
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

  /** Forward every "event" emission to the global bus (additive — existing listeners unaffected). */
  override emit(event: string, ...args: unknown[]): boolean {
    if (event === "event" && args.length === 1) {
      try { globalBus.publish(args[0] as TuiEvent); } catch { /* never block super.emit */ }
    }
    return super.emit(event, ...args);
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

  // ─── Fork / compaction helpers ─────────────────────────────────────────────

  /** Returns the system prompt string (used by forked PM' to share exact cache key). */
  getSystemPrompt(): string | undefined {
    return this.cfg.systemPrompt;
  }

  /** Returns a defensive copy of the in-memory message history. */
  getMessages(): Array<{ role: "user" | "assistant"; content: string }> {
    return this.messages.slice();
  }

  /**
   * Append entries to the in-memory message history.
   * Used to merge completed fork Q/As back into the base PM so subsequent
   * base PM turns can reference them.
   */
  appendHistory(entries: Array<{ role: "user" | "assistant"; content: string }>): void {
    this.messages.push(...entries);
  }

  /**
   * Trim a message array to fit within maxChars total content length.
   * Keeps the first message (initial task context) and always the last 4.
   * Exported static so index.tsx can call it without an agent instance.
   */
  static compactHistory(
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    maxChars: number,
  ): Array<{ role: "user" | "assistant"; content: string }> {
    let total = messages.reduce((s, m) => s + m.content.length, 0);
    if (total <= maxChars) return messages.slice();
    const result = [...messages];
    let i = 1; // keep index 0 (initial context)
    while (total > maxChars && i < result.length - 4) {
      total -= result[i]!.content.length;
      result.splice(i, 1);
    }
    return result;
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
    this._queue.length = 0; // drop all pending messages so drain doesn't restart it
    // If a send() is in progress, the user message was already pushed to this.messages
    // but will never get an assistant reply. Pop it so history stays alternating
    // user/assistant — otherwise the next send() creates two consecutive user messages
    // which Anthropic rejects with a 400 error.
    if (this._busy && this.messages.at(-1)?.role === "user") {
      this.messages.pop();
    }
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
    // Bug B fix: busy → enqueue, never silently drop.
    if (this._busy) { this._queue.push(text); return; }
    this._busy = true;
    this._abort = new AbortController();
    this.messages.push({ role: "user", content: text });
    // S2: notify SecretaryProxy for message persistence
    this.emit("_raw_message", { role: "user", content: text });

    // USE_LOG_CONTEXT shadow mode: build log-derived context and diff against this.messages.
    // In shadow mode (SHADOW_MODE=true, the default) only logs diffs — never changes behaviour.
    // When misses reach zero consistently, set SHADOW_MODE=false to let log context take over.
    if (USE_LOG_CONTEXT) {
      const newCtx = buildLogContext(this.cfg.id);
      if (newCtx) {
        const misses = shadowDiff(this.messages, newCtx);
        logShadowDiff(this.cfg.id, this._loopIdx, newCtx, misses);
        // Live mode: substitute this.messages with log projection.
        // Gated behind !SHADOW_MODE AND no gap — never switch on a known-incomplete context.
        if (!SHADOW_MODE && !newCtx.hasGap && newCtx.messages.length > 0) {
          // Replace everything except the system prompt (index 0 is never a user turn in our setup)
          // and the just-pushed user turn (last message).
          // The projection becomes message[0]; the new user turn stays at the end.
          const lastMsg = this.messages[this.messages.length - 1]!;
          this.messages = [...newCtx.messages, lastMsg];
          process.stderr.write(`[log-ctx] agent=${this.cfg.id} turn=${this._loopIdx} LIVE — replaced history with log projection (${newCtx.stats.deltaEventCount} delta events)\n`);
        }
      }
    }

    this.emit("event", {
      v: 1, type: "agent.state", agent: this.cfg.id,
      state: "run", sub: "thinking…",
    } as TuiEvent);

    const MAX_RETRIES = 3;
    let lastErr: any;
    let fullText = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let ttftMs = 0;
    let totalMs = 0;
    // Bug C fix: AbortError inside the retry loop previously returned early,
    // bypassing the outer finally and leaving _busy=true forever.
    // Solution: break out of the loop and let the outer try/finally handle cleanup.
    let abortedDuringRetry = false;

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
        const result = pc.provider === "anthropic"
          ? await this._callAnthropic()
          : await this._callOpenAI();
        fullText = result.text;
        promptTokens = result.promptTokens;
        completionTokens = result.completionTokens;
        ttftMs = result.ttftMs;
        totalMs = result.totalMs;
        lastErr = null;
        break; // success
      } catch (err: any) {
        if (err.name === "AbortError") {
          abortedDuringRetry = true;
          break; // exit loop → outer finally clears _busy and drains queue
        }
        lastErr = err;
        if (!HttpConvAgent._isRetryable(err) || attempt >= MAX_RETRIES) break;
      }
    }

    try {
      if (abortedDuringRetry) {
        // Emit idle so the UI returns to ready state — _busy is cleared in finally below.
        this.emit("event", {
          v: 1, type: "agent.state", agent: this.cfg.id,
          state: "idle", sub: "",
        } as TuiEvent);
        return;
      }
      if (lastErr) throw lastErr;

      this.messages.push({ role: "assistant", content: fullText });
      // S2: notify SecretaryProxy for message persistence
      this.emit("_raw_message", { role: "assistant", content: fullText });

      if (LOG) process.stderr.write(`[${this.cfg.id}] raw response:\n${fullText}\n---\n`);

      // Always emit token.usage so timing data is always available in the log.
      this.emit("event", {
        v: 1, type: "token.usage", agent: this.cfg.id,
        prompt: promptTokens, completion: completionTokens,
        ttft_ms: ttftMs, total_ms: totalMs,
      } as TuiEvent);

      // Delegate to the extracted pure parser (also exported for headless tests).
      parseAgentOutput(fullText, this.cfg.id, (ev) => {
        if (LOG) process.stderr.write(`[${this.cfg.id}] event: ${JSON.stringify(ev)}\n`);
        this.emit("event", ev);
      });

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
      // Drain one queued message per turn so worker reports land in order.
      //
      // IMPORTANT: the agent.state:idle event fires inside the try block,
      // BEFORE this finally runs. If the idle handler (in index.tsx) registers
      // a setImmediate for a nudge/tool-exec, that setImmediate is queued
      // BEFORE the one we register here. So by the time our drain setImmediate
      // fires, _busy may already be true again (the nudge send() got there first).
      //
      // Fix: check _busy inside the setImmediate; if busy, leave the item in
      // the queue — the nudge's own finally will schedule another drain.
      if (this._queue.length > 0) {
        setImmediate(() => {
          if (!this._busy && this._queue.length > 0) {
            const next = this._queue.shift()!;
            this.send(next);
          }
          // else: nudge preempted us — item stays in queue, next drain picks it up
        });
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

  private async _callAnthropic(): Promise<{ text: string; promptTokens: number; completionTokens: number; ttftMs: number; totalMs: number }> {
    const pc = this.cfg.providerCfg;
    let promptTokens = 0;
    let completionTokens = 0;
    let ttftMs = 0;

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
      max_tokens: pc.maxTokens ?? resolveMaxTokens(this.cfg.role, this.cfg.depth),
      ...(systemBlock ? { system: systemBlock } : {}),
      messages,
      stream: true,
    });

    const t0 = Date.now();
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

    const text = await this._readStream(stream, (chunk) => {
      // Anthropic SSE: data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
      try {
        const parsed = JSON.parse(chunk);
        // Capture input tokens from message_start
        if (parsed?.type === "message_start" && parsed.message?.usage) {
          promptTokens = parsed.message.usage.input_tokens ?? 0;
        }
        // Capture output tokens from message_delta
        if (parsed?.type === "message_delta" && parsed.usage) {
          completionTokens = parsed.usage.output_tokens ?? 0;
        }
        if (parsed?.type === "content_block_delta" && parsed.delta?.text) {
          const delta = parsed.delta.text;
          if (!ttftMs && delta) ttftMs = Date.now() - t0;
          return delta;
        }
      } catch { /* skip non-JSON */ }
      return null;
    });
    const totalMs = Date.now() - t0;
    return { text, promptTokens, completionTokens, ttftMs, totalMs };
  }

  private async _callOpenAI(): Promise<{ text: string; promptTokens: number; completionTokens: number; ttftMs: number; totalMs: number }> {
    const pc = this.cfg.providerCfg;
    let promptTokens = 0;
    let completionTokens = 0;
    let ttftMs = 0;
    const baseUrl = pc.baseUrl || "https://api.openai.com";
    const url = new URL(baseUrl);
    const port = url.port ? parseInt(url.port, 10) : undefined;
    const sysMsg = this.cfg.systemPrompt
      ? [{ role: "system" as const, content: this.cfg.systemPrompt }]
      : [];
    const body = JSON.stringify({
      model: pc.model,
      max_tokens: pc.maxTokens ?? resolveMaxTokens(this.cfg.role, this.cfg.depth),
      messages: [
        ...sysMsg,
        ...this._trimmedHistory().map((m) => ({ role: m.role, content: m.content })),
      ],
      stream: true,
      stream_options: { include_usage: true },
    });

    const t0 = Date.now();
    const stream = await this._doStream(
      url.hostname,
      "POST",
      buildChatPath(baseUrl),
      {
        "Authorization": `Bearer ${pc.apiKey}`,
        "content-type": "application/json",
      },
      body,
      port,
    );

    const text = await this._readStream(stream, (chunk) => {
      // OpenAI/DeepSeek SSE: data: {"choices":[{"delta":{"content":"...","reasoning_content":"..."}}]}
      // Reasoning models (deepseek-v4-flash, o1, etc.) stream thinking into reasoning_content
      // and the actual answer into content. We capture both: reasoning shown as step, content
      // accumulated as protocol output.
      if (chunk === "[DONE]") return null;
      try {
        const parsed = JSON.parse(chunk);
        // Capture usage from the final chunk (stream_options.include_usage)
        if (parsed?.usage) {
          promptTokens = parsed.usage.prompt_tokens ?? 0;
          completionTokens = parsed.usage.completion_tokens ?? 0;
        }
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
        const result = typeof content === "string" && content ? content : null;
        if (result && !ttftMs) ttftMs = Date.now() - t0;
        return result;
      } catch { return null; }
    });
    const totalMs = Date.now() - t0;
    return { text, promptTokens, completionTokens, ttftMs, totalMs };
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
