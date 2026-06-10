/**
 * Headless test: pm.md structural guard for Stage 0 fast-answer gate.
 *
 * Reads prompts/pm.md as a static text file and asserts:
 * - Stage 0 section exists with "快速回答闸" keyword
 * - Stage 0 appears before Stage 1 in the document
 * - The flowchart lists Stage 0 at the top
 * - Required condition table keywords are present
 * - Stage labels are in order: 0 → 1 → 2 → 3 → 4
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

// Resolve prompts/pm.md from the repo root (two levels up from src/tests/e2e/headless/)
const PM_MD = path.resolve(
  new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"),
  "../../../../../prompts/pm.md",
);

const content = fs.readFileSync(PM_MD, "utf8");

describe("stage0-prompt-guard: pm.md structural invariants", () => {

  it("pm.md file is readable and non-empty", () => {
    assert.ok(content.length > 100, `pm.md appears empty or missing at ${PM_MD}`);
  });

  it("Stage 0 section with '快速回答闸' exists", () => {
    assert.ok(
      content.includes("快速回答闸"),
      "pm.md must contain '快速回答闸' as the Stage 0 heading keyword",
    );
  });

  it("Stage 0 appears before Stage 1 in the document", () => {
    const idx0 = content.indexOf("Stage 0");
    const idx1 = content.indexOf("Stage 1");
    assert.ok(idx0 >= 0, "Stage 0 not found in pm.md");
    assert.ok(idx1 >= 0, "Stage 1 not found in pm.md");
    assert.ok(idx0 < idx1, `Stage 0 (pos ${idx0}) must come before Stage 1 (pos ${idx1})`);
  });

  it("Stage 1 is '并发状态感知'", () => {
    assert.ok(
      content.includes("Stage 1") && content.includes("并发状态感知"),
      "Stage 1 must be labeled '并发状态感知'",
    );
    // Verify they appear close together (within 80 chars)
    const idx = content.indexOf("Stage 1");
    const nearby = content.slice(idx, idx + 80);
    assert.ok(
      nearby.includes("并发状态感知"),
      `'并发状态感知' must appear in the Stage 1 heading, found: "${nearby.slice(0, 60)}"`,
    );
  });

  it("flowchart block contains Stage 0 → 1 → 2 → 3 → 4 in order", () => {
    // Find the flowchart block
    const chartStart = content.indexOf("Stage 0 快速回答闸");
    assert.ok(chartStart >= 0, "flowchart must start with 'Stage 0 快速回答闸'");

    // After Stage 0 in the flowchart, the other stages must follow in order
    const chartSection = content.slice(chartStart, chartStart + 400);
    const pos1 = chartSection.indexOf("Stage 1");
    const pos2 = chartSection.indexOf("Stage 2");
    const pos3 = chartSection.indexOf("Stage 3");
    const pos4 = chartSection.indexOf("Stage 4");
    assert.ok(pos1 > 0, "Stage 1 must appear after Stage 0 in flowchart");
    assert.ok(pos2 > pos1, "Stage 2 must appear after Stage 1 in flowchart");
    assert.ok(pos3 > pos2, "Stage 3 must appear after Stage 2 in flowchart");
    assert.ok(pos4 > pos3, "Stage 4 must appear after Stage 3 in flowchart");
  });

  it("Stage 0 conditions table has all 4 required conditions (a)-(d)", () => {
    const s0Start = content.indexOf("Stage 0 —");
    assert.ok(s0Start >= 0, "Stage 0 section header not found");
    const s0Section = content.slice(s0Start, s0Start + 1000);
    assert.ok(s0Section.includes("(a)"), "condition (a) missing from Stage 0 table");
    assert.ok(s0Section.includes("(b)"), "condition (b) missing from Stage 0 table");
    assert.ok(s0Section.includes("(c)"), "condition (c) missing from Stage 0 table");
    assert.ok(s0Section.includes("(d)"), "condition (d) missing from Stage 0 table");
  });

  it("Stage 0 has positive examples (直接回答)", () => {
    assert.ok(
      content.includes("直接回答的典型示例") || content.includes("✅ 直接回答"),
      "Stage 0 must have positive examples section",
    );
  });

  it("Stage 0 has counter-examples referencing Stage 3 spawn", () => {
    // The counter-examples should reference spawning (Stage 3)
    const s0Start = content.indexOf("Stage 0 —");
    const s1Start = content.indexOf("Stage 1 —");
    assert.ok(s0Start >= 0 && s1Start > s0Start);
    const s0Section = content.slice(s0Start, s1Start);
    assert.ok(
      s0Section.includes("Stage 3") || s0Section.includes("spawn"),
      "Stage 0 counter-examples must reference Stage 3 or spawn",
    );
  });

  it("no orphan 'Stage 2 — 快速路由' section (renamed to Stage 3)", () => {
    assert.ok(
      !content.includes("Stage 2 — 快速路由"),
      "Old 'Stage 2 — 快速路由' must be renamed to 'Stage 3 — 快速路由'",
    );
  });

  it("no orphan 'Stage 3 — spawn 后' section (renamed to Stage 4)", () => {
    // Allow "Stage 3 — 快速路由" but not "Stage 3 — spawn 后"
    assert.ok(
      !content.includes("Stage 3 — spawn 后"),
      "Old 'Stage 3 — spawn 后' must be renamed to 'Stage 4 — spawn 后'",
    );
  });
});
