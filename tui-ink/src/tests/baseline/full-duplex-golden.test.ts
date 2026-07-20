/**
 * Golden baseline for the current full-duplex Feishu/session behavior.
 *
 * This file is intentionally a snapshot of today's behavior, not a statement
 * of ideal behavior. If future refactors change these timelines, the change
 * must be reviewed as either an unintended regression or an explicit behavior
 * change documented in docs/architecture-baseline.md.
 *
 * No real Feishu API, TUI process, or LLM is used here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

type Msg = { role: "user" | "assistant"; content: string };

type TimelineEvent =
  | { type: "input.empty_skipped"; openId: string; messageId: string }
  | { type: "input.duplicate_skipped"; openId: string; messageId: string }
  | { type: "input.accepted"; openId: string; messageId: string; text: string }
  | { type: "base.direct"; pmId: string; text: string }
  | { type: "fork.started"; forkId: string; text: string; snapshot: string[] }
  | { type: "pending.queued"; openId: string; text: string; queueLen: number }
  | { type: "fork.buffered"; forkId: string; question: string; answer: string; seq: number }
  | { type: "fork.silent_not_buffered"; forkId: string }
  | { type: "drain.noop"; openId: string; reason: "empty" | "at_capacity" }
  | { type: "base.flush_buffer"; pmId: string; entries: string[]; at: "turn_end" | "pre_dispatch" }
  | { type: "base.complete"; pmId: string; checkpoint: string[] };

interface PendingMsg {
  text: string;
  messageId: string;
}

interface ForkRecord {
  forkId: string;
  openId: string;
  question: string;
  messageId: string;
  seq: number;
  snapshot: Msg[];
}

class FullDuplexBaselineHarness {
  readonly events: TimelineEvent[] = [];
  readonly busy = new Set<string>();
  readonly forks = new Map<string, Set<string>>();
  readonly pending = new Map<string, PendingMsg[]>();
  readonly checkpoints = new Map<string, Msg[]>();
  readonly forkBuffer = new Map<string, Array<{
    seq: number;
    messageId: string;
    question: string;
    answer: string;
  }>>();

  private readonly recent = new Map<string, { text: string; time: number }>();
  private forkCounter = 0;
  private arrivalSeq = 0;
  private now = 1_000;

  constructor(private readonly maxConcurrent = 3) {}

  receive(openId: string, text: string, messageId: string): void {
    if (!text.trim()) {
      this.events.push({ type: "input.empty_skipped", openId, messageId });
      return;
    }

    const recent = this.recent.get(openId);
    if (recent && recent.text === text && this.now - recent.time < 5_000) {
      this.events.push({ type: "input.duplicate_skipped", openId, messageId });
      this.now += 100;
      return;
    }

    this.recent.set(openId, { text, time: this.now });
    this.now += 100;
    this.events.push({ type: "input.accepted", openId, messageId, text });
    this.dispatch(openId, text, messageId);
  }

  completeFork(openId: string, forkId: string, answer: string): void {
    this.busy.delete(forkId);
    this.forks.get(openId)?.delete(forkId);
    if ((this.forks.get(openId)?.size ?? 0) === 0) this.forks.delete(openId);

    const record = this.findFork(forkId);
    if (record && answer) {
      const buf = this.forkBuffer.get(openId) ?? [];
      buf.push({
        seq: record.seq,
        messageId: record.messageId,
        question: record.question,
        answer,
      });
      this.forkBuffer.set(openId, buf);
      this.events.push({
        type: "fork.buffered",
        forkId,
        question: record.question,
        answer,
        seq: record.seq,
      });
    } else {
      this.events.push({ type: "fork.silent_not_buffered", forkId });
    }

    this.drain(openId);
  }

  completeBase(openId: string, finalMessages: Msg[]): void {
    const pmId = this.pmId(openId);
    this.busy.delete(pmId);
    let cleanHistory = finalMessages.slice();
    const flushed = this.flushForkBuffer(openId, pmId, "turn_end");
    if (flushed.length > 0) {
      cleanHistory = cleanHistory.concat(flushed);
    }
    this.checkpoints.set(pmId, cleanHistory);
    this.events.push({
      type: "base.complete",
      pmId,
      checkpoint: cleanHistory.map((m) => m.content),
    });
    this.drain(openId);
  }

  private readonly forkLog: ForkRecord[] = [];

  private dispatch(openId: string, text: string, messageId: string): void {
    const pmId = this.pmId(openId);
    if (this.busy.has(pmId)) {
      const forkCount = this.forks.get(openId)?.size ?? 0;
      if (forkCount < this.maxConcurrent - 1) {
        this.startFork(openId, text, messageId);
        return;
      }
      const q = this.pending.get(openId) ?? [];
      q.push({ text, messageId });
      this.pending.set(openId, q);
      this.events.push({ type: "pending.queued", openId, text, queueLen: q.length });
      return;
    }

    this.flushForkBuffer(openId, pmId, "pre_dispatch");
    this.busy.add(pmId);
    this.events.push({ type: "base.direct", pmId, text });
  }

  private startFork(openId: string, text: string, messageId: string): void {
    const pmId = this.pmId(openId);
    const rawCheckpoint = this.checkpoints.get(pmId) ?? [];
    const buffered = this.forkBuffer.get(openId) ?? [];
    const bufferedMessages = [...buffered]
      .sort((a, b) => a.seq - b.seq)
      .flatMap((entry) => [
        { role: "user" as const, content: entry.question },
        { role: "assistant" as const, content: entry.answer },
      ]);
    const snapshot = rawCheckpoint.concat(bufferedMessages);
    const forkId = `fork-${++this.forkCounter}`;
    const seq = ++this.arrivalSeq;
    const forks = this.forks.get(openId) ?? new Set<string>();
    forks.add(forkId);
    this.forks.set(openId, forks);
    this.busy.add(forkId);
    this.forkLog.push({ forkId, openId, question: text, messageId, seq, snapshot });
    this.events.push({
      type: "fork.started",
      forkId,
      text,
      snapshot: snapshot.map((m) => m.content),
    });
  }

  private drain(openId: string): void {
    const q = this.pending.get(openId);
    if (!q || q.length === 0) {
      this.events.push({ type: "drain.noop", openId, reason: "empty" });
      return;
    }
    const pmId = this.pmId(openId);
    const running = (this.busy.has(pmId) ? 1 : 0) + (this.forks.get(openId)?.size ?? 0);
    if (running >= this.maxConcurrent) {
      this.events.push({ type: "drain.noop", openId, reason: "at_capacity" });
      return;
    }
    const next = q.shift()!;
    this.dispatch(openId, next.text, next.messageId);
  }

  private flushForkBuffer(openId: string, pmId: string, at: "turn_end" | "pre_dispatch"): Msg[] {
    const buf = this.forkBuffer.get(openId);
    if (!buf || buf.length === 0) return [];
    const entries = [...buf]
      .sort((a, b) => a.seq - b.seq)
      .flatMap((entry) => [
        { role: "user" as const, content: entry.question },
        { role: "assistant" as const, content: entry.answer },
      ]);
    this.forkBuffer.delete(openId);
    this.events.push({
      type: "base.flush_buffer",
      pmId,
      entries: entries.map((m) => m.content),
      at,
    });
    if (at === "pre_dispatch") {
      const current = this.checkpoints.get(pmId) ?? [];
      this.checkpoints.set(pmId, current.concat(entries));
    }
    return entries;
  }

  private findFork(forkId: string): ForkRecord | undefined {
    return this.forkLog.find((fork) => fork.forkId === forkId);
  }

  private pmId(openId: string): string {
    return `pm:${openId}`;
  }
}

class TerminalDeliveryGuard {
  readonly events: Array<{ type: string; agent: string; id?: string; reason?: string }> = [];
  private readonly done = new Set<string>();
  private readonly killed = new Set<string>();

  markDone(agent: string): void {
    this.done.add(agent);
    this.events.push({ type: "agent.done", agent });
  }

  markKilled(agent: string): void {
    this.killed.add(agent);
    this.events.push({ type: "agent.killed", agent });
  }

  deliverToolResult(agent: string, id: string): void {
    if (this.done.has(agent) || this.killed.has(agent)) {
      this.events.push({ type: "tool.result.dropped", agent, id, reason: "terminal" });
      return;
    }
    this.events.push({ type: "tool.result.delivered", agent, id });
  }
}

describe("full-duplex golden baseline", () => {
  it("records current direct/fork/queue/drain/merge event sequence", () => {
    const h = new FullDuplexBaselineHarness(3);
    const openId = "user-a";

    h.receive(openId, "Q1 base", "msg-1");
    h.receive(openId, "Q2 fork", "msg-2");
    h.receive(openId, "Q3 fork", "msg-3");
    h.receive(openId, "Q4 queued", "msg-4");

    h.completeFork(openId, "fork-2", "A3 first");
    h.completeFork(openId, "fork-1", "A2 second");
    h.completeBase(openId, [
      { role: "user", content: "Q1 base" },
      { role: "assistant", content: "A1 base" },
    ]);

    assert.deepEqual(h.events, [
      { type: "input.accepted", openId, messageId: "msg-1", text: "Q1 base" },
      { type: "base.direct", pmId: "pm:user-a", text: "Q1 base" },
      { type: "input.accepted", openId, messageId: "msg-2", text: "Q2 fork" },
      { type: "fork.started", forkId: "fork-1", text: "Q2 fork", snapshot: [] },
      { type: "input.accepted", openId, messageId: "msg-3", text: "Q3 fork" },
      { type: "fork.started", forkId: "fork-2", text: "Q3 fork", snapshot: [] },
      { type: "input.accepted", openId, messageId: "msg-4", text: "Q4 queued" },
      { type: "pending.queued", openId, text: "Q4 queued", queueLen: 1 },
      { type: "fork.buffered", forkId: "fork-2", question: "Q3 fork", answer: "A3 first", seq: 2 },
      { type: "fork.started", forkId: "fork-3", text: "Q4 queued", snapshot: ["Q3 fork", "A3 first"] },
      { type: "fork.buffered", forkId: "fork-1", question: "Q2 fork", answer: "A2 second", seq: 1 },
      { type: "drain.noop", openId, reason: "empty" },
      {
        type: "base.flush_buffer",
        pmId: "pm:user-a",
        entries: ["Q2 fork", "A2 second", "Q3 fork", "A3 first"],
        at: "turn_end",
      },
      {
        type: "base.complete",
        pmId: "pm:user-a",
        checkpoint: ["Q1 base", "A1 base", "Q2 fork", "A2 second", "Q3 fork", "A3 first"],
      },
      { type: "drain.noop", openId, reason: "empty" },
    ] satisfies TimelineEvent[]);
  });

  it("records current pre-dispatch fork-buffer flush before the next base turn", () => {
    const h = new FullDuplexBaselineHarness(3);
    const openId = "user-b";

    h.receive(openId, "Q1 base", "msg-1");
    h.receive(openId, "Q2 fork", "msg-2");
    h.completeBase(openId, [
      { role: "user", content: "Q1 base" },
      { role: "assistant", content: "A1 base" },
    ]);
    h.completeFork(openId, "fork-1", "A2 late");
    h.receive(openId, "Q3 base", "msg-3");

    assert.deepEqual(h.events, [
      { type: "input.accepted", openId, messageId: "msg-1", text: "Q1 base" },
      { type: "base.direct", pmId: "pm:user-b", text: "Q1 base" },
      { type: "input.accepted", openId, messageId: "msg-2", text: "Q2 fork" },
      { type: "fork.started", forkId: "fork-1", text: "Q2 fork", snapshot: [] },
      {
        type: "base.complete",
        pmId: "pm:user-b",
        checkpoint: ["Q1 base", "A1 base"],
      },
      { type: "drain.noop", openId, reason: "empty" },
      { type: "fork.buffered", forkId: "fork-1", question: "Q2 fork", answer: "A2 late", seq: 1 },
      { type: "drain.noop", openId, reason: "empty" },
      { type: "input.accepted", openId, messageId: "msg-3", text: "Q3 base" },
      {
        type: "base.flush_buffer",
        pmId: "pm:user-b",
        entries: ["Q2 fork", "A2 late"],
        at: "pre_dispatch",
      },
      { type: "base.direct", pmId: "pm:user-b", text: "Q3 base" },
    ] satisfies TimelineEvent[]);
  });

  it("records current empty-message and short-window duplicate handling", () => {
    const h = new FullDuplexBaselineHarness(3);
    const openId = "user-c";

    h.receive(openId, "   ", "msg-empty");
    h.receive(openId, "same text", "msg-1");
    h.receive(openId, "same text", "msg-2");

    assert.deepEqual(h.events, [
      { type: "input.empty_skipped", openId, messageId: "msg-empty" },
      { type: "input.accepted", openId, messageId: "msg-1", text: "same text" },
      { type: "base.direct", pmId: "pm:user-c", text: "same text" },
      { type: "input.duplicate_skipped", openId, messageId: "msg-2" },
    ] satisfies TimelineEvent[]);
  });

  it("records current terminal guard for late tool results", () => {
    const guard = new TerminalDeliveryGuard();

    guard.deliverToolResult("worker-live", "tool-1");
    guard.markDone("worker-done");
    guard.deliverToolResult("worker-done", "tool-2");
    guard.markKilled("worker-killed");
    guard.deliverToolResult("worker-killed", "tool-3");

    assert.deepEqual(guard.events, [
      { type: "tool.result.delivered", agent: "worker-live", id: "tool-1" },
      { type: "agent.done", agent: "worker-done" },
      { type: "tool.result.dropped", agent: "worker-done", id: "tool-2", reason: "terminal" },
      { type: "agent.killed", agent: "worker-killed" },
      { type: "tool.result.dropped", agent: "worker-killed", id: "tool-3", reason: "terminal" },
    ]);
  });
});
