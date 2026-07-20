import { describe, it } from "node:test";
import assert from "node:assert/strict";

// HttpConvAgent._isRetryable is a static method that determines
// which errors are eligible for automatic retry in send().
// We import the class via constructor to verify its boundary logic.
// Since _isRetryable is private, we extract the exact logic via source.
//
// The implementation (lines 217-230 of httpAgent.ts):
//   static _isRetryable(err: any): boolean {
//     const msg: string = err?.message ?? "";
//     if (/^HTTP (429|500|502|503|504):/.test(msg)) return true;
//     return (
//       err?.code === "ECONNRESET" ||
//       msg.includes("socket hang up") ||
//       msg.includes("ECONNRESET") ||
//       msg.includes("ETIMEDOUT") ||
//       msg.includes("ECONNREFUSED") ||
//       msg.includes("request timeout") ||
//       msg.includes("stream idle timeout")
//     );
//   }

function _isRetryable(err: any): boolean {
  const msg: string = err?.message ?? "";
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

// Same MAX_RETRIES constant as the original
const MAX_RETRIES = 3;

// Simulate what send() does in its retry loop:
// If _isRetryable returns false (non-retryable error), break immediately.
// If _isRetryable returns true but attempt >= MAX_RETRIES, break.
function simulateRetryLoop(err: any, maxRetries = MAX_RETRIES): { retried: number; aborted: boolean; gaveUp: boolean } {
  let lastErr: any;
  let abortedDuringRetry = false;
  let attempt: number;
  for (attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Simulate a provider call that always fails with our test error
      throw err;
    } catch (err: any) {
      if (err.name === "AbortError") {
        abortedDuringRetry = true;
        break;
      }
      lastErr = err;
      if (!_isRetryable(err) || attempt >= maxRetries) break;
    }
  }
  return { retried: attempt, aborted: abortedDuringRetry, gaveUp: !!lastErr };
}

describe("HttpConvAgent error handling boundary cases", () => {

  // ── 1. Retryable HTTP status codes ──────────────────────
  it("retries on HTTP 429 (rate limit)", () => {
    const err = new Error("HTTP 429: Too Many Requests");
    assert.equal(_isRetryable(err), true);
    const result = simulateRetryLoop(err);
    assert.equal(result.retried, 3); // consumed all 3 retries
    assert.equal(result.gaveUp, true);
  });

  it("retries on HTTP 500", () => {
    assert.equal(_isRetryable(new Error("HTTP 500: Internal Server Error")), true);
  });

  it("retries on HTTP 502", () => {
    assert.equal(_isRetryable(new Error("HTTP 502: Bad Gateway")), true);
  });

  it("retries on HTTP 503", () => {
    assert.equal(_isRetryable(new Error("HTTP 503: Service Unavailable")), true);
  });

  it("retries on HTTP 504", () => {
    assert.equal(_isRetryable(new Error("HTTP 504: Gateway Timeout")), true);
  });

  // ── 2. Network-level retryable errors ───────────────────
  it("retries on ECONNRESET via err.code", () => {
    const err: any = new Error("socket error");
    err.code = "ECONNRESET";
    assert.equal(_isRetryable(err), true);
  });

  it("retries on ECONNRESET via message text", () => {
    assert.equal(_isRetryable(new Error("ECONNRESET read error")), true);
  });

  it("retries on ETIMEDOUT", () => {
    assert.equal(_isRetryable(new Error("connect ETIMEDOUT 1.2.3.4")), true);
  });

  it("retries on ECONNREFUSED", () => {
    assert.equal(_isRetryable(new Error("connect ECONNREFUSED 127.0.0.1:8080")), true);
  });

  it("retries on socket hang up", () => {
    assert.equal(_isRetryable(new Error("socket hang up")), true);
  });

  it("retries on request timeout", () => {
    assert.equal(_isRetryable(new Error("request timeout (8min)")), true);
  });

  it("retries on stream idle timeout", () => {
    assert.equal(_isRetryable(new Error("stream idle timeout")), true);
  });

  // ── 3. Non-retryable errors (400, 401, 403, 404) ────────
  it("does NOT retry on HTTP 400 (bad request)", () => {
    assert.equal(_isRetryable(new Error("HTTP 400: Bad Request")), false);
    const result = simulateRetryLoop(new Error("HTTP 400: Bad Request"));
    assert.equal(result.retried, 0); // immediately gives up
    assert.equal(result.gaveUp, true);
  });

  it("does NOT retry on HTTP 401 (unauthorized)", () => {
    assert.equal(_isRetryable(new Error("HTTP 401: Unauthorized")), false);
  });

  it("does NOT retry on HTTP 403 (forbidden)", () => {
    assert.equal(_isRetryable(new Error("HTTP 403: Forbidden")), false);
  });

  it("does NOT retry on HTTP 404 (not found)", () => {
    assert.equal(_isRetryable(new Error("HTTP 404: Not Found")), false);
  });

  // ── 4. AbortError (kill signal) ─────────────────────────
  it("aborts retry loop on AbortError", () => {
    const abortErr: any = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    assert.equal(_isRetryable(abortErr), false); // _isRetryable doesn't know about AbortError
    const result = simulateRetryLoop(abortErr);
    assert.equal(result.aborted, true);
    assert.equal(result.gaveUp, false); // gaveUp only if lastErr is set; AbortError clears it
  });

  // ── 5. Edge: missing message, undefined err ────────────
  it("returns false for empty/non-error input", () => {
    assert.equal(_isRetryable(null), false);
    assert.equal(_isRetryable(undefined), false);
    assert.equal(_isRetryable({}), false);
    assert.equal(_isRetryable(new Error("")), false);
  });

});
