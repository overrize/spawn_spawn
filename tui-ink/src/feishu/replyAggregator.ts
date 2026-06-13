import { feishuLog } from './debug.js';

/**
 * Aggregates all message.to=user fragments from a single PM turn and sends
 * them as one Feishu message when the turn ends.
 *
 * Format routing:
 *  - format="text"     → sendBubble (sendTextMessage reply, one-shot, with ⏱ timing)
 *  - format="document" → sendCard   (existing CardRenderer flow, streaming-capable)
 *
 * The format is determined by the PM's message event. If any fragment in a turn
 * carries format="document", the whole turn is treated as document. Default is "text".
 *
 * Aggregation contract (same as before):
 *  - onChunk()   : called for every PM reply fragment; starts a debounce timer as
 *                  a fallback if onTurnEnd() is never called (e.g. crash)
 *  - onTurnEnd() : called by the idle/done handler; cancels debounce, flushes immediately
 *  - flush()     : sends accumulated text exactly once per turn; guarded by `sending` flag
 *  - reset()     : clears all state (used when PM session is rebuilt)
 */
export class FeishuReplyAggregator {
  private buffer: string[] = [];
  private sending = false;
  private flushTimer?: NodeJS.Timeout;
  private currentFormat: "text" | "document" = "text";

  constructor(
    /** Called when format="text" — sends a text bubble. */
    private readonly sendBubble: (text: string) => Promise<void>,
    /** Called when format="document" — routes to card renderer. */
    private readonly sendCard: (text: string) => Promise<void>,
    private readonly opts: { idleFlushMs?: number } = {},
  ) {}

  /** Called for each PM message.to=user fragment this turn. */
  onChunk(text: string, format?: "text" | "document"): void {
    if (!text) return;
    // Once a turn is marked document it stays document (cannot downgrade mid-turn).
    if (format === "document") this.currentFormat = "document";
    this.buffer.push(text);
    // Debounce fallback: flush automatically after idleFlushMs of silence.
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(
      () => { void this.flush("idle-timeout"); },
      this.opts.idleFlushMs ?? 600,
    );
  }

  /** Called when the PM turn definitively ends (agent.state:idle or feishuBusy unlock). */
  onTurnEnd(): void {
    clearTimeout(this.flushTimer);
    void this.flush("turn_end");
  }

  private async flush(reason: string): Promise<void> {
    if (this.sending) return;
    if (this.buffer.length === 0) return;
    this.sending = true;
    const text = this.buffer.join("\n").trim();
    const format = this.currentFormat;
    this.buffer = [];
    this.currentFormat = "text"; // reset for next turn
    try {
      if (text) {
        if (format === "document") await this.sendCard(text);
        else await this.sendBubble(text);
      }
    } catch (err) {
      feishuLog(
        `[ReplyAggregator] send failed (${reason}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.sending = false;
    }
  }

  /** Call when the PM agent is rebuilt (session reset) to discard stale state. */
  reset(): void {
    clearTimeout(this.flushTimer);
    this.buffer = [];
    this.sending = false;
    this.currentFormat = "text";
  }
}
