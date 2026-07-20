/**
 * 飞书层回归哨兵测试 — 守护已修复 Bug 不被回退
 *
 * (a) Bug A: FeishuReplyAggregator 一轮多段 chunk → send 只调用一次
 * (b) Bug C: send 抛异常 → sending 由 finally 重置，下一轮正常执行
 * (c) Bug B: HttpConvAgent busy 时入队，_busy=false 后由 finally drain 处理
 * (d) drain 终止性: N 条消息全部处理后 _queue 为空（无孤儿消息）
 * (e) nudge 入队不抢锁: 同步注入的 nudge 只是排队，drain 照常取用户消息
 * (f) 真实 nudge 抢锁（setImmediate 注入）: drain 被 skip N 次后，
 *     用户消息靠 nudge 的 finally 接力捞回，_queue 最终为空
 *
 * (c)/(d)/(e) 验证「drain 能触发、能接力、消息能排队」；
 * (f) 验证「drain 被 preempt 后接力链不断」——这是不同的不变量。
 *
 * 任何修改飞书层的 PR 必须保持这六个测试绿。
 */

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert/strict";
import { FeishuReplyAggregator } from "../../feishu/replyAggregator.js";
import { HttpConvAgent } from "../../adapters/httpAgent.js";
import { MockLLMServer } from "../e2e/runner/MockLLMServer.js";

// ── (a)(b): FeishuReplyAggregator 纯单测，不依赖 HTTP ─────────────────────────

describe("FeishuReplyAggregator — 飞书层回归哨兵", () => {
  it(
    "(a) Bug A 哨兵: 一轮 3 段 chunk → send 只被调用 1 次，内容完整合并",
    async () => {
      let callCount = 0;
      let receivedText = "";

      const agg = new FeishuReplyAggregator(
        async (text) => { callCount++; receivedText = text; },
        async (_text) => { /* sendCard — not under test */ },
        { idleFlushMs: 30 },
      );

      agg.onChunk("段落一");
      agg.onChunk("段落二");
      agg.onChunk("段落三");
      agg.onTurnEnd(); // 取消 debounce timer，立即 flush

      await new Promise((r) => setTimeout(r, 100)); // 等 async send 完成

      assert.equal(callCount, 1,
        "send 应只被调用一次——多段 chunk 不应产生多次飞书 API 调用");
      assert.ok(receivedText.includes("段落一"), "合并文本应包含段落一");
      assert.ok(receivedText.includes("段落二"), "合并文本应包含段落二");
      assert.ok(receivedText.includes("段落三"), "合并文本应包含段落三");
    },
  );

  it(
    "(b) Bug C 哨兵: send 抛异常 → finally 重置 sending=false，下一轮 flush 正常执行",
    async () => {
      let callCount = 0;

      const agg = new FeishuReplyAggregator(
        async () => {
          callCount++;
          if (callCount === 1) throw new Error("simulated Feishu API failure");
          // 第二次调用正常返回
        },
        async (_text) => { /* sendCard — not under test */ },
        { idleFlushMs: 30 },
      );

      // Turn 1: flush 触发异常
      agg.onChunk("turn-1 内容");
      agg.onTurnEnd();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(callCount, 1, "第一次 send 应被调用（并抛异常）");

      // Turn 2: sending 必须已由 finally 释放，否则 re-entrance guard 会跳过这次 flush
      agg.onChunk("turn-2 内容");
      agg.onTurnEnd();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(callCount, 2,
        "第二次 send 应正常调用——finally { sending=false } 必须无条件执行");
    },
  );

  it(
    "passes responder agent metadata to the final Feishu sender",
    async () => {
      let receivedAgentId = "";

      const agg = new FeishuReplyAggregator(
        async (_text, meta) => { receivedAgentId = meta?.agentId ?? ""; },
        async (_text) => { /* sendCard — not under test */ },
        { idleFlushMs: 30 },
      );

      agg.onChunk("最终回复", "text", { agentId: "feishu-fork-abc123" });
      agg.onTurnEnd();

      await new Promise((r) => setTimeout(r, 100));

      assert.equal(receivedAgentId, "feishu-fork-abc123");
    },
  );
});

// ── (c): HttpConvAgent._queue drain，使用 MockLLMServer ───────────────────────

describe("HttpConvAgent._queue — drain 飞书层回归哨兵", () => {
  let srv: MockLLMServer;

  before(async () => {
    srv = new MockLLMServer();
    await srv.start();
  });

  after(async () => {
    await srv.stop();
  });

  it(
    "(c) Bug B 哨兵: busy 时入队的消息，_busy 转 false 后被 drain 处理（不静默丢弃）",
    async () => {
      // 为两次 LLM 请求分别准备响应
      srv.enqueue('{"v":1,"type":"agent.done","success":true,"reason":"reply-1"}');
      srv.enqueue('{"v":1,"type":"agent.done","success":true,"reason":"reply-2"}');

      const agent = new HttpConvAgent({
        id: "drain-sentinel",
        role: "Worker",
        providerCfg: {
          provider: "openai",
          model: "mock",
          apiKey: "test-key",
          baseUrl: `http://127.0.0.1:${srv.port}`,
        },
        systemPrompt: "test",
      });

      let idleCount = 0;
      const bothDone = new Promise<void>((resolve) => {
        agent.on("event", (ev: any) => {
          if (ev.type === "agent.state" && ev.state === "idle") {
            idleCount++;
            if (idleCount >= 2) resolve();
          }
        });
      });

      // msg1: send() 同步将 _busy 置为 true，随后进入 async HTTP 调用
      agent.sendCommand({ type: "user.message", text: "msg1" });
      // msg2: _busy=true → 进入 _queue，不被静默丢弃
      agent.sendCommand({ type: "user.message", text: "msg2" });

      // 等待两轮 idle 或 5s 安全超时
      await Promise.race([
        bothDone,
        new Promise<void>((r) => setTimeout(r, 5000)),
      ]);

      assert.equal(idleCount, 2,
        "应有两次 idle 状态转换——msg2 必须被 drain 后处理");
      assert.equal(srv.callCount, 2,
        "mock 服务器应收到两次 HTTP 请求——msg2 不应被静默丢弃");
    },
  );
});

// ── (d)(e): drain 终止性 — 每测试独立 server，避免 callCount 跨测污染 ──────────

describe("HttpConvAgent._queue — drain 终止性哨兵", () => {
  it(
    "(d) N 条消息全部入队后,_queue 最终为空（无孤儿消息）",
    async () => {
      const srv = new MockLLMServer();
      await srv.start();
      try {
        const N = 5;
        for (let i = 1; i <= N; i++) {
          srv.enqueue(`{"v":1,"type":"agent.done","success":true,"reason":"msg${i}"}`);
        }

        const agent = new HttpConvAgent({
          id: "drain-N",
          role: "Worker",
          providerCfg: {
            provider: "openai", model: "mock", apiKey: "test-key",
            baseUrl: `http://127.0.0.1:${srv.port}`,
          },
          systemPrompt: "test",
        });

        let idleCount = 0;
        const allDone = new Promise<void>((resolve) => {
          agent.on("event", (ev: any) => {
            if (ev.type === "agent.state" && ev.state === "idle") {
              if (++idleCount >= N) resolve();
            }
          });
        });

        // msg1 立即执行(_busy 同步置为 true)，msg2-N 同步入队
        agent.sendCommand({ type: "user.message", text: "msg1" });
        for (let i = 2; i <= N; i++) {
          agent.sendCommand({ type: "user.message", text: `msg${i}` });
        }

        await Promise.race([allDone, new Promise<void>((r) => setTimeout(r, 10_000))]);

        assert.equal(idleCount, N, `应处理全部 ${N} 条消息`);
        assert.equal(
          (agent as any)._queue.length, 0,
          "_queue 必须为空——每条消息都应被 drain 接力链处理",
        );
        assert.equal(srv.callCount, N, `mock 服务器应收到 ${N} 次 HTTP 请求`);
      } finally {
        await srv.stop();
      }
    },
  );

  it(
    "(e) nudge 抢锁后 drain 接力链不断: 用户消息最终仍被处理，_queue 最终为空",
    async () => {
      const srv = new MockLLMServer();
      await srv.start();
      try {
        // msg1（先处理）+ msg2（入队）+ nudge（从 idle handler 注入）= 3 次调用
        for (let i = 0; i < 3; i++) {
          srv.enqueue(`{"v":1,"type":"agent.done","success":true,"reason":"r${i}"}`);
        }

        const agent = new HttpConvAgent({
          id: "drain-nudge",
          role: "Worker",
          providerCfg: {
            provider: "openai", model: "mock", apiKey: "test-key",
            baseUrl: `http://127.0.0.1:${srv.port}`,
          },
          systemPrompt: "test",
        });

        let idleCount = 0;
        let nudgeSent = false;
        const allDone = new Promise<void>((resolve) => {
          agent.on("event", (ev: any) => {
            if (ev.type === "agent.state" && ev.state === "idle") {
              idleCount++;
              // 首次 idle 时注入 nudge，模拟 index.tsx idle handler 行为。
              // idle 在 send() 的 try 块内 emit，此时 _busy 仍为 true，
              // 所以 nudge 进入 _queue；随后 finally drain 接力处理它。
              if (!nudgeSent) {
                nudgeSent = true;
                agent.sendCommand({ type: "user.message", text: "nudge" });
              }
              if (idleCount >= 3) resolve();
            }
          });
        });

        // msg1 立即执行(_busy=true)，msg2 同步入队
        agent.sendCommand({ type: "user.message", text: "msg1" });
        agent.sendCommand({ type: "user.message", text: "msg2" });

        await Promise.race([allDone, new Promise<void>((r) => setTimeout(r, 10_000))]);

        assert.equal(idleCount, 3, "msg1 + msg2 + nudge 都应完成");
        assert.equal(
          (agent as any)._queue.length, 0,
          "_queue 必须为空——nudge 抢锁后接力链不断，msg2 不应永久留在队列",
        );
        assert.equal(srv.callCount, 3, "mock 服务器应收到 3 次请求");
      } finally {
        await srv.stop();
      }
    },
  );

  it(
    "(f) 真实 nudge 抢锁（setImmediate 注入）: drain 被 preempt N 次后，用户消息靠接力链捞回",
    async () => {
      // 与 (e) 的关键区别：nudge 通过 setImmediate 注入，复现 index.tsx 的真实行为。
      //
      // 执行时序：
      //   idle 在 send() 的 try 块内 emit → listener 注册 SI-nudge（FIFO，排在 drain 前）
      //   try 结束 → finally: _busy=false → SI-drain 注册
      //   SI-nudge 先触发: sendCommand(nudge) → !_busy → send(nudge) → _busy=true
      //   SI-drain 后触发: _busy=true → skip，user-msg 留在队列
      //   nudge 的 finally: _busy=false，队列非空 → 再注册 SI-drain2 → 捞回 user-msg
      //
      // (e) 的 nudge 在 idle 回调内同步注入，_busy 仍为 true → 进 _queue，无抢锁。
      // (f) 的 nudge 经 setImmediate 注入，_busy 已为 false → 真正抢占 drain。
      const srv = new MockLLMServer();
      await srv.start();
      try {
        const MAX_NUDGES = 2;
        // msg1 + nudge1 + nudge2 + user-msg = 4 次调用
        for (let i = 0; i < MAX_NUDGES + 2; i++) {
          srv.enqueue(`{"v":1,"type":"agent.done","success":true,"reason":"r${i}"}`);
        }

        const agent = new HttpConvAgent({
          id: "drain-real-preempt",
          role: "Worker",
          providerCfg: {
            provider: "openai", model: "mock", apiKey: "test-key",
            baseUrl: `http://127.0.0.1:${srv.port}`,
          },
          systemPrompt: "test",
        });

        let idleCount = 0;
        let nudgeSentCount = 0;
        const allDone = new Promise<void>((resolve) => {
          agent.on("event", (ev: any) => {
            if (ev.type === "agent.state" && ev.state === "idle") {
              idleCount++;
              // setImmediate 注入：执行时 _busy 已为 false，
              // 比 drain 的 setImmediate 先注册(FIFO)，因此真正抢到锁，
              // 让 drain 看到 _busy=true 而 skip——这是 (e) 的同步注入不会触发的路径
              if (nudgeSentCount < MAX_NUDGES) {
                const n = ++nudgeSentCount;
                setImmediate(() => {
                  agent.sendCommand({ type: "user.message", text: `nudge${n}` });
                });
              }
              if (idleCount >= MAX_NUDGES + 2) resolve();
            }
          });
        });

        // msg1 立即执行，user-msg 入队（将被 nudge 连续抢先）
        agent.sendCommand({ type: "user.message", text: "msg1" });
        agent.sendCommand({ type: "user.message", text: "user-msg" });

        await Promise.race([allDone, new Promise<void>((r) => setTimeout(r, 10_000))]);

        assert.equal(idleCount, MAX_NUDGES + 2,
          `msg1 + ${MAX_NUDGES} 次 nudge + user-msg 都应完成`);
        assert.equal(
          (agent as any)._queue.length, 0,
          "_queue 必须为空——drain 被 preempt 后，nudge 的 finally 必须接力触发下一次 drain",
        );
        assert.equal(srv.callCount, MAX_NUDGES + 2,
          `mock 服务器应收到 ${MAX_NUDGES + 2} 次请求`);
      } finally {
        await srv.stop();
      }
    },
  );
});
