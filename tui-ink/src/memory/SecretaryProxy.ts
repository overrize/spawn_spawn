// SecretaryProxy — TypeScript 实现的内存管理员
// 订阅 agent event stream，自动维护 .spawn/memory/<agent_id>.json
// 不是 LLM，不消耗 token，只做确定性的记录工作

import { EventEmitter } from "node:events";
import type { TuiEvent } from "../protocol.js";
import type { AgentMemory, MemoryFact, MemoryDecision } from "./types.js";
import { saveMemory, appendMessage, appendReminder, startSession, topFactsByWeight } from "./MemoryStore.js";

const DECISION_KEYWORDS = /应该|决定|选择|采用|方案|确认|将要|采取|should|decided|chosen|use|using|will\s/i;
const TIME_KEYWORDS = /下午|上午|晚上|早上|明天|后天|今天|[0-9]+[:：][0-9]+|[0-9]+\s*点|pm\b|am\b/i;

export class SecretaryProxy extends EventEmitter {
  private memory: AgentMemory;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private factSeq: number;
  private decisionSeq: number;
  private destroyed = false;
  // Accept btw messages addressed to "<id>-secretary" as well as "<id>"
  private readonly secretaryAlias: string;

  constructor(memory: AgentMemory) {
    super();
    this.memory = memory;
    // Resume: init seqs from existing data to avoid ID collisions
    this.factSeq = memory.working_set.facts.length;
    this.decisionSeq = memory.working_set.decisions.length;
    this.secretaryAlias = `${memory.agent_id}-secretary`;
    // Persist initial state + register new session entry
    saveMemory(memory.agent_id, memory);
    startSession(memory.agent_id, memory.session_hash ?? "unknown");

    // 60s periodic snapshot —防止崩溃时丢失进度
    this.snapshotTimer = setInterval(() => {
      if (!this.destroyed) this.flushSync();
    }, 60_000);
    this.snapshotTimer.unref();
  }

  get agentId(): string { return this.memory.agent_id; }

  /** 观察 agent 发出的 TuiEvent，按规则更新 memory */
  observe(ev: TuiEvent): void {
    if (this.destroyed) return;
    const id = this.memory.agent_id;

    switch (ev.type) {
      case "tool.result":
        if (ev.agent === id && ev.ok) {
          this.addFact({
            id: `f${++this.factSeq}`,
            text: ev.output.slice(0, 200),
            src: `tool:${ev.id}`,
            ts: Date.now(),
          });
        }
        break;

      case "message":
        if (ev.agent === id) {
          if (DECISION_KEYWORDS.test(ev.text)) {
            this.addDecision({
              id: `d${++this.decisionSeq}`,
              text: ev.text.slice(0, 300),
              rationale: "",
              ts: Date.now(),
            });
          }
        }
        // btw 消息：leader 可以发到 "<id>" 或 "<id>-secretary"
        if ((ev.to === id || ev.to === this.secretaryAlias) && ev.text.startsWith("btw:")) {
          this.handleBtw(ev.text.slice(4).trim());
        }
        break;

      case "todo.set":
        if (ev.agent === id) {
          // 记录完成的 todo 项到 decisions
          for (const item of ev.items) {
            if (item.state === "done") {
              this.addDecision({
                id: `d${++this.decisionSeq}`,
                text: `已完成: ${item.text}`,
                rationale: "todo done",
                ts: Date.now(),
              });
            }
          }
          // 保存最后 todo 状态，供 resume 注入
          this.memory.tombstone.last_todo = JSON.stringify(ev.items);
        }
        break;

      case "unit.handup":
        if (ev.agent === id) {
          // 把 Worker 上报的 facts_to_promote 提升到本 agent 的 working_set
          const promoted = (ev as any).facts_to_promote as string[] | undefined;
          for (const text of promoted ?? []) {
            this.addFact({
              id: `f${++this.factSeq}`,
              text,
              src: `handup:${ev.agent}`,
              ts: Date.now(),
            });
          }
        }
        break;

      case "spawn":
        if (ev.parent === id) {
          // 在 child_handles 里记录新的子节点
          this.memory.child_handles.push({
            agent_id: ev.child,
            status: "running",
            goal: ev.goal,
            handup: null,
          });
          this.saveAsync();
        }
        break;

      case "agent.done":
        if (ev.agent === id) {
          this.memory.tombstone.final_status = ev.success ? "done" : "error";
          const recentFacts = this.memory.working_set.facts
            .slice(-5)
            .map((f) => f.text)
            .join("; ");
          this.memory.tombstone.compact_summary =
            `${ev.reason ?? (ev.success ? "done" : "failed")} | ${recentFacts}`.slice(0, 500);
          this.memory.tombstone.resume_hint = null;
          this.flushSync();
          this.stopTimer();
          // 通知 TUI 已写入快照
          this.emit("event", {
            v: 1,
            type: "memory.snapshot",
            agent: id,
            path: `.spawn/memory/${id}.json`,
            size_kb: Math.round(JSON.stringify(this.memory).length / 1024 * 10) / 10,
          } as TuiEvent);
        }
        // 更新 parent 的 child_handles
        {
          const handle = this.memory.child_handles.find((h) => h.agent_id === ev.agent);
          if (handle) {
            handle.status = ev.success ? "done" : "error";
            this.saveAsync();
          }
        }
        break;

      case "agent.error":
        if (ev.agent === id) {
          this.memory.tombstone.final_status = "error";
          this.memory.tombstone.compact_summary =
            `Error: ${ev.code}${ev.detail ? " - " + ev.detail : ""}`.slice(0, 300);
          this.flushSync();
        }
        break;
    }
  }

  /** httpAgent 每次 send() 完成后调用 — 持久化对话记录 */
  observeMessage(role: "user" | "assistant", content: string): void {
    if (this.destroyed) return;
    appendMessage(this.memory.agent_id, { role, content, ts: Date.now() });
    // 更新 resume hint — assistant turns are raw protocol JSON, extract prose only
    if (role === "assistant") {
      const prose = content.split("\n")
        .filter((l) => !l.trim().startsWith("{"))
        .join(" ")
        .trim()
        .slice(0, 120);
      this.memory.tombstone.resume_hint = prose
        ? `Last assistant: ${prose}`
        : "Last assistant: (protocol-only turn)";
    } else {
      this.memory.tombstone.resume_hint = `Last user: ${content.slice(0, 120)}`;
    }
    this.memory.updated_at = Date.now();
  }

  getMemory(): Readonly<AgentMemory> { return this.memory; }

  /**
   * PM-Secretary calls this when a child Leader (Tech Lead) completes.
   * Pulls the TL's top facts/decisions up into PM's working_set so PM
   * has cross-task context without reading every child file.
   */
  ingestChildMemory(childMem: AgentMemory): void {
    if (this.destroyed) return;
    for (const f of topFactsByWeight(childMem, 5)) {
      this.addFact({
        id: `f${++this.factSeq}`,
        text: `[${childMem.agent_id}] ${f.text}`,
        src: `handup:${childMem.agent_id}`,
        ts: Date.now(),
      });
    }
    for (const d of childMem.working_set.decisions.slice(-3)) {
      this.addDecision({
        id: `d${++this.decisionSeq}`,
        text: `[${childMem.agent_id}] ${d.text}`,
        rationale: d.rationale,
        ts: Date.now(),
      });
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.stopTimer();
  }

  // ── private ────────────────────────────────────────────────────────────────

  private handleBtw(text: string): void {
    this.addFact({
      id: `f${++this.factSeq}`,
      text: `[btw] ${text}`,
      src: "btw:user",
      ts: Date.now(),
    });
    if (TIME_KEYWORDS.test(text)) {
      appendReminder(text, Date.now());
    }
  }

  /** Jaccard similarity between two strings (token-level) */
  private jaccard(a: string, b: string): number {
    const tokenize = (s: string) => new Set(s.toLowerCase().split(/\s+/).filter(Boolean));
    const sa = tokenize(a);
    const sb = tokenize(b);
    if (sa.size === 0 && sb.size === 0) return 1;
    let intersect = 0;
    for (const t of sa) { if (sb.has(t)) intersect++; }
    const union = sa.size + sb.size - intersect;
    return union === 0 ? 0 : intersect / union;
  }

  private addFact(fact: MemoryFact): void {
    const facts = this.memory.working_set.facts;
    // 0.72: high enough to avoid false merges on CJK text (common words inflate 0.6 too easily)
    const SIMILARITY_THRESHOLD = 0.72;
    const now = Date.now();

    // Look for a similar existing fact
    let merged = false;
    for (let i = 0; i < facts.length; i++) {
      const existing = facts[i];
      if (this.jaccard(existing.text, fact.text) >= SIMILARITY_THRESHOLD) {
        // Merge: bump weight, update text to the longer one, refresh ts
        const newWeight = (existing.weight ?? 1) + (fact.weight ?? 1);
        existing.weight = newWeight;
        if (fact.text.length > existing.text.length) {
          existing.text = fact.text;
        }
        existing.ts = now;
        merged = true;
        break;
      }
    }

    if (!merged) {
      facts.push({ ...fact, weight: fact.weight ?? 1 });
    }
    this.gc();
    this.saveAsync();
  }

  private addDecision(d: MemoryDecision): void {
    this.memory.working_set.decisions.push(d);
    this.saveAsync();
  }

  private gc(): void {
    const facts = this.memory.working_set.facts;
    if (facts.length <= 50) return;
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = facts.filter((f) => f.ts > cutoff);
    // 保留至少 20 条，丢弃最旧的重复 src
    this.memory.working_set.facts = recent.length < 20
      ? facts.slice(-50)
      : recent.slice(-50);
  }

  private saveAsync(): void {
    this.memory.updated_at = Date.now();
    setImmediate(() => {
      if (!this.destroyed) saveMemory(this.memory.agent_id, this.memory);
    });
  }

  private flushSync(): void {
    this.memory.updated_at = Date.now();
    saveMemory(this.memory.agent_id, this.memory);
  }

  private stopTimer(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }
}
