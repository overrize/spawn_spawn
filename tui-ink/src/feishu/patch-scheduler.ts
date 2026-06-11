// Per-card coalescing patch scheduler.
// Multiple concurrent agent deltas → at most one Feishu API call per RTT interval.
// Adaptive: measures real round-trip and never fires faster than the last observed RTT.

export class PatchScheduler {
  private dirty = false;
  private pending = false;
  private lastRtt = 350;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly flushFn: () => Promise<void>,
    private readonly fallbackFn?: () => Promise<void>,
  ) {}

  // Call after mutating task state — coalesces rapid calls into one patch
  schedule(): void {
    this.dirty = true;
    if (this.pending) return;
    this.pending = true;
    this.timer = setTimeout(() => void this.fire(), Math.max(this.lastRtt, 300));
  }

  // For terminal states (done/failed): cancel pending timer and fire immediately
  flush(): void {
    this.dirty = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    void this.fire();
  }

  private async fire(): Promise<void> {
    if (!this.dirty) { this.pending = false; return; }
    this.dirty = false;
    const t0 = Date.now();
    try {
      await this.flushFn();
      this.lastRtt = Date.now() - t0;
    } catch (err) {
      process.stderr.write(`[PatchScheduler] patch failed: ${err instanceof Error ? err.message : String(err)}\n`);
      try { await this.fallbackFn?.(); } catch { /* best-effort text fallback */ }
      this.pending = false;
      return;
    }
    // If new mutations arrived while we were in-flight, schedule the next fire
    if (this.dirty) {
      this.timer = setTimeout(() => void this.fire(), Math.max(this.lastRtt, 300));
    } else {
      this.pending = false;
    }
  }
}
