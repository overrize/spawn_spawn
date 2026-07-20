export type RuntimeRole = "base" | "fork";

export interface RuntimeMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AcceptedInput {
  conversationId: string;
  text: string;
  messageId: string;
}

export type RuntimeAction =
  | { type: "base_start"; conversationId: string; pmId: string; text: string; messageId: string }
  | { type: "fork_start"; conversationId: string; pmId: string; forkId: string; text: string; messageId: string; snapshot: RuntimeMessage[]; seq: number }
  | { type: "queued"; conversationId: string; text: string; messageId: string; queueLen: number }
  | { type: "buffer_flushed"; conversationId: string; pmId: string; at: "turn_end" | "pre_dispatch"; entries: RuntimeMessage[] }
  | { type: "fork_buffered"; conversationId: string; forkId: string; question: string; answer: string; seq: number }
  | { type: "fork_silent"; conversationId: string; forkId: string }
  | { type: "drain_noop"; conversationId: string; reason: "empty" | "at_capacity" }
  | { type: "base_complete"; conversationId: string; pmId: string; checkpoint: RuntimeMessage[] };

interface PendingMessage {
  text: string;
  messageId: string;
}

interface ForkRecord {
  conversationId: string;
  pmId: string;
  forkId: string;
  text: string;
  messageId: string;
  seq: number;
}

interface ForkBufferEntry {
  seq: number;
  messageId: string;
  question: string;
  answer: string;
}

export interface ConversationRuntimeOptions {
  maxConcurrent?: number;
  makeBasePmId?: (conversationId: string) => string;
  makeForkId?: (conversationId: string, seq: number) => string;
  compactHistory?: (messages: RuntimeMessage[]) => RuntimeMessage[];
  autoDrainOnComplete?: boolean;
}

export class ConversationRuntime {
  private readonly maxConcurrent: number;
  private readonly makeBasePmId: (conversationId: string) => string;
  private readonly makeForkId: (conversationId: string, seq: number) => string;
  private readonly compactHistory: (messages: RuntimeMessage[]) => RuntimeMessage[];
  private readonly autoDrainOnComplete: boolean;

  private readonly busy = new Set<string>();
  private readonly forks = new Map<string, Set<string>>();
  private readonly pending = new Map<string, PendingMessage[]>();
  private readonly checkpoints = new Map<string, RuntimeMessage[]>();
  private readonly forkBuffer = new Map<string, ForkBufferEntry[]>();
  private readonly forkRecords = new Map<string, ForkRecord>();
  private forkSeq = 0;

  constructor(opts: ConversationRuntimeOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? 3;
    this.makeBasePmId = opts.makeBasePmId ?? ((conversationId) => `pm:${conversationId}`);
    this.makeForkId = opts.makeForkId ?? ((_conversationId, seq) => `fork-${seq}`);
    this.compactHistory = opts.compactHistory ?? ((messages) => messages.slice());
    this.autoDrainOnComplete = opts.autoDrainOnComplete ?? true;
  }

  accept(input: AcceptedInput): RuntimeAction[] {
    return this.dispatch(input.conversationId, input.text, input.messageId);
  }

  completeFork(conversationId: string, forkId: string, answer: string): RuntimeAction[] {
    const actions: RuntimeAction[] = [];
    this.busy.delete(forkId);
    this.forks.get(conversationId)?.delete(forkId);
    if ((this.forks.get(conversationId)?.size ?? 0) === 0) this.forks.delete(conversationId);

    const record = this.forkRecords.get(forkId);
    if (record && answer) {
      const buffer = this.forkBuffer.get(conversationId) ?? [];
      buffer.push({
        seq: record.seq,
        messageId: record.messageId,
        question: record.text,
        answer,
      });
      this.forkBuffer.set(conversationId, buffer);
      actions.push({
        type: "fork_buffered",
        conversationId,
        forkId,
        question: record.text,
        answer,
        seq: record.seq,
      });
    } else {
      actions.push({ type: "fork_silent", conversationId, forkId });
    }

    if (this.autoDrainOnComplete) actions.push(...this.drain(conversationId));
    return actions;
  }

  completeBase(conversationId: string, finalMessages: RuntimeMessage[]): RuntimeAction[] {
    const pmId = this.makeBasePmId(conversationId);
    const actions: RuntimeAction[] = [];
    this.busy.delete(pmId);
    let checkpoint = finalMessages.slice();
    const flushed = this.flushForkBuffer(conversationId, pmId, "turn_end");
    if (flushed) {
      checkpoint = checkpoint.concat(flushed.entries);
      actions.push(flushed.action);
    }
    this.checkpoints.set(pmId, checkpoint);
    actions.push({ type: "base_complete", conversationId, pmId, checkpoint });
    if (this.autoDrainOnComplete) actions.push(...this.drain(conversationId));
    return actions;
  }

  getCheckpoint(pmId: string): RuntimeMessage[] {
    return (this.checkpoints.get(pmId) ?? []).slice();
  }

  getRunningCount(conversationId: string): number {
    const pmId = this.makeBasePmId(conversationId);
    return (this.busy.has(pmId) ? 1 : 0) + (this.forks.get(conversationId)?.size ?? 0);
  }

  getPendingCount(conversationId: string): number {
    return this.pending.get(conversationId)?.length ?? 0;
  }

  private dispatch(conversationId: string, text: string, messageId: string): RuntimeAction[] {
    const pmId = this.makeBasePmId(conversationId);
    if (this.busy.has(pmId)) {
      const forkCount = this.forks.get(conversationId)?.size ?? 0;
      if (forkCount < this.maxConcurrent - 1) {
        return [this.startFork(conversationId, pmId, text, messageId)];
      }
      const queue = this.pending.get(conversationId) ?? [];
      queue.push({ text, messageId });
      this.pending.set(conversationId, queue);
      return [{ type: "queued", conversationId, text, messageId, queueLen: queue.length }];
    }

    const actions: RuntimeAction[] = [];
    const flushed = this.flushForkBuffer(conversationId, pmId, "pre_dispatch");
    if (flushed) actions.push(flushed.action);
    this.busy.add(pmId);
    actions.push({ type: "base_start", conversationId, pmId, text, messageId });
    return actions;
  }

  private startFork(conversationId: string, pmId: string, text: string, messageId: string): RuntimeAction {
    const seq = ++this.forkSeq;
    const forkId = this.makeForkId(conversationId, seq);
    const snapshot = this.buildForkSnapshot(conversationId, pmId);
    const forks = this.forks.get(conversationId) ?? new Set<string>();
    forks.add(forkId);
    this.forks.set(conversationId, forks);
    this.busy.add(forkId);
    this.forkRecords.set(forkId, { conversationId, pmId, forkId, text, messageId, seq });
    return { type: "fork_start", conversationId, pmId, forkId, text, messageId, snapshot, seq };
  }

  private buildForkSnapshot(conversationId: string, pmId: string): RuntimeMessage[] {
    const checkpoint = this.checkpoints.get(pmId) ?? [];
    const buffered = this.sortedForkBuffer(conversationId).flatMap((entry) => [
      { role: "user" as const, content: entry.question },
      { role: "assistant" as const, content: entry.answer },
    ]);
    return this.compactHistory([...checkpoint, ...buffered]);
  }

  private drain(conversationId: string): RuntimeAction[] {
    const queue = this.pending.get(conversationId);
    if (!queue || queue.length === 0) {
      return [{ type: "drain_noop", conversationId, reason: "empty" }];
    }
    if (this.getRunningCount(conversationId) >= this.maxConcurrent) {
      return [{ type: "drain_noop", conversationId, reason: "at_capacity" }];
    }
    const next = queue.shift()!;
    return this.dispatch(conversationId, next.text, next.messageId);
  }

  private flushForkBuffer(
    conversationId: string,
    pmId: string,
    at: "turn_end" | "pre_dispatch",
  ): { entries: RuntimeMessage[]; action: RuntimeAction } | null {
    const entries = this.sortedForkBuffer(conversationId).flatMap((entry) => [
      { role: "user" as const, content: entry.question },
      { role: "assistant" as const, content: entry.answer },
    ]);
    if (entries.length === 0) return null;
    this.forkBuffer.delete(conversationId);
    if (at === "pre_dispatch") {
      const current = this.checkpoints.get(pmId) ?? [];
      this.checkpoints.set(pmId, current.concat(entries));
    }
    return {
      entries,
      action: { type: "buffer_flushed", conversationId, pmId, at, entries },
    };
  }

  private sortedForkBuffer(conversationId: string): ForkBufferEntry[] {
    return [...(this.forkBuffer.get(conversationId) ?? [])].sort((a, b) => a.seq - b.seq);
  }
}
