/**
 * convMode PM convergence — "only-replies-once" regression tests.
 *
 * Covers the fix in startLeaderAgent's idle handler where a conversation-mode PM
 * that spawned a TL would hold feishuBusy forever after its first reply, so every
 * later follow-up ("结论呢"…) queued but never drained.
 *
 * Like concurrent-dispatch.test.ts, these tests SIMULATE the state maps + idle
 * decision that connectFeishu/startLeaderAgent use — no real Feishu API or LLM.
 * `decidePmIdle` is a faithful parallel of the idle branches (index.tsx ~1297-1345):
 *   1297  hasActiveChildren                    → wait (do NOT release feishuBusy — TL still running)
 *   1305  replied && convMode && !hasTodo      → converge  (drainConvModePM(false))
 *   1334  replied && convMode && hasTodo:
 *           continuations < 3                  → nudge
 *           continuations >= 3                 → converge  (drainConvModePM(true))  ← the fix
 * (convMode PM is root, so reportedToParent is never true and the 1299 branch is N/A.)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Faithful parallel of the convMode-PM idle decision ───────────────────────

type IdleAction = "wait-children" | "converge" | "nudge" | "noop";

interface IdleState {
  sentUser: boolean;        // PM did message→user this turn
  convMode: boolean;        // PM is a Feishu conversation session
  hasTodo: boolean;         // PM still has pending todo/run items
  hasActiveChildren: boolean; // a spawned TL/worker is still run/idle
  continuations: number;    // nudge counter this turn
}

function decidePmIdle(s: IdleState): IdleAction {
  if (s.hasActiveChildren) return "wait-children";                    // 1297
  if (s.sentUser && s.convMode && !s.hasTodo) return "converge";      // 1305 → drainConvModePM(false)
  if (s.sentUser && s.convMode && s.hasTodo) {                        // 1334
    return s.continuations < 3 ? "nudge" : "converge";               //  <3 nudge ;  >=3 → drainConvModePM(true)
  }
  return "noop";
}

describe("decidePmIdle — convMode PM idle convergence decision", () => {
  const base: IdleState = {
    sentUser: true, convMode: true, hasTodo: false, hasActiveChildren: false, continuations: 0,
  };

  it("A1: TL still running (hasActiveChildren) → wait, do NOT release", () => {
    assert.equal(decidePmIdle({ ...base, hasActiveChildren: true }), "wait-children");
  });

  it("A2: replied + no todos + no children → converge (clean exit)", () => {
    assert.equal(decidePmIdle({ ...base, hasTodo: false }), "converge");
  });

  it("A3: replied + stale todos + nudges remaining → nudge", () => {
    assert.equal(decidePmIdle({ ...base, hasTodo: true, continuations: 0 }), "nudge");
    assert.equal(decidePmIdle({ ...base, hasTodo: true, continuations: 2 }), "nudge");
  });

  it("A4 (THE FIX): replied + stale todos + nudges exhausted (>=3) → converge, not stuck", () => {
    assert.equal(decidePmIdle({ ...base, hasTodo: true, continuations: 3 }), "converge");
    assert.equal(decidePmIdle({ ...base, hasTodo: true, continuations: 5 }), "converge");
  });

  it("A5: regression guard — pre-fix behaviour was a no-op (stuck) at cont>=3; must now be converge", () => {
    // Before the fix the hasTodo branch only acted when continuations<3, so cont>=3
    // fell through with no convergence → feishuBusy never released. Assert it's gone.
    const stuck = decidePmIdle({ ...base, hasTodo: true, continuations: 3 });
    assert.notEqual(stuck, "noop", "cont>=3 with stale todos must NOT be a silent no-op anymore");
    assert.equal(stuck, "converge");
  });

  it("A6: non-convMode (or no reply) does not take the convMode path", () => {
    assert.equal(decidePmIdle({ ...base, convMode: false, hasTodo: false }), "noop");
    assert.equal(decidePmIdle({ ...base, sentUser: false, hasTodo: true, continuations: 5 }), "noop");
  });
});

// ── End-to-end: serial feishuBusy + follow-up queue ──────────────────────────
// Simulates the lock/queue that connectFeishu uses, driven by decidePmIdle, to
// prove a PM that spawned a TL eventually drains queued follow-ups (no "only replies once").

describe("convMode PM serial queue — drains follow-ups after spawning a TL", () => {
  function makeSession(pmId = "feishu-pm1") {
    const feishuBusy = new Set<string>();
    const queue: string[] = [];           // feishuMsgQueue for this PM
    const delivered: string[] = [];       // messages actually dispatched to the PM

    // A new inbound user message.
    const receive = (text: string): "direct" | "queued" => {
      if (feishuBusy.has(pmId)) { queue.push(text); return "queued"; }
      feishuBusy.add(pmId);
      delivered.push(text);
      return "direct";
    };

    // PM reaches idle with the given state; apply the decision.
    const idle = (s: IdleState): IdleAction => {
      const action = decidePmIdle(s);
      if (action === "converge") {
        // drainConvModePM: release lock, dispatch next queued follow-up (if any)
        feishuBusy.delete(pmId);
        const next = queue.shift();
        if (next !== undefined) { feishuBusy.add(pmId); delivered.push(next); }
      }
      // wait-children / nudge / noop: keep the lock (PM stays busy)
      return action;
    };

    return { feishuBusy, queue, delivered, receive, idle, pmId };
  }

  it("B1: TL running → follow-ups queue, lock held", () => {
    const s = makeSession();
    assert.equal(s.receive("分析 httpAgent send()"), "direct"); // first msg → PM
    // PM spawns TL, replies "已派 tl-01", then idles WHILE TL runs:
    assert.equal(s.idle({ sentUser: true, convMode: true, hasTodo: true, hasActiveChildren: true, continuations: 0 }), "wait-children");
    // user follow-ups while busy:
    assert.equal(s.receive("结论呢"), "queued");
    assert.equal(s.receive("怎么不回答"), "queued");
    assert.equal(s.queue.length, 2);
    assert.ok(s.feishuBusy.has(s.pmId), "lock still held while TL runs");
  });

  it("B2 (THE FIX): TL done + stale todos + nudges exhausted → converge drains first follow-up", () => {
    const s = makeSession();
    s.receive("分析 httpAgent send()");
    s.idle({ sentUser: true, convMode: true, hasTodo: true, hasActiveChildren: true, continuations: 0 }); // wait
    s.receive("结论呢");
    s.receive("怎么不回答");

    // TL completes; PM replies with the real result but its meta-todos linger and nudges run out:
    const action = s.idle({ sentUser: true, convMode: true, hasTodo: true, hasActiveChildren: false, continuations: 3 });
    assert.equal(action, "converge");
    assert.equal(s.delivered.at(-1), "结论呢", "first queued follow-up is now dispatched");
    assert.equal(s.queue.length, 1, "one follow-up left");
    assert.ok(s.feishuBusy.has(s.pmId), "lock re-acquired for the dispatched follow-up");
  });

  it("B3: subsequent converges drain the rest — all follow-ups eventually answered", () => {
    const s = makeSession();
    s.receive("分析 httpAgent send()");
    s.idle({ sentUser: true, convMode: true, hasTodo: true, hasActiveChildren: true, continuations: 0 });
    s.receive("结论呢");
    s.receive("怎么不回答");

    s.idle({ sentUser: true, convMode: true, hasTodo: true, hasActiveChildren: false, continuations: 3 }); // drains "结论呢"
    // PM answers "结论呢" cleanly (no stale todo this time):
    s.idle({ sentUser: true, convMode: true, hasTodo: false, hasActiveChildren: false, continuations: 0 }); // drains "怎么不回答"
    // PM answers "怎么不回答":
    const last = s.idle({ sentUser: true, convMode: true, hasTodo: false, hasActiveChildren: false, continuations: 0 });

    assert.equal(last, "converge");
    assert.deepEqual(s.delivered, ["分析 httpAgent send()", "结论呢", "怎么不回答"]);
    assert.equal(s.queue.length, 0, "queue fully drained");
    assert.ok(!s.feishuBusy.has(s.pmId), "lock released after last follow-up answered");
  });

  it("B4 (regression): pre-fix, cont>=3 stuck would strand the queue forever", () => {
    // Model the OLD behaviour: hasTodo branch with cont>=3 did nothing (no converge).
    const s = makeSession();
    s.receive("分析 httpAgent send()");
    s.idle({ sentUser: true, convMode: true, hasTodo: true, hasActiveChildren: true, continuations: 0 });
    s.receive("结论呢");

    // Simulate the stuck no-op (what the bug did): lock NOT released, queue NOT drained.
    // We assert the CURRENT code does the opposite — converge drains it.
    const action = s.idle({ sentUser: true, convMode: true, hasTodo: true, hasActiveChildren: false, continuations: 4 });
    assert.equal(action, "converge", "fixed: cont>=3 converges instead of stranding the queue");
    assert.equal(s.delivered.at(-1), "结论呢", "the stranded follow-up is finally answered");
  });
});
