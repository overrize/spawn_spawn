/**
 * Headless test: pm.md slim guard.
 *
 * Asserts that pm.md stays ≤180 lines and that pm-reference.md exists with
 * the expected reference sections. Prevents accidental re-inflation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const PROMPTS_DIR = path.resolve(
  new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"),
  "../../../../../prompts",
);

const PM_MD  = path.join(PROMPTS_DIR, "pm.md");
const REF_MD = path.join(PROMPTS_DIR, "pm-reference.md");

describe("pm-slim-guard: line budget and reference split", () => {

  it("pm.md is ≤180 lines", () => {
    const content = fs.readFileSync(PM_MD, "utf8");
    const lines = content.split("\n").length;
    assert.ok(
      lines <= 180,
      `pm.md is ${lines} lines — must stay ≤180 (cache prefix budget). Trim or move content to pm-reference.md.`,
    );
  });

  it("pm-reference.md exists and is non-empty", () => {
    assert.ok(fs.existsSync(REF_MD), "pm-reference.md must exist alongside pm.md");
    const content = fs.readFileSync(REF_MD, "utf8");
    assert.ok(content.length > 200, "pm-reference.md appears empty");
  });

  it("pm.md contains a link to pm-reference.md", () => {
    const content = fs.readFileSync(PM_MD, "utf8");
    assert.ok(
      content.includes("pm-reference.md"),
      "pm.md must contain at least one reference link to pm-reference.md",
    );
  });

  it("pm-reference.md contains moved sections: 任务类型, Goal, HTML提取", () => {
    const content = fs.readFileSync(REF_MD, "utf8");
    assert.ok(content.includes("任务类型"),         "pm-reference.md must contain '任务类型' section");
    assert.ok(content.includes("Goal"),              "pm-reference.md must contain 'Goal' writing rules");
    assert.ok(content.includes("HTML"),              "pm-reference.md must contain HTML extraction template");
  });
});
