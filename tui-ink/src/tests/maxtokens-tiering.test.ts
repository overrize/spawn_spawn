/**
 * Unit tests: resolveMaxTokens tiering.
 *
 * Verifies the role+depth→max_tokens mapping without any HTTP calls.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveMaxTokens } from "../config.js";

describe("resolveMaxTokens: role/depth tiering", () => {

  it("Secretary always returns 1024 regardless of depth", () => {
    assert.equal(resolveMaxTokens("Secretary"),    1024);
    assert.equal(resolveMaxTokens("Secretary", 0), 1024);
    assert.equal(resolveMaxTokens("Secretary", 2), 1024);
  });

  it("Worker always returns 8192 regardless of depth", () => {
    assert.equal(resolveMaxTokens("Worker"),    8192);
    assert.equal(resolveMaxTokens("Worker", 1), 8192);
    assert.equal(resolveMaxTokens("Worker", 2), 8192);
  });

  it("Leader at depth=0 (PM) returns 2048", () => {
    assert.equal(resolveMaxTokens("Leader", 0), 2048);
  });

  it("Leader at depth=1 (TL) returns 4096", () => {
    assert.equal(resolveMaxTokens("Leader", 1), 4096);
  });

  it("Leader at unknown depth returns 8192 fallback", () => {
    assert.equal(resolveMaxTokens("Leader"),    8192);
    assert.equal(resolveMaxTokens("Leader", 2), 8192);
    assert.equal(resolveMaxTokens("Leader", 3), 8192);
  });

  it("unknown role returns 8192 fallback", () => {
    assert.equal(resolveMaxTokens("Unknown"),    8192);
    assert.equal(resolveMaxTokens("unknown", 0), 8192);
  });
});
