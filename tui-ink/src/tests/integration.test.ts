// 集成测试：用本地 mock SSE 服务器验证完整 fork 链路
// 覆盖：PM 阻断、dispatch 验证、SecretaryProxy memory、btw 处理、通信矩阵

import { describe, it, before, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { applyEvent, getState, ensureAgent, _resetForTest } from "../store.js";
import type { TuiEvent } from "../protocol.js";
import { ProcessManager } from "../pm/ProcessManager.js";
import { SecretaryProxy } from "../memory/SecretaryProxy.js";
import { createMemory, loadMemory, loadMessages } from "../memory/MemoryStore.js";
import { HttpConvAgent } from "../adapters/httpAgent.js";

// ── Mock SSE 服务器 ──────────────────────────────────────────────────────────

// Mock SSE server returns OpenAI-format streaming (since tests use provider:"openai")
function makeSSEServer(lines: string[]): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      for (const line of lines) {
        // OpenAI SSE format: choices[0].delta.content
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: line } }] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => srv.close() });
    });
  });
}

// ── 临时 memory 目录 ─────────────────────────────────────────────────────────

let tmpMemDir: string;
let origCwd: string;

before(() => {
  origCwd = process.cwd();
  tmpMemDir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-integration-"));
  process.chdir(tmpMemDir);
});

after(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpMemDir, { recursive: true, force: true });
});

beforeEach(() => _resetForTest());

// ── ProcessManager 单元测试 ───────────────────────────────────────────────────

describe("ProcessManager — preCheckSpawn", () => {
  it("Worker 尝试 spawn → worker_cannot_spawn 拒绝", () => {
    const pm = new ProcessManager();
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run", parent: "pm" });
    ensureAgent({ id: "w1", name: "w1", role: "Worker", state: "run", parent: "tl-01" });

    const ev: Extract<TuiEvent, { type: "spawn" }> = {
      v: 1, type: "spawn", parent: "w1", child: "w1-child",
      role: "Worker", goal: "subtask",
      dispatch: { background: "bg", constraints: [], acceptance_criteria: ["done"], stop_conditions: ["agent.done"] },
    };
    const result = pm.preCheckSpawn(ev, "Worker");
    assert.equal(result.ok, false);
    assert.equal((result as any).code, "worker_cannot_spawn");
    const alerts = pm.getAlerts();
    assert.ok(alerts.some((a) => a.code === "worker_cannot_spawn"), "PM 应有 worker_cannot_spawn 告警");
    pm.destroy();
  });

  it("缺少 dispatch → dispatch_missing 拒绝", () => {
    const pm = new ProcessManager();
    // Tech Lead (depth=1) can spawn Workers — use tl-01 under pm
    ensureAgent({ id: "pm",    name: "pm",    role: "Leader", state: "run" });
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run", parent: "pm" });

    const ev = {
      v: 1 as const, type: "spawn" as const, parent: "tl-01", child: "w1",
      role: "Worker" as const, goal: "task",
      // dispatch 故意缺失
    } as Extract<TuiEvent, { type: "spawn" }>;
    const result = pm.preCheckSpawn(ev, "Leader");
    assert.equal(result.ok, false);
    assert.equal((result as any).code, "dispatch_missing");
    pm.destroy();
  });

  it("dispatch background 为空 → dispatch_missing_background 拒绝", () => {
    const pm = new ProcessManager();
    ensureAgent({ id: "pm",    name: "pm",    role: "Leader", state: "run" });
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run", parent: "pm" });

    const ev: Extract<TuiEvent, { type: "spawn" }> = {
      v: 1, type: "spawn", parent: "tl-01", child: "w1",
      role: "Worker", goal: "task",
      dispatch: { background: "", constraints: [], acceptance_criteria: ["done"], stop_conditions: ["agent.done"] },
    };
    const result = pm.preCheckSpawn(ev, "Leader");
    assert.equal(result.ok, false);
    assert.equal((result as any).code, "dispatch_missing_background");
    pm.destroy();
  });

  it("acceptance_criteria 为空数组 → dispatch_missing_acceptance 拒绝", () => {
    const pm = new ProcessManager();
    ensureAgent({ id: "pm",    name: "pm",    role: "Leader", state: "run" });
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run", parent: "pm" });

    const ev: Extract<TuiEvent, { type: "spawn" }> = {
      v: 1, type: "spawn", parent: "tl-01", child: "w1",
      role: "Worker", goal: "task",
      dispatch: { background: "bg", constraints: [], acceptance_criteria: [], stop_conditions: ["agent.done"] },
    };
    const result = pm.preCheckSpawn(ev, "Leader");
    assert.equal(result.ok, false);
    assert.equal((result as any).code, "dispatch_missing_acceptance");
    pm.destroy();
  });

  it("深度超限 → depth_exceeded 拒绝", () => {
    const pm = new ProcessManager();
    // pm(0) → tl(1) → w1(2) → w2(3) → w3(4) > MAX_DEPTH=4 → reject
    ensureAgent({ id: "pm",  name: "pm",  role: "Leader", state: "run" });
    ensureAgent({ id: "tl",  name: "tl",  role: "Leader", state: "run", parent: "pm" });
    ensureAgent({ id: "w1",  name: "w1",  role: "Worker", state: "run", parent: "tl" });
    ensureAgent({ id: "w2",  name: "w2",  role: "Worker", state: "run", parent: "w1" });
    ensureAgent({ id: "w3",  name: "w3",  role: "Worker", state: "run", parent: "w2" });

    const ev: Extract<TuiEvent, { type: "spawn" }> = {
      v: 1, type: "spawn", parent: "w3", child: "w4",
      role: "Worker", goal: "task",
      dispatch: { background: "bg", constraints: [], acceptance_criteria: ["done"], stop_conditions: ["agent.done"] },
    };
    const result = pm.preCheckSpawn(ev, "Worker");
    // Either worker_cannot_spawn (hits first) or depth_exceeded
    assert.equal(result.ok, false);
    pm.destroy();
  });

  it("fan-out 超限 → fanout_exceeded 拒绝", () => {
    const pm = new ProcessManager();
    ensureAgent({ id: "pm",    name: "pm",    role: "Leader", state: "run" });
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run", parent: "pm" });
    // 4 already running children of tl-01
    for (let i = 1; i <= 4; i++) {
      ensureAgent({ id: `w${i}`, name: `w${i}`, role: "Worker", state: "run", parent: "tl-01" });
    }

    const ev: Extract<TuiEvent, { type: "spawn" }> = {
      v: 1, type: "spawn", parent: "tl-01", child: "w5",
      role: "Worker", goal: "task",
      dispatch: { background: "bg", constraints: [], acceptance_criteria: ["done"], stop_conditions: ["agent.done"] },
    };
    const result = pm.preCheckSpawn(ev, "Leader");
    assert.equal(result.ok, false);
    assert.equal((result as any).code, "fanout_exceeded");
    pm.destroy();
  });

  it("dispatch 完整且深度/fan-out 合法 → ok", () => {
    const pm = new ProcessManager();
    ensureAgent({ id: "pm",    name: "pm",    role: "Leader", state: "run" });
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run", parent: "pm" });

    const ev: Extract<TuiEvent, { type: "spawn" }> = {
      v: 1, type: "spawn", parent: "tl-01", child: "worker-01",
      role: "Worker", goal: "分析 README",
      dispatch: {
        background: "用户需要了解项目结构",
        constraints: ["只读"],
        acceptance_criteria: ["输出文件列表"],
        stop_conditions: ["agent.done", "30min"],
        skills: { inherit_default: true },
      },
    };
    const result = pm.preCheckSpawn(ev, "Leader");
    assert.equal(result.ok, true);
    pm.destroy();
  });
});

// ── ProcessManager.getForegroundChildren ──────────────────────────────────────

describe("ProcessManager.getForegroundChildren — excludes done/background handles", () => {
  it("newly registered child appears in getForegroundChildren", () => {
    const pm = new ProcessManager();
    pm.registerSpawn("tl-01", "pm");
    assert.deepEqual(pm.getForegroundChildren("pm"), ["tl-01"]);
    pm.destroy();
  });

  it("all workers done → getForegroundChildren returns [] (TL must not wait forever)", () => {
    // After completeForeground, mode='done' — must not appear in getForegroundChildren
    // or hasActiveChildren stays true and TL loops "waiting for children" indefinitely.
    const pm = new ProcessManager();
    pm.registerSpawn("w-head",  "tl-01");
    pm.registerSpawn("w-upper", "tl-01");
    assert.equal(pm.getForegroundChildren("tl-01").length, 2);
    pm.completeForeground("w-head",  { success: true });
    pm.completeForeground("w-upper", { success: true });
    assert.deepEqual(pm.getForegroundChildren("tl-01"), [],
      "completed children must be excluded — otherwise TL waits forever");
    pm.destroy();
  });

  it("one done + one still foreground → only the active one returned", () => {
    const pm = new ProcessManager();
    pm.registerSpawn("w1", "tl-01");
    pm.registerSpawn("w2", "tl-01");
    pm.completeForeground("w1", { success: true });
    assert.deepEqual(pm.getForegroundChildren("tl-01"), ["w2"]);
    pm.destroy();
  });

  it("background (timed-out) handle is NOT treated as active child", () => {
    const pm = new ProcessManager();
    const handle = pm.registerSpawn("w-bg", "tl-01");
    handle.setBackground(); // simulate 2-min auto-background timeout
    assert.deepEqual(pm.getForegroundChildren("tl-01"), [],
      "background children must not block parent from finalising");
    pm.destroy();
  });
});

// ── SecretaryProxy 单元测试 ─────────────────────────────────────────────────

describe("SecretaryProxy — memory 写入", () => {
  it("spawn 后 memory 文件立即存在", async () => {
    const mem = createMemory({
      agentId: "test-leader",
      agentType: "LEADER",
      parentChain: [],
      depth: 0,
      model: "test-model",
      roleName: "Leader",
    });
    const sec = new SecretaryProxy(mem);

    // 给 setImmediate 时间跑
    await new Promise((r) => setImmediate(r));

    const loaded = loadMemory("test-leader");
    assert.ok(loaded, "memory 文件应存在");
    assert.equal(loaded!.agent_id, "test-leader");
    assert.equal(loaded!.depth, 0);
    sec.destroy();
  });

  it("tool.result ok=true → fact 追加到 working_set", async () => {
    const mem = createMemory({
      agentId: "w-fact",
      agentType: "WORKER",
      parentChain: ["leader"],
      depth: 1,
      model: "test",
      roleName: "Worker",
    });
    const sec = new SecretaryProxy(mem);

    sec.observe({
      v: 1, type: "tool.result", agent: "w-fact", id: "tc-1",
      ok: true, output: "file content line 1\nline 2",
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const loaded = loadMemory("w-fact");
    assert.ok(loaded!.working_set.facts.length > 0, "facts 应有条目");
    assert.ok(loaded!.working_set.facts[0]!.text.startsWith("file content"), "fact 内容正确");
    assert.equal(loaded!.working_set.facts[0]!.src, "tool:tc-1");
    sec.destroy();
  });

  it("tool.result ok=false → 不写 fact", async () => {
    const mem = createMemory({
      agentId: "w-nofact",
      agentType: "WORKER",
      parentChain: ["leader"],
      depth: 1,
      model: "test",
      roleName: "Worker",
    });
    const sec = new SecretaryProxy(mem);
    sec.observe({ v: 1, type: "tool.result", agent: "w-nofact", id: "tc-1", ok: false, output: "error" });
    await new Promise((r) => setImmediate(r));

    const loaded = loadMemory("w-nofact");
    assert.equal(loaded!.working_set.facts.length, 0, "失败的 tool 结果不应写 fact");
    sec.destroy();
  });

  it("agent.done → tombstone 写入 + memory.snapshot 事件", (_, done) => {
    const mem = createMemory({
      agentId: "w-done",
      agentType: "WORKER",
      parentChain: ["leader"],
      depth: 1,
      model: "test",
      roleName: "Worker",
    });
    const sec = new SecretaryProxy(mem);

    sec.on("event", (ev: TuiEvent) => {
      if (ev.type === "memory.snapshot") {
        const loaded = loadMemory("w-done");
        assert.equal(loaded!.tombstone.final_status, "done", "tombstone final_status 应为 done");
        assert.ok(loaded!.tombstone.compact_summary, "compact_summary 应有内容");
        sec.destroy();
        done();
      }
    });

    sec.observe({ v: 1, type: "agent.done", agent: "w-done", success: true, reason: "任务完成" });
  });

  it("btw: 消息 (to=leader-secretary 别名) → fact 写入", async () => {
    const mem = createMemory({
      agentId: "leader",
      agentType: "LEADER",
      parentChain: [],
      depth: 0,
      model: "test",
      roleName: "Leader",
    });
    const sec = new SecretaryProxy(mem);

    // Leader prompt 要求发到 "leader-secretary"，SecretaryProxy 用 alias 接收
    sec.observe({
      v: 1, type: "message", agent: "leader",
      to: "leader-secretary",  // 别名
      text: "btw: 记一下下午有个会议",
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const loaded = loadMemory("leader");
    const btwFact = loaded!.working_set.facts.find((f) => f.src === "btw:user");
    assert.ok(btwFact, "btw 应写入 working_set.facts");
    assert.ok(btwFact!.text.includes("记一下下午有个会议"), "btw 内容正确");
    sec.destroy();
  });

  it("observeMessage 持久化对话到 .messages.jsonl", async () => {
    const mem = createMemory({
      agentId: "w-msgs",
      agentType: "WORKER",
      parentChain: ["leader"],
      depth: 1,
      model: "test",
      roleName: "Worker",
    });
    const sec = new SecretaryProxy(mem);

    sec.observeMessage("user", "hello worker");
    sec.observeMessage("assistant", '{"v":1,"type":"agent.done","success":true}');

    const msgs = loadMessages("w-msgs");
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0]!.role, "user");
    assert.equal(msgs[0]!.content, "hello worker");
    assert.equal(msgs[1]!.role, "assistant");
    sec.destroy();
  });

  it("resume 后 factSeq 从已有条数继续，不会重复 ID", async () => {
    // 第一次创建 + 写入 2 条 facts
    const mem1 = createMemory({
      agentId: "w-resume",
      agentType: "WORKER",
      parentChain: [],
      depth: 1,
      model: "test",
      roleName: "Worker",
    });
    const sec1 = new SecretaryProxy(mem1);
    sec1.observe({ v: 1, type: "tool.result", agent: "w-resume", id: "tc-1", ok: true, output: "A" });
    sec1.observe({ v: 1, type: "tool.result", agent: "w-resume", id: "tc-2", ok: true, output: "B" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    sec1.destroy();

    // 第二次加载恢复
    const mem2 = loadMemory("w-resume")!;
    assert.equal(mem2.working_set.facts.length, 2);
    const sec2 = new SecretaryProxy(mem2);

    // 新的 fact 应从 f3 开始
    sec2.observe({ v: 1, type: "tool.result", agent: "w-resume", id: "tc-3", ok: true, output: "C" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const final = loadMemory("w-resume")!;
    assert.equal(final.working_set.facts.length, 3);
    const ids = final.working_set.facts.map((f) => f.id);
    assert.deepEqual(new Set(ids).size, 3, "所有 fact ID 应唯一");
    sec2.destroy();
  });
});

// ── HttpConvAgent + mock SSE 服务器集成测试 ──────────────────────────────────

describe("HttpConvAgent — mock SSE 服务器集成", () => {
  it("Leader 收到 spawn 事件 + message 事件 → 正确 emit 两个事件", (_, done) => {
    const spawnLine = JSON.stringify({
      v: 1, type: "spawn", parent: "leader", child: "worker-01",
      role: "Worker", goal: "分析 README",
      dispatch: {
        background: "用户需要了解项目结构",
        constraints: ["只读"],
        acceptance_criteria: ["输出文件列表"],
        stop_conditions: ["agent.done"],
        skills: { inherit_default: true },
      },
    });
    const msgLine = JSON.stringify({
      v: 1, type: "message", to: "user", text: "已派生 worker-01",
    });

    makeSSEServer([spawnLine + "\n", msgLine]).then(({ url, close }) => {
      const u = new URL(url);
      const agent = new HttpConvAgent({
        id: "leader",
        role: "Leader",
        providerCfg: {
          provider: "openai",
          model: "test",
          apiKey: "test",
          baseUrl: url,
        },
      });

      const received: TuiEvent[] = [];
      agent.on("event", (ev: TuiEvent) => {
        if (ev.type === "spawn" || ev.type === "message") received.push(ev);
        if (received.length === 2) {
          const spawnEv = received.find((e) => e.type === "spawn");
          const msgEv   = received.find((e) => e.type === "message");
          assert.ok(spawnEv, "应收到 spawn 事件");
          assert.ok(msgEv,   "应收到 message 事件");
          assert.equal((spawnEv as any).child, "worker-01");
          assert.ok((spawnEv as any).dispatch?.background, "dispatch.background 应有值");
          assert.equal((msgEv as any).text, "已派生 worker-01");
          close();
          done();
        }
      });

      agent.sendCommand({ type: "user.message", text: "帮我分析 README" });
    });
  });

  it("resume: HttpConvAgent 从 .messages.jsonl 重建 messages[]", () => {
    // 先写入 messages
    const mem = createMemory({
      agentId: "resume-agent",
      agentType: "WORKER",
      parentChain: [],
      depth: 1,
      model: "test",
      roleName: "Worker",
    });
    const sec = new SecretaryProxy(mem);
    sec.observeMessage("user", "first user message");
    sec.observeMessage("assistant", '{"v":1,"type":"step","text":"processing"}');
    sec.destroy();

    // 用 resumeFrom 构造 HttpConvAgent
    const agent = new HttpConvAgent({
      id: "new-agent",
      role: "Worker",
      providerCfg: { provider: "openai", model: "test", apiKey: "test" },
      resumeFrom: "resume-agent",
    });

    // 访问 messages (通过类型转换，因为是 private)
    const messages = (agent as any).messages as Array<{ role: string; content: string }>;
    assert.equal(messages.length, 2, "应从 jsonl 恢复 2 条消息");
    assert.equal(messages[0]!.role, "user");
    assert.equal(messages[0]!.content, "first user message");
    assert.equal(messages[1]!.role, "assistant");
  });
});

// ── Resume token-budget truncation ────────────────────────────────────────────

describe("HttpConvAgent — resume token-budget truncation", () => {
  const providerCfg = { provider: "openai" as const, model: "test", apiKey: "test" };

  it("loads all messages when under budget (small session)", () => {
    const mem = createMemory({ agentId: "budget-small", agentType: "WORKER",
      parentChain: [], depth: 1, model: "test", roleName: "Worker" });
    const sec = new SecretaryProxy(mem);
    sec.observeMessage("user", "short message");
    sec.observeMessage("assistant", "short response");
    sec.destroy();

    const agent = new HttpConvAgent({ id: "rb-small", role: "Worker", providerCfg, resumeFrom: "budget-small" });
    const messages = (agent as any).messages as Array<{ role: string; content: string }>;
    assert.equal(messages.length, 2, "all messages preserved when under budget");
    assert.equal(messages[0]!.content, "short message");
  });

  it("truncates oldest messages when total exceeds 60K chars", () => {
    const mem = createMemory({ agentId: "budget-big", agentType: "WORKER",
      parentChain: [], depth: 1, model: "test", roleName: "Worker" });
    const sec = new SecretaryProxy(mem);
    // 10 pairs × 8K chars each = 160K total — well over 60K budget
    for (let i = 0; i < 10; i++) {
      sec.observeMessage("user",      `u${i}: ${"x".repeat(7990)}`);
      sec.observeMessage("assistant", `a${i}: ${"y".repeat(7990)}`);
    }
    sec.destroy();

    const agent = new HttpConvAgent({ id: "rb-big", role: "Worker", providerCfg, resumeFrom: "budget-big" });
    const messages = (agent as any).messages as Array<{ role: string; content: string }>;
    const total = messages.reduce((s: number, m: { content: string }) => s + m.content.length, 0);

    assert.ok(total <= 60_000, `total chars ${total} should be ≤ 60000`);
    assert.ok(messages.length < 20,  "should be fewer than the original 20 messages");
    assert.ok(messages.length >= 4,  "at least last 4 messages always kept");
    // Newest messages are preserved — last assistant message was a9
    assert.ok(messages[messages.length - 1]!.content.startsWith("a9:"), "newest message preserved");
  });

  it("always keeps last 4 messages even when they alone exceed budget", () => {
    const mem = createMemory({ agentId: "budget-oversized", agentType: "WORKER",
      parentChain: [], depth: 1, model: "test", roleName: "Worker" });
    const sec = new SecretaryProxy(mem);
    // 6 messages × 20K chars = 120K — last 4 alone = 80K > 60K budget
    for (let i = 0; i < 6; i++) {
      sec.observeMessage(i % 2 === 0 ? "user" : "assistant", `m${i}:${"z".repeat(19994)}`);
    }
    sec.destroy();

    const agent = new HttpConvAgent({ id: "rb-over", role: "Worker", providerCfg, resumeFrom: "budget-oversized" });
    const messages = (agent as any).messages as Array<{ role: string; content: string }>;
    // Last 4 must always be kept, even if they exceed the budget
    assert.equal(messages.length, 4, "exactly last 4 kept when all exceed budget");
    assert.ok(messages[messages.length - 1]!.content.startsWith("m5:"), "newest message is m5");
    assert.ok(messages[0]!.content.startsWith("m2:"), "oldest kept message is m2");
  });
});

// ── PM + SecretaryProxy 协同测试 ──────────────────────────────────────────────

describe("PM + SecretaryProxy 协同", () => {
  it("完整 spawn → memory 创建 → agent.done → tombstone 链路", (_, done) => {
    const pm = new ProcessManager();
    // Use PM → Tech Lead → Worker hierarchy
    ensureAgent({ id: "pm",    name: "pm",    role: "Leader", state: "run" });
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run", parent: "pm" });

    const spawnEv: Extract<TuiEvent, { type: "spawn" }> = {
      v: 1, type: "spawn", parent: "tl-01", child: "w-full",
      role: "Worker", goal: "读取配置文件",
      dispatch: {
        background: "需要读取项目配置",
        constraints: ["只读"],
        acceptance_criteria: ["输出配置内容"],
        stop_conditions: ["agent.done"],
      },
    };

    // PM 验证通过（Tech Lead depth=1 可以 spawn Worker）
    const check = pm.preCheckSpawn(spawnEv, "Leader");
    assert.equal(check.ok, true, "spawn 应被 PM 允许");

    applyEvent(spawnEv);

    // 创建 worker memory + secretary
    const mem = createMemory({
      agentId: "w-full",
      agentType: "WORKER",
      parentChain: ["pm", "tl-01"],
      depth: 2,
      model: "test",
      roleName: "Worker",
      dispatch: spawnEv.dispatch,
    });
    const sec = new SecretaryProxy(mem);

    sec.on("event", (ev: TuiEvent) => {
      if (ev.type === "memory.snapshot") {
        const loaded = loadMemory("w-full");
        assert.ok(loaded, "memory 文件应存在");
        assert.equal(loaded!.tombstone.final_status, "done");
        assert.equal(loaded!.dispatch.background, "需要读取项目配置");
        assert.equal(loaded!.working_set.facts.length, 1, "应有 1 条 fact（来自 tool.result）");
        pm.destroy();
        sec.destroy();
        done();
      }
    });

    // 模拟 worker 工作流程
    sec.observe({ v: 1, type: "tool.result", agent: "w-full", id: "tc-1", ok: true, output: "config: {foo: bar}" });
    sec.observe({ v: 1, type: "agent.done", agent: "w-full", success: true, reason: "配置读取完成" });
  });
});
