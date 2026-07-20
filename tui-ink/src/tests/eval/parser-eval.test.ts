/**
 * M2-4 · Parser eval set — real-world bad outputs distilled from tui.log.
 *
 * Mining stats behind this file (2026-07-21, tui.log ~47MB of live sessions):
 *   3500× "JSON parse FAILED", 3146× PROMPT_HEALTH fallback, 9× unknown event type.
 *   Dominant real failure: the model answers in plain markdown (no protocol JSON)
 *   and EVERY LINE becomes a separate fallback message — output fragmentation.
 *
 * Every case asserts CURRENT behavior (characterization). Cases whose current
 * behavior is a known deficiency carry an XFAIL note with the improvement
 * target (mostly WS1/M2 native rail or salvage logic). The final summary test
 * pins the XFAIL list — fixing one on purpose requires consciously updating it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseAgentOutput } from "../../protocol/normalizer.js";
import { fmt } from "../support/orchestrationHarness.js";

function parse(raw: string, agentId = "a1"): string[] {
  const out: string[] = [];
  parseAgentOutput(raw, agentId, (ev) => out.push(fmt(ev)));
  return out;
}

interface ParserCase {
  id: string;
  note: string;
  raw: string;
  expect: string[];
  /** Present = current behavior is a known deficiency; value = improvement target. */
  xfail?: string;
}

const CASES: ParserCase[] = [
  // ── Green: repair pipeline works as designed ──────────────────────────────
  {
    id: "P-01", note: "markdown fence stripped",
    raw: '```json\n{"type":"step","text":"walk"}\n```',
    expect: [`step a1 "walk"`],
  },
  {
    id: "P-02", note: "<thinking> collapses to single step",
    raw: `<thinking>\n内部推理\n</thinking>\n{"type":"message","to":"user","text":"结论"}`,
    expect: [`step a1 "thinking…"`, `message a1→user "结论"`],
  },
  {
    id: "P-03", note: "inline JSON after prose on same line",
    raw: `收到 {"type":"step","text":"分析中"}`,
    expect: [`message a1→user "收到" (fallback)`, `step a1 "分析中"`],
  },
  {
    id: "P-04", note: "unescaped newline inside string repaired",
    raw: `{"type":"message","to":"user","text":"第一行\n第二行"}`,
    expect: [`message a1→user "第一行\n第二行"`],
  },
  {
    id: "P-05", note: "missing closing brace repaired",
    raw: `{"type":"step","text":"未闭合"`,
    expect: [`step a1 "未闭合"`],
  },
  {
    id: "P-06", note: "plaintext agent.done synthesized",
    raw: `任务完成了，agent.done`,
    expect: [`agent.done a1 success`],
  },
  {
    id: "P-07", note: "unknown lowercase type dropped silently",
    raw: `{"type":"planning","text":"内部计划"}`,
    expect: [],
  },

  // ── Real-world derived (tui.log) ──────────────────────────────────────────
  {
    id: "R-01", note: "plain markdown reply fragments into one fallback PER LINE",
    raw: [
      "强化学习在人形机器人的方法越来越多，主流集中在这几类：",
      "**1. 主流方法（大致三类）**",
      "- **端到端模型自由RL（如PPO/SAC）**",
      "直接在仿真里通过大量试错学出运动策略。",
      "- **模仿学习+RL微调**",
      "先用动捕数据训练初步策略，再用RL优化。",
    ].join("\n"),
    expect: [
      `message a1→user "强化学习在人形机器人的方法越来越多，主流集中在这几类：" (fallback)`,
      `message a1→user "**1. 主流方法（大致三类）**" (fallback)`,
      `message a1→user "- **端到端模型自由RL（如PPO/SAC）**" (fallback)`,
      `message a1→user "直接在仿真里通过大量试错学出运动策略。" (fallback)`,
      `message a1→user "- **模仿学习+RL微调**" (fallback)`,
      `message a1→user "先用动捕数据训练初步策略，再用RL优化。" (fallback)`,
    ],
    xfail: "6 行回复碎成 6 条消息（真实日志 3146 次 fallback 的主体）。目标：连续 fallback 行合并为一条 message（短期），native 轨结构性消除（M2 WS1）",
  },
  {
    id: "R-02", note: "capitalized type Think dropped (case-sensitive VALID_TYPES)",
    raw: `{"type":"Think","thought":"先看 registry"}`,
    expect: [],
    xfail: "真实日志 5 次。目标：type 归一化（小写化 + Think→think）后再查表",
  },
  {
    id: "R-03", note: "underscore variant tool_result dropped",
    raw: `{"type":"tool_result","id":"t1","ok":true,"output":"x"}`,
    expect: [],
    xfail: "真实日志 1 次。目标：同 R-02，_/. 归一化；native 轨后不存在",
  },
  {
    id: "R-04", note: "tool name used as event type (Bash) dropped",
    raw: `{"type":"Bash","command":"ls"}`,
    expect: [],
    xfail: "真实日志 2 次（含 'Bash备用'）。目标：识别注册表工具名 → 合成 tool.call",
  },
  {
    id: "R-05", note: "valid JSON followed by trailing garbage — entire content evaporates",
    raw: `{"v":1,"type":"step","text":"整合四个章节成完整报告"}$$$`,
    expect: [],
    xfail: "真实日志案例（tl-01）。目标：截断到最后一个平衡 } 再 parse，垃圾尾巴丢弃而非全丢",
  },
  {
    id: "R-06", note: "long message truncated mid-string (max_tokens) — content evaporates",
    raw: `{"v":1,"type":"message","to":"user","text":"已完成分析。以下是完整的根因分析和修复方案。\\n\\n## 一、重复消息的根因`,
    expect: [],
    xfail: "真实日志案例（feishu-analyzer-01，TL 输出蒸发根源之一）。目标：未终结字符串补引号+闭括号抢救 text 前缀",
  },
];

describe("M2-4 parser eval set (real-world derived)", () => {
  for (const c of CASES) {
    it(`${c.id} ${c.note}${c.xfail ? " [XFAIL]" : ""}`, () => {
      assert.deepEqual(parse(c.raw), c.expect, c.xfail ? `XFAIL: ${c.xfail}` : c.note);
    });
  }

  it("XFAIL ledger is explicit — fixing one requires updating the eval set consciously", () => {
    const xfails = CASES.filter((c) => c.xfail).map((c) => c.id);
    assert.deepEqual(xfails, ["R-01", "R-02", "R-03", "R-04", "R-05", "R-06"]);
  });
});
