/**
 * MockLLMServer — minimal OpenAI-compatible SSE server for E2E tests.
 *
 * Usage:
 *   const srv = new MockLLMServer();
 *   const port = await srv.start();
 *   srv.enqueue('{"v":1,"type":"message",...}');   // next response body
 *   await agent.send("...");                        // HttpConvAgent will call mock
 *   await srv.stop();
 *
 * baseUrl to pass to ProviderConfig: `http://127.0.0.1:${port}`
 * (no trailing /v1 — HttpConvAgent appends it automatically)
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";

export class MockLLMServer {
  private server: Server;
  private queue: string[] = [];
  private callLog: { path: string; body: string }[] = [];
  port = 0;

  constructor() {
    this.server = createServer(this._handle.bind(this));
  }

  /** Queue the content (delta text) that the next request will receive. */
  enqueue(content: string): void {
    this.queue.push(content);
  }

  /** All requests received so far (for assertion in tests). */
  get calls(): ReadonlyArray<{ path: string; body: string }> {
    return this.callLog;
  }

  get callCount(): number { return this.callLog.length; }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address() as { port: number };
        this.port = addr.port;
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private _handle(req: IncomingMessage, res: ServerResponse): void {
    const path = req.url ?? "/";
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); });
    req.on("end", () => {
      this.callLog.push({ path, body });

      // Support both OpenAI chat completions and a health-check GET
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"status":"ok"}');
        return;
      }

      const content = this.queue.shift() ??
        `{"v":1,"type":"agent.done","success":true,"reason":"mock-default"}`;

      res.writeHead(200, {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
      });

      // Send content as one delta chunk
      const delta = JSON.stringify({
        id: "mock-cmp",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
      });
      res.write(`data: ${delta}\n\n`);

      // Final chunk with usage + finish_reason
      const final = JSON.stringify({
        id: "mock-cmp",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 80, completion_tokens: 40 },
      });
      res.write(`data: ${final}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  }
}
