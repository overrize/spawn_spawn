/**
 * Aggregates all message.to=user fragments from a single PM turn and sends
 * them as one Feishu message when the turn ends.
 *
 * Motivation: a PM turn may produce multiple message.to=user events (one per
 * protocol-fallback line when PM outputs bare Markdown).  Without aggregation
 * each fragment triggers its own card-update chain, producing N duplicate
 * sends per turn.
 *
 * Design:
 *  - onChunk()   : called for every PM reply fragment; starts a debounce timer
 *                  as a fallback if onTurnEnd() is never called (e.g. crash)
 *  - onTurnEnd() : called by the idle/done handler; cancels debounce, flushes
 *                  immediately
 *  - flush()     : sends accumulated text exactly once per turn; guarded by
 *                  `sending` flag so concurrent callers never double-send
 *  - reset()     : used when the PM session is rebuilt; clears all state so
 *                  no stale buffer leaks into the next session
 *
 * finally guarantee: the `sending` flag is always cleared in a finally block
 * so a failed send never leaves the aggregator locked for subsequent turns.
 */
export class FeishuReplyAggregator {
  private buffer: string[] = [];
  private sending = false;
  private flushTimer?: NodeJS.Timeout;

  constructor(
    private readonly send: (text: string) => Promise<void>,
    private readonly opts: { idleFlushMs?: number } = {},
  ) {}

  /** Called for each PM message.to=user fragment this turn. */
  onChunk(text: string): void {
    if (!text) return;
    this.buffer.push(text);
    // Debounce fallback: if onTurnEnd() is never called (e.g. agent crash),
    // flush automatically after idleFlushMs of silence.
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
    if (this.sending) return;          // re-entrance guard: one send per turn
    if (this.buffer.length === 0) return;
    this.sending = true;
    const text = this.buffer.join("\n").trim();
    this.buffer = [];                  // clear immediately — never re-send on retry
    try {
      if (text) await this.send(text);
    } catch (err) {
      process.stderr.write(
        `[ReplyAggregator] send failed (${reason}): ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
      // Do not re-try: stale partial content is worse than silence.
    } finally {
      this.sending = false;            // always release — never blocks subsequent turns
    }
  }

  /** Call when the PM agent is rebuilt (session reset) to discard stale state. */
  reset(): void {
    clearTimeout(this.flushTimer);
    this.buffer = [];
    this.sending = false;
  }
}
