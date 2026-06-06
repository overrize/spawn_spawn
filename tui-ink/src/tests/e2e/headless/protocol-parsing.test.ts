/**
 * Headless tests: protocol parser (parseAgentOutput).
 *
 * These tests run without tmux or a real TUI process. They call the extracted
 * parseAgentOutput() pure function directly and assert on emitted events.
 *
 * Covers the bugs we fixed:
 *   - markdown fence stripping
 *   - <thinking> block stripping
 *   - inline JSON on prose lines
 *   - multi-line JSON brace-depth tracking
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAgentOutput } from "../../../adapters/httpAgent.js";
import type { TuiEvent } from "../../../protocol.js";

function collect(text: string, agentId = "pm"): TuiEvent[] {
  const events: TuiEvent[] = [];
  parseAgentOutput(text, agentId, (ev) => events.push(ev));
  return events;
}

function msg(text: string): object {
  return { v: 1, type: "message", to: "user", text };
}
function done(): object {
  return { v: 1, type: "agent.done", success: true, reason: "done" };
}

describe("parseAgentOutput: basic events", () => {
  it("parses a single message event", () => {
    const events = collect(
      JSON.stringify(msg("hello")) + "\n" +
      JSON.stringify(done()),
    );
    const m = events.find((e) => e.type === "message");
    assert.ok(m && "text" in m && (m as any).text === "hello");
  });

  it("parses agent.done", () => {
    const events = collect(JSON.stringify(done()));
    const d = events.find((e) => e.type === "agent.done");
    assert.ok(d);
    assert.equal((d as any).success, true);
  });

  it("sets agent field from agentId parameter when missing", () => {
    const events = collect(JSON.stringify({ v: 1, type: "step", text: "working" }), "tl-01");
    const s = events.find((e) => e.type === "step");
    assert.ok(s && "agent" in s && (s as any).agent === "tl-01");
  });
});

describe("parseAgentOutput: fence stripping", () => {
  it("strips ```json fences — event is parsed correctly", () => {
    const raw =
      "```json\n" +
      JSON.stringify(msg("fence-content")) + "\n" +
      "```\n" +
      JSON.stringify(done());
    const events = collect(raw);
    const m = events.find((e) => e.type === "message");
    assert.ok(m && "text" in m && (m as any).text === "fence-content",
      `Expected message with fence-content, got: ${JSON.stringify(events)}`);
  });

  it("strips plain ``` fences", () => {
    const raw =
      "```\n" +
      JSON.stringify(msg("plain-fence")) + "\n" +
      "```\n" +
      JSON.stringify(done());
    const events = collect(raw);
    const m = events.find((e) => e.type === "message");
    assert.ok(m && "text" in m && (m as any).text === "plain-fence");
  });

  it("no raw ``` appears in any emitted event text", () => {
    const raw = "```json\n" + JSON.stringify(msg("x")) + "\n```\n" + JSON.stringify(done());
    const events = collect(raw);
    for (const ev of events) {
      assert.ok(!JSON.stringify(ev).includes("```"),
        `Fence characters leaked into event: ${JSON.stringify(ev)}`);
    }
  });

  it("agent.done inside fence is processed (not lost)", () => {
    const raw = "```\n" + JSON.stringify(done()) + "\n```";
    const events = collect(raw);
    const d = events.find((e) => e.type === "agent.done");
    assert.ok(d, "agent.done inside fence was not processed");
  });
});

describe("parseAgentOutput: thinking block stripping", () => {
  it("emits thinking… step for <thinking> block", () => {
    const raw =
      "<thinking>\nsome reasoning\n</thinking>\n" +
      JSON.stringify(done());
    const events = collect(raw);
    const step = events.find((e) => e.type === "step" && "text" in e && (e as any).text === "thinking…");
    assert.ok(step, "No 'thinking…' step emitted");
  });

  it("emits at most one thinking… step even for multi-line block", () => {
    const raw =
      "<thinking>\nline one\nline two\nline three\n</thinking>\n" +
      JSON.stringify(done());
    const events = collect(raw);
    const steps = events.filter((e) => e.type === "step" && "text" in e && (e as any).text === "thinking…");
    assert.equal(steps.length, 1);
  });

  it("message after </thinking> is preserved", () => {
    const raw =
      "<thinking>\ninternal reasoning\n</thinking>\n" +
      JSON.stringify(msg("after-thinking")) + "\n" +
      JSON.stringify(done());
    const events = collect(raw);
    const m = events.find((e) => e.type === "message");
    assert.ok(m && "text" in m && (m as any).text === "after-thinking");
  });

  it("raw <thinking> tag does not appear in any event", () => {
    const raw = "<thinking>\nsecret\n</thinking>\n" + JSON.stringify(done());
    const events = collect(raw);
    for (const ev of events) {
      assert.ok(!JSON.stringify(ev).includes("<thinking>"),
        `<thinking> tag leaked: ${JSON.stringify(ev)}`);
      assert.ok(!JSON.stringify(ev).includes("secret"),
        `Thinking content leaked: ${JSON.stringify(ev)}`);
    }
  });
});

describe("parseAgentOutput: inline JSON on prose line", () => {
  it("extracts inline JSON event from prose prefix", () => {
    const raw =
      "Here is my answer: " + JSON.stringify(msg("inline-result")) + "\n" +
      JSON.stringify(done());
    const events = collect(raw);
    const m = events.find((e) => e.type === "message" && "text" in e && (e as any).text === "inline-result");
    assert.ok(m, `Inline message not found. Events: ${JSON.stringify(events)}`);
  });

  it("prose prefix before inline JSON becomes a separate prose message", () => {
    const raw =
      "Prefix text here: " + JSON.stringify(msg("content")) + "\n" +
      JSON.stringify(done());
    const events = collect(raw);
    // Should have at least the "Prefix text here:" prose message AND the inline message
    const proseMsg = events.find((e) =>
      e.type === "message" && "text" in e && (e as any).text.includes("Prefix text here"),
    );
    assert.ok(proseMsg, "Prose prefix was lost");
  });

  it("raw JSON brace { does not appear as visible text", () => {
    const raw =
      "Result: " + JSON.stringify(msg("clean")) + "\n" +
      JSON.stringify(done());
    const events = collect(raw);
    const badMsg = events.find((e) =>
      e.type === "message" && "text" in e && (e as any).text.includes('"type":"message"'),
    );
    assert.equal(badMsg, undefined, "Raw JSON appeared as visible message text");
  });
});

describe("parseAgentOutput: multi-line JSON", () => {
  it("parses JSON split across multiple lines", () => {
    const raw =
      '{"v":1,"type":"message","agent":"pm","to":"user",\n"text":"multi-line"}\n' +
      JSON.stringify(done());
    const events = collect(raw);
    const m = events.find((e) => e.type === "message");
    assert.ok(m && "text" in m && (m as any).text === "multi-line");
  });

  it("does not corrupt depth from string content with braces", () => {
    // A tool.call with a bash command containing braces should still parse
    const toolCall = {
      v: 1, type: "tool.call", id: "tc-1", name: "Bash",
      args: { cmd: "for f in $(ls); do echo {$f}; done" },
      needs_approval: false,
    };
    const raw = JSON.stringify(toolCall) + "\n" + JSON.stringify(done());
    const events = collect(raw);
    const tc = events.find((e) => e.type === "tool.call");
    assert.ok(tc, "tool.call not parsed");
  });
});
