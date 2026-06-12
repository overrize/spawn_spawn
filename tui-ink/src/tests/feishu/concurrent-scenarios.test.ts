/**
 * Phase B/C concurrent dispatch scenarios — 7 comprehensive test cases.
 *
 * Uses a self-contained simulation harness that mirrors the actual state maps
 * (feishuBusy, feishuForks, feishuPendingQueue, feishuCheckpoints) without
 * touching real Feishu APIs or LLM endpoints.
 *
 * Scenario 1 tests the FeishuInputWindowManager directly with a tiny window (30ms).
 * Scenarios 2–7 test the dispatch/drain routing logic in isolation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HttpConvAgent } from "../../adapters/httpAgent.js";
import { FeishuInputWindowManager } from "../../feishu/input-window.js";

// ── Shared simulation harness ─────────────────────────────────────────────────

interface Msg { role: "user" | "assistant"; content: string }
interface PendingMsg { text: string; anchorMsgId: string }

interface ForkRecord {
  forkId: string;
  openId: string;
  text: string;
  initialMessages: Msg[];
}

function makeSimulator(maxConcurrent = 3) {
  const feishuBusy   = new Set<string>();
  const feishuForks  = new Map<string, Set<string>>();
  const pendingQueue = new Map<string, PendingMsg[]>();
  const checkpoints  = new Map<string, Msg[]>(); // pmId → last clean history
  const forkLog: ForkRecord[] = [];
  let forkSeq = 0;

  // Mirror of HttpConvAgent.compactHistory — kept local so the test has no side effects
  const compact = (msgs: Msg[], maxChars: number): Msg[] => {
    let total = msgs.reduce((s, m) => s + m.content.length, 0);
    if (total <= maxChars) return msgs.slice();
    const result = [...msgs];
    let i = 1;
    while (total > maxChars && i < result.length - 4) {
      total -= result[i]!.content.length;
      result.splice(i, 1);
    }
    return result;
  };

  // dispatch: mirrors connectFeishu's dispatchMessage routing logic
  const dispatch = (
    openId: string,
    basePmId: string,
    text: string,
    anchorMsgId = "msg-x",
  ): { type: "direct" | "forked" | "queued"; forkId?: string; queueLen?: number } => {
    if (feishuBusy.has(basePmId)) {
      const forkCount = feishuForks.get(openId)?.size ?? 0;
      if (forkCount < maxConcurrent - 1) {
        const forkId = `fork-${++forkSeq}`;
        // Bug 1 fix: use checkpoint, not live messages
        const rawCheckpoint = checkpoints.get(basePmId) ?? [];
        const initialMessages = compact(rawCheckpoint, 40_000);
        const forks = feishuForks.get(openId) ?? new Set<string>();
        forks.add(forkId);
        feishuForks.set(openId, forks);
        feishuBusy.add(forkId);
        forkLog.push({ forkId, openId, text, initialMessages });
        return { type: "forked", forkId };
      }
      const q = pendingQueue.get(openId) ?? [];
      q.push({ text, anchorMsgId });
      pendingQueue.set(openId, q);
      return { type: "queued", queueLen: q.length };
    }
    feishuBusy.add(basePmId);
    return { type: "direct" };
  };

  // drain: mirrors connectFeishu's drainPendingQueue
  const drain = (openId: string, basePmId: string): void => {
    const q = pendingQueue.get(openId);
    if (!q || q.length === 0) return;
    const forkCount = feishuForks.get(openId)?.size ?? 0;
    const baseBusy  = feishuBusy.has(basePmId);
    const total     = (baseBusy ? 1 : 0) + forkCount;
    if (total >= maxConcurrent) return;
    const next = q.shift()!;
    dispatch(openId, basePmId, next.text, next.anchorMsgId);
  };

  // completeFork: mirrors fork's turnEndHook
  const completeFork = (openId: string, forkId: string, basePmId: string): void => {
    feishuBusy.delete(forkId);
    feishuForks.get(openId)?.delete(forkId);
    if ((feishuForks.get(openId)?.size ?? 0) === 0) feishuForks.delete(openId);
    drain(openId, basePmId);
  };

  // completeBase: mirrors base PM's turnEndHook (Bug 2 fix: delete busy BEFORE draining)
  const completeBase = (openId: string, basePmId: string, finalMessages: Msg[]): void => {
    feishuBusy.delete(basePmId);                // Bug 2 fix: pre-clear before drain
    checkpoints.set(basePmId, finalMessages);   // Bug 1 fix: save clean checkpoint
    drain(openId, basePmId);
  };

  return {
    dispatch, drain, completeFork, completeBase,
    feishuBusy, feishuForks, pendingQueue, checkpoints, forkLog,
  };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Scenario tests ─────────────────────────────────────────────────────────────

describe("Phase B/C — concurrent scenarios (simulation)", () => {

  // ── Scenario 1: Fragment merging via input window ─────────────────────────
  it("场景1 碎片合并: 1500ms 内连发 3 条 → 只 1 次 dispatch, 文本合并", async () => {
    const WIN = 30; // ms — small so test runs fast
    const dispatched: Array<{ text: string; anchor: string }> = [];
    const mgr = new FeishuInputWindowManager(WIN, (_, text, anchor) => {
      dispatched.push({ text, anchor });
    });

    mgr.feed("u1", "I2C", "msg-1", "chat1", "p2p");
    await wait(10);
    mgr.feed("u1", "总线", "msg-2", "chat1", "p2p");
    await wait(10);
    mgr.feed("u1", "挂死", "msg-3", "chat1", "p2p");
    // window opens after last fragment
    await wait(WIN + 20);

    assert.equal(dispatched.length, 1, "exactly 1 dispatch after merge");
    assert.equal(dispatched[0]!.text, "I2C\n总线\n挂死");
    assert.equal(dispatched[0]!.anchor, "msg-1", "anchor = first fragment's msgId");
  });

  // ── Scenario 2: Concurrent fork when base is busy ────────────────────────
  it("场景2 并发开 fork: base busy 时发 2 条 → 2 个 fork 启动", () => {
    const { dispatch, feishuForks, feishuBusy } = makeSimulator(3);
    const oid = "user-1", base = "pm-1";

    const r0 = dispatch(oid, base, "Q1");      // goes direct to base
    assert.equal(r0.type, "direct");
    assert.ok(feishuBusy.has(base));

    const r1 = dispatch(oid, base, "Q2");      // base busy → fork 1
    assert.equal(r1.type, "forked");

    const r2 = dispatch(oid, base, "Q3");      // base busy, 1 fork → fork 2
    assert.equal(r2.type, "forked");

    assert.equal(feishuForks.get(oid)?.size, 2, "exactly 2 forks running");
    assert.equal(feishuBusy.size, 3, "base + 2 forks = 3 total");
  });

  // ── Scenario 3: Overflow to pending queue at capacity ────────────────────
  it("场景3 满载排队: base busy + 2 fork 时发第 4 条 → 进 pendingQueue", () => {
    const { dispatch, feishuForks, pendingQueue } = makeSimulator(3);
    const oid = "user-2", base = "pm-2";

    dispatch(oid, base, "Q1"); // direct
    dispatch(oid, base, "Q2"); // fork-1
    dispatch(oid, base, "Q3"); // fork-2  → capacity reached
    assert.equal(feishuForks.get(oid)?.size, 2, "2 forks at capacity");

    const r3 = dispatch(oid, base, "Q4"); // → pending
    assert.equal(r3.type, "queued");
    assert.equal((r3 as any).queueLen, 1);
    assert.equal(pendingQueue.get(oid)?.length, 1);

    const r4 = dispatch(oid, base, "Q5"); // → pending
    assert.equal(r4.type, "queued");
    assert.equal(pendingQueue.get(oid)?.length, 2);
  });

  // ── Scenario 4: Drain releases pending after fork completes ──────────────
  it("场景4 drain 出队: 一个 fork 完成 → pendingQueue[0] 出队启动", () => {
    const { dispatch, completeFork, feishuForks, pendingQueue } = makeSimulator(3);
    const oid = "user-3", base = "pm-3";

    dispatch(oid, base, "Q1");
    const r1 = dispatch(oid, base, "Q2"); // fork-1
    dispatch(oid, base, "Q3"); // fork-2 → capacity
    dispatch(oid, base, "Q4"); // → pending[0]
    dispatch(oid, base, "Q5"); // → pending[1]
    assert.equal(pendingQueue.get(oid)?.length, 2);

    const fork1 = (r1 as { forkId: string }).forkId;
    completeFork(oid, fork1, base);
    // drain should have shifted Q4 out and started it as a new fork
    assert.equal(pendingQueue.get(oid)?.length, 1, "one item drained");
    assert.equal(feishuForks.get(oid)?.size, 2, "still 2 active forks (fork2 + drained)");
  });

  // ── Scenario 5: Fork snapshot isolation (Bug 1 fix validation) ───────────
  it("场景5 fork 快照隔离: base 处理 Q1 时 fork Q2 → fork initialMessages 不含 Q1", () => {
    const { dispatch, forkLog, checkpoints } = makeSimulator(3);
    const oid = "user-4", base = "pm-4";

    // Simulate base PM having completed turn 0 (checkpoint = [Q0, A0])
    const cleanHistory: Msg[] = [
      { role: "user",      content: "Q0 历史问题" },
      { role: "assistant", content: "A0 历史回答" },
    ];
    checkpoints.set(base, cleanHistory);

    // Base PM now starts processing Q1 (becomes busy, no new checkpoint yet)
    dispatch(oid, base, "Q1");  // direct → base busy, no checkpoint update

    // Q2 arrives while Q1 in-flight → fork
    const r2 = dispatch(oid, base, "Q2");
    assert.equal(r2.type, "forked");

    const fork = forkLog[0]!;
    assert.equal(fork.text, "Q2");

    // Fork's initialMessages must equal the checkpoint (Q0+A0), NOT contain Q1
    assert.deepEqual(fork.initialMessages, cleanHistory, "fork uses clean checkpoint");

    const containsQ1 = fork.initialMessages.some((m) => m.content.includes("Q1"));
    assert.ok(!containsQ1, "fork's initialMessages must NOT contain in-flight Q1");
  });

  // ── Scenario 6: Fork error isolation ─────────────────────────────────────
  it("场景6 fork 错误隔离: fork-1 抛错 → fork-2 不受影响, base 不受影响", () => {
    const { dispatch, feishuBusy, feishuForks } = makeSimulator(3);
    const oid = "user-5", base = "pm-5";

    dispatch(oid, base, "Q1"); // direct
    const r1 = dispatch(oid, base, "Q2"); // fork-1
    const r2 = dispatch(oid, base, "Q3"); // fork-2

    const fork1 = (r1 as { forkId: string }).forkId;
    const fork2 = (r2 as { forkId: string }).forkId;

    // Simulate killAgent for fork-1 (error path — removes from busy+forks)
    feishuBusy.delete(fork1);
    feishuForks.get(oid)?.delete(fork1);

    // fork-2 and base PM must be unaffected
    assert.ok(feishuBusy.has(fork2), "fork-2 still running");
    assert.ok(feishuBusy.has(base),  "base PM still running");
    assert.ok(feishuForks.get(oid)?.has(fork2), "fork-2 still tracked");
    assert.equal(feishuForks.get(oid)?.size, 1, "only fork-2 remains");
  });

  // ── Scenario 7: Concurrent cap never exceeded ─────────────────────────────
  it("场景7 上限不超: 连发 6 条 → 同时 running 数始终 ≤ 3", () => {
    const { dispatch, completeFork, feishuBusy, feishuForks } = makeSimulator(3);
    const oid = "user-6", base = "pm-6";

    const forkIds: string[] = [];
    const results = [];
    for (let i = 1; i <= 6; i++) {
      results.push(dispatch(oid, base, `Q${i}`));
    }

    // Collect all forked IDs
    for (const r of results) {
      if (r.type === "forked") forkIds.push((r as any).forkId as string);
    }

    // Peak concurrent = base(1) + forks(2) = 3
    const peakRunning = 1 + (feishuForks.get(oid)?.size ?? 0);
    assert.ok(peakRunning <= 3, `peak running ${peakRunning} must be ≤ 3`);

    // Complete one fork → drain → still ≤ 3
    if (forkIds.length > 0) {
      completeFork(oid, forkIds[0]!, base);
      const afterDrain = (feishuBusy.has(base) ? 1 : 0) + (feishuForks.get(oid)?.size ?? 0);
      assert.ok(afterDrain <= 3, `after drain: ${afterDrain} ≤ 3`);
    }
  });

  // ── Bug 2 validation: drain respects MAX including base PM ────────────────
  it("Bug2 验证: base busy + 2 fork(满载) → drain 不放出第 3 个 fork", () => {
    const { dispatch, drain, feishuForks, pendingQueue } = makeSimulator(3);
    const oid = "user-7", base = "pm-7";

    dispatch(oid, base, "Q1"); // direct, base busy
    dispatch(oid, base, "Q2"); // fork-1
    dispatch(oid, base, "Q3"); // fork-2 → at capacity
    // Manually push a pending item (simulates arrival at capacity)
    pendingQueue.set(oid, [{ text: "Q4", anchorMsgId: "msg-4" }]);

    // drain should NOT dispatch because total = 1+2 = 3 = MAX
    drain(oid, base);
    assert.equal(pendingQueue.get(oid)?.length, 1, "drain must not fire when at capacity");
    assert.equal(feishuForks.get(oid)?.size, 2, "still 2 forks");
  });

  it("Bug2 验证: base busy + 1 fork → drain 可放出第 2 个 fork", () => {
    const { dispatch, drain, feishuForks, pendingQueue } = makeSimulator(3);
    const oid = "user-8", base = "pm-8";

    dispatch(oid, base, "Q1"); // direct, base busy
    dispatch(oid, base, "Q2"); // fork-1 → total = 2 < 3
    pendingQueue.set(oid, [{ text: "Q3", anchorMsgId: "msg-3" }]);

    drain(oid, base);
    assert.equal(pendingQueue.get(oid)?.length, 0, "drain fired and emptied queue");
    assert.equal(feishuForks.get(oid)?.size, 2, "2nd fork started by drain");
  });

  // ── Bug 2 drain-routing fix: base PM done → pending routed DIRECT ────────
  it("Bug2 drain 路由: base PM 完成后 pending 直接投递给 base PM(不创建多余 fork)", () => {
    const { dispatch, completeBase, feishuBusy, feishuForks, pendingQueue } = makeSimulator(3);
    const oid = "user-9", base = "pm-9";

    dispatch(oid, base, "Q1"); // direct → base busy
    // No forks. Push a pending item manually (simulates window-outside arrival at capacity=1).
    pendingQueue.set(oid, [{ text: "Q2", anchorMsgId: "msg-2" }]);

    // Base PM finishes Q1 with a clean history
    const finalHistory: Msg[] = [
      { role: "user",      content: "Q1" },
      { role: "assistant", content: "A1" },
    ];
    completeBase(oid, base, finalHistory);

    // drain should have routed Q2 directly to base PM (busy → direct), not forked
    assert.ok(feishuBusy.has(base), "base PM re-acquired busy for Q2");
    assert.equal(feishuForks.get(oid)?.size ?? 0, 0, "no fork created — routed direct");
    assert.equal(pendingQueue.get(oid)?.length, 0, "pending queue drained");
  });
});

// ── Interface contract (remains from Phase B) ────────────────────────────────
describe("HttpConvAgent static interface (Phase B contract)", () => {
  it("compactHistory exists and matches simulation compact logic", () => {
    const msgs: Msg[] = [
      { role: "user",      content: "A".repeat(1000) },
      { role: "assistant", content: "B".repeat(5000) },
      { role: "user",      content: "C".repeat(1000) },
      { role: "assistant", content: "D".repeat(1000) },
      { role: "user",      content: "E".repeat(1000) },
      { role: "assistant", content: "F".repeat(1000) },
      { role: "user",      content: "G".repeat(1000) },
    ];
    const out = HttpConvAgent.compactHistory(msgs, 3000);
    // first preserved, last 4 preserved
    assert.equal(out[0]!.content, "A".repeat(1000));
    assert.deepEqual(out.slice(-4), msgs.slice(-4));
  });
});
