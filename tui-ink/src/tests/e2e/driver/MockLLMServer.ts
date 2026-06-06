/**
 * MockLLMServer — OpenAI-compatible SSE server for deterministic E2E tests.
 *
 * Usage:
 *   const mock = new MockLLMServer();
 *   const port = await mock.start();
 *   mock.enqueue({ agentId: "pm", events: [...] });
 *   // ... run TUI ...
 *   await mock.stop();
 *
 * Each call the TUI makes pops one scripted response from the queue.
 * Responses are matched by agentId (extracted from the system prompt).
 * agentId: null matches any agent — useful when you don't care which agent calls.
 */

import * as http from "node:http";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProtocolEvent = Record<string, unknown>;

export interface ScriptedResponse {
  /** Match by agent_id from system prompt. null = match any. */
  agentId: string | null;
  /**
   * Either a list of protocol events (auto-serialised to JSON Lines + SSE),
   * OR a raw string emitted verbatim as content — used for regression tests
   * (fences, <thinking>, inline-JSON).
   */
  events?: ProtocolEvent[];
  rawContent?: string;
  /** Milliseconds to pause between each event chunk. */
  delayMs?: number;
}

export interface MockCall {
  agentId: string | null;
  messageCount: number;
  ts: number;
}

// ── Server ────────────────────────────────────────────────────────────────────

export class MockLLMServer {
  private server: http.Server;
  private queue: ScriptedResponse[] = [];
  private _calls: MockCall[] = [];

  constructor() {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  /** Pre-load one or more responses in order. */
  enqueue(...responses: ScriptedResponse[]): void {
    this.queue.push(...responses);
  }

  /** Clear the queue and call log (call between tests). */
  reset(): void {
    this.queue = [];
    this._calls = [];
  }

  /** All calls received so far (for assertions). */
  get calls(): readonly MockCall[] { return this._calls; }

  async start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        resolve((this.server.address() as { port: number }).port);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.server.close((e) => (e ? reject(e) : resolve())),
    );
  }

  // ── Request handler ────────────────────────────────────────────────────────

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }

    // Read body
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");

    // Extract agent_id from system prompt
    let agentId: string | null = null;
    let messageCount = 0;
    try {
      const parsed = JSON.parse(body) as {
        messages?: Array<{ role: string; content: string }>;
      };
      const sys = parsed.messages?.find((m) => m.role === "system")?.content ?? "";
      agentId = sys.match(/\*\*agent_id\*\*:\s*`([^`]+)`/)?.[1] ?? null;
      messageCount = parsed.messages?.length ?? 0;
    } catch { /* ignore parse errors */ }

    this._calls.push({ agentId, messageCount, ts: Date.now() });

    // Pop matching scripted response
    const idx = this.queue.findIndex(
      (r) => r.agentId === null || r.agentId === agentId,
    );
    const scripted = idx >= 0 ? this.queue.splice(idx, 1)[0]! : this.fallback(agentId);

    // Stream SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Mock-Agent": agentId ?? "unknown",
    });

    if (scripted.rawContent !== undefined) {
      // Emit raw string verbatim — for regression tests
      this.sseChunk(res, scripted.rawContent);
    } else {
      for (const ev of scripted.events ?? []) {
        this.sseChunk(res, JSON.stringify(ev) + "\n");
        if (scripted.delayMs) await sleep(scripted.delayMs);
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  }

  private sseChunk(res: http.ServerResponse, content: string): void {
    const data = JSON.stringify({ choices: [{ delta: { content } }] });
    res.write(`data: ${data}\n\n`);
  }

  private fallback(agentId: string | null): ScriptedResponse {
    return {
      agentId,
      events: [
        { v: 1, type: "message", to: "user", text: `[mock] no script for agent "${agentId ?? "?"}"` },
        { v: 1, type: "agent.done", success: false, reason: "no mock script configured" },
      ],
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
