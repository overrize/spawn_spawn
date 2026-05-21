// registry-enoent.test.ts
// Regression: Glob/Grep must return ok:false (not silent ok:true) when rg binary is missing.
//
// mock.module() is incompatible with tsx's ESM loader, so we test the
// extracted rgNotFoundResult() helper directly — this is the exact code
// path that both Glob and Grep call in their catch blocks.

import { describe, it } from "node:test";
import { strict as assert } from "node:assert/strict";
import { rgNotFoundResult } from "../tools/registry.js";

function enoent(): unknown {
  return Object.assign(new Error("spawn rg ENOENT"), { code: "ENOENT" });
}
function otherErr(code: string | null = null): unknown {
  return Object.assign(new Error("rg exited 1"), { code, status: 1 });
}

describe("rgNotFoundResult — ENOENT detection (Glob/Grep catch-block logic)", () => {
  it("ENOENT → returns ok:false with rg-not-found message for Glob", () => {
    const r = rgNotFoundResult(enoent(), "Glob");
    assert.ok(r !== null, "should not return null for ENOENT");
    assert.equal(r!.ok, false,
      "Before fix: returned ok:true/'(no files)'. After fix: ok:false.");
    assert.match(r!.output, /ripgrep.*not found/i);
  });

  it("ENOENT → returns ok:false with rg-not-found message for Grep", () => {
    const r = rgNotFoundResult(enoent(), "Grep");
    assert.ok(r !== null);
    assert.equal(r!.ok, false,
      "Before fix: returned ok:true/'(no matches)'. After fix: ok:false.");
    assert.match(r!.output, /ripgrep.*not found/i);
  });

  it("non-ENOENT error (exit 1 / no matches) → returns null (fall through to ok)", () => {
    assert.equal(rgNotFoundResult(otherErr(null), "Grep"), null);
    assert.equal(rgNotFoundResult(otherErr("1"),  "Glob"), null);
  });

  it("ENOENT code must match exactly — 'ENOENT' string only", () => {
    assert.equal(rgNotFoundResult(otherErr("ENOTFOUND"), "Grep"), null);
    assert.equal(rgNotFoundResult(otherErr("EACCES"),   "Glob"), null);
  });
});
