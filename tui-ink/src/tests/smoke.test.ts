import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  applyEvent, getState, selectAgent, approve, reject,
  setMinLevel, scrollBy, _resetForTest, ensureAgent, updateAgentInfo,
} from "../store.js";
import type { TuiEvent, DispatchSpec } from "../protocol.js";

beforeEach(() => _resetForTest());

describe("applyEvent — level tags", () => {
  it("message → level info", () => {
    ensureAgent({ id: "a", name: "a", role: "Worker", state: "run" });
    applyEvent({ v: 1, type: "message", agent: "a", to: "user", text: "hi" });
    const msgs = getState().messagesByAgent.get("a") ?? [];
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.level, "info");
  });

  it("tool.call needs_approval=true → level warn, in pendingApprovals", () => {
    ensureAgent({ id: "a", name: "a", role: "Worker", state: "run" });
    applyEvent({ v: 1, type: "tool.call", agent: "a", id: "t1", name: "Write", args: {}, needs_approval: true });
    const msgs = getState().messagesByAgent.get("a") ?? [];
    assert.equal(msgs[0]!.level, "warn");
    assert.equal(getState().pendingApprovals.length, 1);
    assert.equal(getState().pendingApprovals[0]!.tool_id, "t1");
  });

  it("tool.call needs_approval=false → level debug, not in pendingApprovals", () => {
    ensureAgent({ id: "a", name: "a", role: "Worker", state: "run" });
    applyEvent({ v: 1, type: "tool.call", agent: "a", id: "t2", name: "Read", args: {}, needs_approval: false });
    const msgs = getState().messagesByAgent.get("a") ?? [];
    assert.equal(msgs[0]!.level, "debug");
    assert.equal(getState().pendingApprovals.length, 0);
  });

  it("tool.result ok=true → level debug", () => {
    ensureAgent({ id: "a", name: "a", role: "Worker", state: "run" });
    applyEvent({ v: 1, type: "tool.result", agent: "a", id: "t1", ok: true, output: "ok" });
    const msgs = getState().messagesByAgent.get("a") ?? [];
    assert.equal(msgs[0]!.level, "debug");
  });

  it("tool.result ok=false → level error", () => {
    ensureAgent({ id: "a", name: "a", role: "Worker", state: "run" });
    applyEvent({ v: 1, type: "tool.result", agent: "a", id: "t1", ok: false, output: "fail" });
    const msgs = getState().messagesByAgent.get("a") ?? [];
    assert.equal(msgs[0]!.level, "error");
  });

  it("agent.error → level error, agent.state becomes err", () => {
    ensureAgent({ id: "a", name: "a", role: "Worker", state: "run" });
    applyEvent({ v: 1, type: "agent.error", agent: "a", code: "crash", detail: "boom" });
    const msgs = getState().messagesByAgent.get("a") ?? [];
    assert.equal(msgs[0]!.level, "error");
    assert.equal(getState().agents.get("a")!.state, "err");
  });
});

describe("applyEvent — state updates", () => {
  it("spawn → new agent with parent", () => {
    ensureAgent({ id: "leader", name: "leader", role: "Leader", state: "run" });
    applyEvent({ v: 1, type: "spawn", parent: "leader", child: "w1", role: "Worker", goal: "do work" });
    const a = getState().agents.get("w1");
    assert.ok(a);
    assert.equal(a.parent, "leader");
    assert.equal(a.role, "Worker");
  });

  it("agent.done success=true → state done", () => {
    ensureAgent({ id: "a", name: "a", role: "Worker", state: "run" });
    applyEvent({ v: 1, type: "agent.done", agent: "a", success: true, reason: "all good" });
    assert.equal(getState().agents.get("a")!.state, "done");
  });

  it("agent.done success=false → state err", () => {
    ensureAgent({ id: "a", name: "a", role: "Worker", state: "run" });
    applyEvent({ v: 1, type: "agent.done", agent: "a", success: false });
    assert.equal(getState().agents.get("a")!.state, "err");
  });

  it("todo.set → todosByAgent updated", () => {
    ensureAgent({ id: "a", name: "a", role: "Worker", state: "run" });
    applyEvent({ v: 1, type: "todo.set", agent: "a", items: [{ id: "t1", state: "run", text: "do it" }] });
    const todos = getState().todosByAgent.get("a") ?? [];
    assert.equal(todos.length, 1);
    assert.equal(todos[0]!.text, "do it");
  });
});

describe("scrollBy", () => {
  it("scrollBy(1) increases offset", () => {
    ensureAgent({ id: "leader", name: "leader", role: "Leader", state: "run" });
    for (let i = 0; i < 5; i++) {
      applyEvent({ v: 1, type: "message", agent: "leader", to: "user", text: `msg${i}` });
    }
    selectAgent("leader");
    assert.equal(getState().scrollOffset, 0);
    scrollBy(1);
    assert.equal(getState().scrollOffset, 1);
  });

  it("scrollBy(-999) clamps to 0", () => {
    ensureAgent({ id: "leader", name: "leader", role: "Leader", state: "run" });
    applyEvent({ v: 1, type: "message", agent: "leader", to: "user", text: "hi" });
    selectAgent("leader");
    scrollBy(-999);
    assert.equal(getState().scrollOffset, 0);
  });

  it("scrollBy(999) increases offset (upper clamp handled by ConvPane, not store)", () => {
    ensureAgent({ id: "leader", name: "leader", role: "Leader", state: "run" });
    for (let i = 0; i < 3; i++) {
      applyEvent({ v: 1, type: "message", agent: "leader", to: "user", text: `msg${i}` });
    }
    selectAgent("leader");
    scrollBy(999);
    assert.ok(getState().scrollOffset > 0, "offset should increase");
  });

  it("selectAgent resets scrollOffset to 0", () => {
    ensureAgent({ id: "a", name: "a", role: "Worker", state: "run" });
    ensureAgent({ id: "b", name: "b", role: "Worker", state: "run" });
    for (let i = 0; i < 3; i++) {
      applyEvent({ v: 1, type: "message", agent: "a", to: "user", text: `msg${i}` });
    }
    selectAgent("a");
    scrollBy(2);
    assert.ok(getState().scrollOffset > 0);
    selectAgent("b");
    assert.equal(getState().scrollOffset, 0);
  });
});

describe("setMinLevel / approve / reject", () => {
  it("setMinLevel(\"debug\") updates state", () => {
    setMinLevel("debug");
    assert.equal(getState().minLevel, "debug");
  });

  it("approve removes tool from pendingApprovals", () => {
    ensureAgent({ id: "a", name: "a", role: "Worker", state: "run" });
    applyEvent({ v: 1, type: "tool.call", agent: "a", id: "t1", name: "Write", args: {}, needs_approval: true });
    assert.equal(getState().pendingApprovals.length, 1);
    approve("t1");
    assert.equal(getState().pendingApprovals.length, 0);
  });

  it("reject removes tool from pendingApprovals", () => {
    ensureAgent({ id: "a", name: "a", role: "Worker", state: "run" });
    applyEvent({ v: 1, type: "tool.call", agent: "a", id: "t2", name: "Bash", args: {}, needs_approval: true });
    assert.equal(getState().pendingApprovals.length, 1);
    reject("t2");
    assert.equal(getState().pendingApprovals.length, 0);
  });
});

// ── S1: DispatchSpec 测试 ─────────────────────────────────────────────────────
describe("S1: DispatchSpec — spawn 携带与校验", () => {
  const validDispatch: DispatchSpec = {
    background: "用户需要分析 README.md",
    constraints: ["只读", "20 轮内"],
    acceptance_criteria: ["输出摘要"],
    stop_conditions: ["agent.done", "10min 墙钟"],
    skills: { inherit_default: true },
  };

  it("spawn 携带完整 DispatchSpec → dispatch 字段存入 AgentInfo", () => {
    ensureAgent({ id: "leader", name: "leader", role: "Leader", state: "run" });
    applyEvent({
      v: 1, type: "spawn", parent: "leader", child: "w-spec",
      role: "Worker", goal: "分析 README", dispatch: validDispatch,
    });
    const child = getState().agents.get("w-spec");
    assert.ok(child, "子 agent 应存在");
    assert.deepEqual(child.dispatch, validDispatch, "dispatch 应原样保存");
  });

  it("spawn 不携带 dispatch → store 层 AgentInfo.dispatch 为 undefined（PM 层会拒绝此类 spawn）", () => {
    // Note: PM.preCheckSpawn() rejects dispatch-less spawns in production.
    // This test verifies the store-level behavior in isolation.
    ensureAgent({ id: "leader", name: "leader", role: "Leader", state: "run" });
    applyEvent({
      v: 1, type: "spawn", parent: "leader", child: "w-nospec",
      role: "Worker", goal: "do work",
    });
    const child = getState().agents.get("w-nospec");
    assert.ok(child);
    assert.equal(child.dispatch, undefined, "没有 dispatch 时应为 undefined");
  });

  it("spawn dispatch 缺少 background → 验证失败检测", () => {
    // 直接测 dispatch 字段校验逻辑（镜像 startWorker 中的逻辑）
    const incomplete = { ...validDispatch, background: "" };
    const missing: string[] = [];
    if (!incomplete.background) missing.push("background");
    if (!incomplete.acceptance_criteria?.length) missing.push("acceptance_criteria");
    if (!incomplete.stop_conditions?.length) missing.push("stop_conditions");
    assert.deepEqual(missing, ["background"]);
  });

  it("spawn dispatch 缺少 acceptance_criteria → 验证失败检测", () => {
    const incomplete: DispatchSpec = { ...validDispatch, acceptance_criteria: [] };
    const missing: string[] = [];
    if (!incomplete.background) missing.push("background");
    if (!incomplete.acceptance_criteria?.length) missing.push("acceptance_criteria");
    if (!incomplete.stop_conditions?.length) missing.push("stop_conditions");
    assert.deepEqual(missing, ["acceptance_criteria"]);
  });

  it("spawn dispatch 缺少 stop_conditions → 验证失败检测", () => {
    const incomplete: DispatchSpec = { ...validDispatch, stop_conditions: [] };
    const missing: string[] = [];
    if (!incomplete.background) missing.push("background");
    if (!incomplete.acceptance_criteria?.length) missing.push("acceptance_criteria");
    if (!incomplete.stop_conditions?.length) missing.push("stop_conditions");
    assert.deepEqual(missing, ["stop_conditions"]);
  });

  it("dispatch_invalid agent.error → 显示在 parent conv，parent state 变 err", () => {
    ensureAgent({ id: "leader", name: "leader", role: "Leader", state: "run" });
    applyEvent({
      v: 1, type: "agent.error", agent: "leader",
      code: "dispatch_invalid",
      detail: "spawn bad-worker: missing required DispatchSpec fields: background",
    });
    const leaderMsgs = getState().messagesByAgent.get("leader") ?? [];
    assert.ok(leaderMsgs.some((m) => m.text.includes("dispatch_invalid")), "错误应显示在 parent conv");
    assert.equal(getState().agents.get("leader")!.state, "err");
  });

  it("pm.alert 事件 → 显示在 agent conv，级别正确", () => {
    ensureAgent({ id: "leader", name: "leader", role: "Leader", state: "run" });
    applyEvent({
      v: 1, type: "pm.alert", severity: "warn",
      code: "dispatch_missing_background", agent: "leader",
      detail: "spawn w1 缺少 background 字段",
    });
    const msgs = getState().messagesByAgent.get("leader") ?? [];
    const alert = msgs.find((m) => m.text.includes("dispatch_missing_background"));
    assert.ok(alert, "pm.alert 应显示在 conv");
    assert.equal(alert!.level, "warn");
  });
});

describe("spawn / fork agent lifecycle", () => {
  it("spawn 创建子 agent，parent 字段正确", () => {
    ensureAgent({ id: "leader", name: "leader", role: "Leader", state: "run" });
    applyEvent({ v: 1, type: "spawn", parent: "leader", child: "w1", role: "Worker", goal: "do work" });
    const child = getState().agents.get("w1");
    assert.ok(child, "child agent should exist");
    assert.equal(child.parent, "leader");
    assert.equal(child.role, "Worker");
    assert.equal(child.state, "idle");
  });

  it("spawn 后子 agent 的消息独立存储", () => {
    ensureAgent({ id: "leader", name: "leader", role: "Leader", state: "run" });
    applyEvent({ v: 1, type: "spawn", parent: "leader", child: "w2", role: "Worker", goal: "task" });
    applyEvent({ v: 1, type: "message", agent: "leader", to: "user", text: "leader msg" });
    applyEvent({ v: 1, type: "message", agent: "w2", to: "user", text: "worker msg" });
    // spawn 事件会向 parent 追加一条 system 消息，所以 leader 有 2 条
    assert.equal(getState().messagesByAgent.get("leader")!.length, 2);
    assert.equal(getState().messagesByAgent.get("w2")!.length, 1);
    assert.equal(getState().messagesByAgent.get("w2")![0]!.text, "worker msg");
  });

  it("同一 parent 可 spawn 多个子 agent", () => {
    ensureAgent({ id: "leader", name: "leader", role: "Leader", state: "run" });
    applyEvent({ v: 1, type: "spawn", parent: "leader", child: "w1", role: "Worker", goal: "task1" });
    applyEvent({ v: 1, type: "spawn", parent: "leader", child: "w2", role: "Worker", goal: "task2" });
    assert.equal(getState().agents.size, 3);
    assert.equal(getState().agents.get("w1")!.parent, "leader");
    assert.equal(getState().agents.get("w2")!.parent, "leader");
  });

  it("子 agent done 不影响 parent 状态", () => {
    ensureAgent({ id: "leader", name: "leader", role: "Leader", state: "run" });
    applyEvent({ v: 1, type: "spawn", parent: "leader", child: "w1", role: "Worker", goal: "task" });
    applyEvent({ v: 1, type: "agent.state", agent: "w1", state: "run" });
    applyEvent({ v: 1, type: "agent.done", agent: "w1", success: true, reason: "done" });
    assert.equal(getState().agents.get("w1")!.state, "done");
    assert.equal(getState().agents.get("leader")!.state, "run");
  });

  it("spawn 携带 model 字段时保存到 AgentInfo", () => {
    ensureAgent({ id: "leader", name: "leader", role: "Leader", state: "run" });
    applyEvent({ v: 1, type: "spawn", parent: "leader", child: "w1", role: "Worker", goal: "task", model: "deepseek-chat" });
    assert.equal(getState().agents.get("w1")!.model, "deepseek-chat");
  });

  it("updateAgentInfo 更新 model 字段", () => {
    ensureAgent({ id: "leader", name: "leader", role: "Leader", state: "run" });
    updateAgentInfo("leader", { model: "claude-opus-4-7" });
    assert.equal(getState().agents.get("leader")!.model, "claude-opus-4-7");
  });

  it("嵌套 spawn — 子 agent 可作为 parent 再 spawn", () => {
    ensureAgent({ id: "leader", name: "leader", role: "Leader", state: "run" });
    applyEvent({ v: 1, type: "spawn", parent: "leader", child: "w1", role: "Worker", goal: "task" });
    applyEvent({ v: 1, type: "spawn", parent: "w1", child: "w1-1", role: "Worker", goal: "subtask" });
    const grandchild = getState().agents.get("w1-1");
    assert.ok(grandchild);
    assert.equal(grandchild.parent, "w1");
  });
});

describe("spawn 端到端链路 (mock HttpConvAgent)", () => {
  /** MockHttpConvAgent — 接受 user.message 和 tool.result 两种命令，按轮次返回预设事件 */
  class MockHttpConvAgent extends EventEmitter {
    public id: string;
    private _responses: TuiEvent[][];
    private _callCount = 0;

    constructor(id: string, responses: TuiEvent[][]) {
      super();
      this.id = id;
      this._responses = responses;
    }

    sendCommand(cmd: { type: string; text?: string; id?: string; ok?: boolean; output?: string }): void {
      if (cmd.type !== "user.message" && cmd.type !== "tool.result") return;
      const events = this._responses[this._callCount++] ?? [];
      setImmediate(() => {
        for (const ev of events) this.emit("event", ev);
      });
    }

    kill(): void {}
  }

  it("leader spawn worker → worker 完成 → 全链路状态正确", (t, done) => {
    ensureAgent({ id: "leader", name: "leader", role: "Leader", state: "idle" });

    const leaderResponses: TuiEvent[][] = [[
      { v: 1, type: "spawn", parent: "leader",
        child: "worker-01", role: "Worker", goal: "分析 README.md", model: "deepseek-chat" },
      { v: 1, type: "message", agent: "leader", to: "user",
        text: "已派生 worker-01 来分析 README。" },
    ]];

    const workerResponses: TuiEvent[][] = [[
      { v: 1, type: "agent.state", agent: "worker-01", state: "run", sub: "分析中" },
      { v: 1, type: "todo.set", agent: "worker-01",
        items: [{ id: "t1", state: "run", text: "读取 README" },
                { id: "t2", state: "todo", text: "输出摘要" }] },
      { v: 1, type: "message", agent: "worker-01", to: "user", text: "README 分析完成。" },
      { v: 1, type: "agent.done", agent: "worker-01", success: true, reason: "done" },
    ]];

    const mockAgents = new Map<string, MockHttpConvAgent>();

    const leaderAgent = new MockHttpConvAgent("leader", leaderResponses);
    mockAgents.set("leader", leaderAgent);

    leaderAgent.on("event", (ev: TuiEvent) => {
      applyEvent(ev);
      if (ev.type === "spawn") {
        const workerAgent = new MockHttpConvAgent(ev.child, workerResponses);
        mockAgents.set(ev.child, workerAgent);
        workerAgent.on("event", (wev: TuiEvent) => applyEvent(wev));
        workerAgent.sendCommand({ type: "user.message", text: ev.goal });
      }
    });

    leaderAgent.sendCommand({ type: "user.message", text: "帮我分析 README" });

    setImmediate(() => setImmediate(() => {
      const leader = getState().agents.get("leader");
      assert.ok(leader, "leader should exist");

      const worker = getState().agents.get("worker-01");
      assert.ok(worker, "worker-01 should be created by spawn event");
      assert.equal(worker.parent, "leader");
      assert.equal(worker.state, "done");

      const leaderMsgs = getState().messagesByAgent.get("leader") ?? [];
      assert.ok(leaderMsgs.some(m => m.text === "已派生 worker-01 来分析 README。"),
        "leader message should appear in conversation");

      const workerTodos = getState().todosByAgent.get("worker-01") ?? [];
      assert.equal(workerTodos.length, 2, "worker should have 2 todo items");
      assert.equal(workerTodos[0]!.text, "读取 README");

      const workerMsgs = getState().messagesByAgent.get("worker-01") ?? [];
      assert.ok(workerMsgs.some(m => m.text === "README 分析完成。"),
        "worker completion message should appear");

      done();
    }));
  });

  it("HttpConvAgent 响应解析：JSON 协议行拆分为独立事件", () => {
    ensureAgent({ id: "a", name: "a", role: "Worker", state: "run" });

    const VALID_TYPES = new Set([
      "todo.set","step","tool.call","tool.result","message",
      "spawn","agent.done","agent.error","agent.state",
    ]);

    const fullText = [
      '{"v":1,"type":"todo.set","items":[{"id":"t1","state":"run","text":"step1"}]}',
      '{"v":1,"type":"message","to":"user","text":"分析完成"}',
      '{"v":1,"type":"agent.done","success":true,"reason":"ok"}',
    ].join("\n");

    for (const line of fullText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.type && VALID_TYPES.has(String(parsed.type))) {
          applyEvent({ v: 1, ...parsed, agent: "a" } as TuiEvent);
          continue;
        }
      } catch { /* skip */ }
      applyEvent({ v: 1, type: "message", agent: "a", to: "user", text: trimmed });
    }

    assert.equal(getState().todosByAgent.get("a")!.length, 1, "todo.set should update todos");
    assert.equal(getState().messagesByAgent.get("a")!.length, 1, "only message event becomes bubble");
    assert.equal(getState().messagesByAgent.get("a")![0]!.text, "分析完成");
    assert.equal(getState().agents.get("a")!.state, "done", "agent.done sets state correctly");
  });

  it("响应省略 v:1 字段时依然被识别为协议事件", () => {
    ensureAgent({ id: "a", name: "a", role: "Worker", state: "run" });

    const VALID_TYPES = new Set([
      "todo.set","step","tool.call","tool.result","message",
      "spawn","agent.done","agent.error","agent.state",
    ]);

    // 模拟模型省略 "v":1 的输出
    const fullText = [
      '{"type":"todo.set","items":[{"id":"t1","state":"run","text":"读文件"}]}',
      '{"type":"message","to":"user","text":"省略v1也能解析"}',
      '{"type":"agent.done","success":true,"reason":"ok"}',
    ].join("\n");

    for (const line of fullText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.type && VALID_TYPES.has(String(parsed.type))) {
          applyEvent({ v: 1, ...parsed, agent: "a" } as TuiEvent);
          continue;
        }
      } catch { /* skip */ }
      applyEvent({ v: 1, type: "message", agent: "a", to: "user", text: trimmed });
    }

    assert.equal(getState().todosByAgent.get("a")!.length, 1, "todo.set without v:1 should work");
    assert.equal(getState().messagesByAgent.get("a")![0]!.text, "省略v1也能解析");
    assert.equal(getState().agents.get("a")!.state, "done");
  });

  it("agent.state: idle 清空 sub 文字", () => {
    ensureAgent({ id: "a", name: "a", role: "Worker", state: "run", sub: "thinking…" });
    assert.equal(getState().agents.get("a")!.sub, "thinking…");
    applyEvent({ v: 1, type: "agent.state", agent: "a", state: "idle" });
    assert.equal(getState().agents.get("a")!.state, "idle");
    assert.equal(getState().agents.get("a")!.sub, "", "sub 应在 idle 时清空");
  });

  it("worker tool.call → tool result 回送 → worker 继续完成", (_, done) => {
    ensureAgent({ id: "w1", name: "w1", role: "Worker", state: "idle" });

    // 第一轮：worker 发出 tool.call，然后进入 idle
    // 第二轮（tool result 回送后）：worker 完成
    const workerRounds: TuiEvent[][] = [
      [
        { v: 1, type: "agent.state", agent: "w1", state: "run", sub: "working" },
        { v: 1, type: "tool.call", agent: "w1", id: "tc-1", name: "Read",
          args: { file_path: "README.md" }, needs_approval: false },
        { v: 1, type: "agent.state", agent: "w1", state: "idle" },
      ],
      [
        { v: 1, type: "message", agent: "w1", to: "user", text: "读取完成" },
        { v: 1, type: "agent.done", agent: "w1", success: true, reason: "ok" },
      ],
    ];

    const w = new MockHttpConvAgent("w1", workerRounds);
    const toolQueue: Array<Extract<TuiEvent, { type: "tool.call" }>> = [];

    w.on("event", (ev: TuiEvent) => {
      applyEvent(ev);
      if (ev.type === "tool.call" && !ev.needs_approval) {
        toolQueue.push(ev as Extract<TuiEvent, { type: "tool.call" }>);
      }
      if (ev.type === "agent.state" && ev.state === "idle" && toolQueue.length > 0) {
        const batch = toolQueue.splice(0);
        setImmediate(() => {
          for (const c of batch) {
            applyEvent({ v: 1, type: "tool.result", agent: "w1", id: c.id, ok: true, output: "(mocked)" });
          }
          // tool.result sendCommand 触发下一轮 API 调用
          w.sendCommand({ type: "tool.result", id: batch[0]!.id, ok: true, output: "(mocked)" });
        });
      }
    });

    w.sendCommand({ type: "user.message", text: "do task" });

    // 三层 setImmediate 覆盖两轮异步
    setImmediate(() => setImmediate(() => setImmediate(() => {
      const worker = getState().agents.get("w1");
      assert.equal(worker!.state, "done", "worker 应在 tool loop 后完成");
      const msgs = getState().messagesByAgent.get("w1") ?? [];
      assert.ok(msgs.some((m) => m.text === "读取完成"), "worker 完成消息应出现");
      const toolResults = msgs.filter((m) => m.kind === "tool_result");
      assert.equal(toolResults.length, 1, "tool.result 应记录到消息列表");
      done();
    })));
  });
});
