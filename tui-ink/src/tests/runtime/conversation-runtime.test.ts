import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConversationRuntime } from "../../runtime/ConversationRuntime.js";
import type { RuntimeAction, RuntimeMessage } from "../../runtime/ConversationRuntime.js";

const contents = (messages: RuntimeMessage[]) => messages.map((m) => m.content);

describe("ConversationRuntime", () => {
  it("routes idle base, busy forks, full queue, drain, and merge in current baseline order", () => {
    const rt = new ConversationRuntime({ maxConcurrent: 3 });
    const events: RuntimeAction[] = [];
    const cid = "user-a";

    events.push(...rt.accept({ conversationId: cid, text: "Q1 base", messageId: "msg-1" }));
    events.push(...rt.accept({ conversationId: cid, text: "Q2 fork", messageId: "msg-2" }));
    events.push(...rt.accept({ conversationId: cid, text: "Q3 fork", messageId: "msg-3" }));
    events.push(...rt.accept({ conversationId: cid, text: "Q4 queued", messageId: "msg-4" }));
    events.push(...rt.completeFork(cid, "fork-2", "A3 first"));
    events.push(...rt.completeFork(cid, "fork-1", "A2 second"));
    events.push(...rt.completeBase(cid, [
      { role: "user", content: "Q1 base" },
      { role: "assistant", content: "A1 base" },
    ]));

    assert.deepEqual(events.map((event) => {
      switch (event.type) {
        case "fork_start":
          return { type: event.type, forkId: event.forkId, text: event.text, snapshot: contents(event.snapshot) };
        case "queued":
          return { type: event.type, text: event.text, queueLen: event.queueLen };
        case "fork_buffered":
          return { type: event.type, forkId: event.forkId, question: event.question, answer: event.answer, seq: event.seq };
        case "buffer_flushed":
          return { type: event.type, at: event.at, entries: contents(event.entries) };
        case "base_complete":
          return { type: event.type, checkpoint: contents(event.checkpoint) };
        case "base_start":
          return { type: event.type, text: event.text };
        case "drain_noop":
          return { type: event.type, reason: event.reason };
        default:
          return event;
      }
    }), [
      { type: "base_start", text: "Q1 base" },
      { type: "fork_start", forkId: "fork-1", text: "Q2 fork", snapshot: [] },
      { type: "fork_start", forkId: "fork-2", text: "Q3 fork", snapshot: [] },
      { type: "queued", text: "Q4 queued", queueLen: 1 },
      { type: "fork_buffered", forkId: "fork-2", question: "Q3 fork", answer: "A3 first", seq: 2 },
      { type: "fork_start", forkId: "fork-3", text: "Q4 queued", snapshot: ["Q3 fork", "A3 first"] },
      { type: "fork_buffered", forkId: "fork-1", question: "Q2 fork", answer: "A2 second", seq: 1 },
      { type: "drain_noop", reason: "empty" },
      { type: "buffer_flushed", at: "turn_end", entries: ["Q2 fork", "A2 second", "Q3 fork", "A3 first"] },
      { type: "base_complete", checkpoint: ["Q1 base", "A1 base", "Q2 fork", "A2 second", "Q3 fork", "A3 first"] },
      { type: "drain_noop", reason: "empty" },
    ]);
  });

  it("flushes completed fork buffer before the next direct base turn", () => {
    const rt = new ConversationRuntime({ maxConcurrent: 3 });
    const cid = "user-b";

    rt.accept({ conversationId: cid, text: "Q1 base", messageId: "msg-1" });
    rt.accept({ conversationId: cid, text: "Q2 fork", messageId: "msg-2" });
    rt.completeBase(cid, [
      { role: "user", content: "Q1 base" },
      { role: "assistant", content: "A1 base" },
    ]);
    rt.completeFork(cid, "fork-1", "A2 late");
    const actions = rt.accept({ conversationId: cid, text: "Q3 base", messageId: "msg-3" });

    assert.deepEqual(actions.map((event) => event.type), ["buffer_flushed", "base_start"]);
    const flush = actions[0] as Extract<RuntimeAction, { type: "buffer_flushed" }>;
    assert.equal(flush.at, "pre_dispatch");
    assert.deepEqual(contents(flush.entries), ["Q2 fork", "A2 late"]);
  });

  it("does not buffer silent fork completion", () => {
    const rt = new ConversationRuntime({ maxConcurrent: 3 });
    const cid = "user-c";
    rt.accept({ conversationId: cid, text: "Q1", messageId: "m1" });
    rt.accept({ conversationId: cid, text: "Q2", messageId: "m2" });
    const actions = rt.completeFork(cid, "fork-1", "");
    assert.deepEqual(actions.map((event) => event.type), ["fork_silent", "drain_noop"]);
  });

  it("exposes running and pending counts for shadow comparisons", () => {
    const rt = new ConversationRuntime({ maxConcurrent: 3 });
    const cid = "user-d";
    rt.accept({ conversationId: cid, text: "Q1", messageId: "m1" });
    rt.accept({ conversationId: cid, text: "Q2", messageId: "m2" });
    rt.accept({ conversationId: cid, text: "Q3", messageId: "m3" });
    rt.accept({ conversationId: cid, text: "Q4", messageId: "m4" });
    assert.equal(rt.getRunningCount(cid), 3);
    assert.equal(rt.getPendingCount(cid), 1);
  });

  it("shadow mode can complete turns without auto-draining pending items", () => {
    const rt = new ConversationRuntime({ maxConcurrent: 3, autoDrainOnComplete: false });
    const cid = "user-shadow";
    rt.accept({ conversationId: cid, text: "Q1", messageId: "m1" });
    rt.accept({ conversationId: cid, text: "Q2", messageId: "m2" });
    rt.accept({ conversationId: cid, text: "Q3", messageId: "m3" });
    rt.accept({ conversationId: cid, text: "Q4", messageId: "m4" });

    const done = rt.completeFork(cid, "fork-1", "A2");
    assert.deepEqual(done.map((event) => event.type), ["fork_buffered"]);
    assert.equal(rt.getPendingCount(cid), 1);

    const next = rt.accept({ conversationId: cid, text: "Q4", messageId: "m4" });
    assert.equal(next[0]?.type, "fork_start");
  });
});
