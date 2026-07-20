import { describe, it } from "node:test";
import assert from "node:assert";

/**
 * Test the _isRetryable logic and send() error handling boundaries
 * for HttpConvAgent.
 *
 * Since _isRetryable is private (static), we re-implement the same logic
 * here to verify its correctness against edge cases.
 */
function isRetryable(err: any): boolean {
  const msg: string = err?.message ?? "";
  // HTTP 429 (rate limit) and 5xx (server errors) are retryable
  if (/^HTTP (429|500|502|503|504):/.test(msg)) return true;
  return (
    err?.code === "ECONNRESET" ||
    msg.includes("socket hang up") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("request timeout") ||
    msg.includes("stream idle timeout")
  );
}

// ── Boundary 1: null / undefined / malformed error objects ──
describe("_isRetryable edge cases — null/undefined/malformed", () => {
  it("returns false for null", () => {
    assert.strictEqual(isRetryable(null), false);
  });

  it("returns false for undefined", () => {
    assert.strictEqual(isRetryable(undefined), false);
  });

  it("returns false for a plain string (not an Error)", () => {
    assert.strictEqual(isRetryable("network error"), false);
  });

  it("returns false for an object without message", () => {
    assert.strictEqual(isRetryable({ code: "SOMETHING" }), false);
  });

  it("returns false for number (NaN/Infinity are coerced to string)", () => {
    assert.strictEqual(isRetryable(42), false);
  });

  it("returns false for empty object", () => {
    assert.strictEqual(isRetryable({}), false);
  });
});

// ── Boundary 2: HTTP 4xx errors (should NOT be retryable) ──
describe("_isRetryable — HTTP 4xx except 429", () => {
  for (const code of [400, 401, 403, 404, 405, 422, 499]) {
    it(`returns false for HTTP ${code}`, () => {
      assert.strictEqual(isRetryable(new Error(`HTTP ${code}: Bad Request`)), false);
    });
  }

  it("returns true for HTTP 429 (rate limit)", () => {
    assert.strictEqual(isRetryable(new Error("HTTP 429: Too Many Requests")), true);
  });
});

// ── Boundary 3: HTTP 5xx errors (should be retryable) ──
describe("_isRetryable — HTTP 5xx", () => {
  for (const code of [500, 502, 503, 504]) {
    it(`returns true for HTTP ${code}`, () => {
      assert.strictEqual(isRetryable(new Error(`HTTP ${code}: Server Error`)), true);
    });
  }

  it("returns false for HTTP 505 (unsupported version — not in whitelist)", () => {
    assert.strictEqual(isRetryable(new Error("HTTP 505: Version Not Supported")), false);
  });
});

// ── Boundary 4: Network error codes ──
describe("_isRetryable — network-level errors", () => {
  it("returns true for ECONNRESET via error.code", () => {
    const err: any = new Error("read ECONNRESET");
    err.code = "ECONNRESET";
    assert.strictEqual(isRetryable(err), true);
  });

  it("returns true for socket hang up in message", () => {
    assert.strictEqual(isRetryable(new Error("socket hang up")), true);
  });

  it("returns true for ETIMEDOUT", () => {
    const err: any = new Error("connect ETIMEDOUT");
    err.code = "ETIMEDOUT";
    assert.strictEqual(isRetryable(err), true);
  });

  it("returns true for ECONNREFUSED", () => {
    const err: any = new Error("connect ECONNREFUSED");
    err.code = "ECONNREFUSED";
    assert.strictEqual(isRetryable(err), true);
  });

  it("returns true for request timeout", () => {
    assert.strictEqual(isRetryable(new Error("request timeout")), true);
  });

  it("returns true for stream idle timeout", () => {
    assert.strictEqual(isRetryable(new Error("stream idle timeout")), true);
  });
});

// ── Boundary 5: err.code on object without message ──
describe("_isRetryable — err.code without message", () => {
  it("returns true for ECONNRESET code even if message is empty", () => {
    assert.strictEqual(isRetryable({ code: "ECONNRESET", message: "" }), true);
  });

  it("returns false for unknown code with empty message", () => {
    assert.strictEqual(isRetryable({ code: "EUNKNOWN", message: "" }), false);
  });
});
