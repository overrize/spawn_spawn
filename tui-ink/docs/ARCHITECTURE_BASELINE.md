# Spawn Architecture Baseline

Date: 2026-06-17

This document freezes the current behavior before the full-duplex foundation
refactor. It is a baseline, not a target design. If current behavior is later
found to be wrong, fix it in a dedicated behavior-change step after the
equivalence refactor has a clean reference point.

## Baseline Commands

Current results:

- `npm run typecheck`: pass
- `npm test`: pass, 280 tests, 0 failures
- `node --import tsx/esm --test src/tests/baseline/full-duplex-golden.test.ts`: pass, 4 tests, 0 failures

If any existing test fails in a future baseline refresh, do not edit or skip the
test to make it green. Record the failure here with whether it appears to be a
real product bug or an obsolete test.

## Current Full-Duplex Path

The current Feishu full-duplex implementation is mostly embedded in
`src/index.tsx`:

- Incoming Feishu frames are parsed in `src/feishu/websocket.ts`.
- Consecutive user fragments are merged by `FeishuInputWindowManager`.
- Per-user sessions are mapped to deterministic PM ids.
- A base PM turn holds `feishuBusy`.
- If the base PM is busy and capacity is available, a lightweight fork PM is
  started for the new message.
- If base + forks are at capacity, the new message enters `feishuPendingQueue`.
- Fork answers are buffered in arrival order and later merged back into the
  base PM history.
- Completed fork Q/A may be flushed into the base PM before the next base turn.
- User-visible output is routed through `OutboundGateway` and then a Feishu
  reply aggregator/card renderer.

The implementation already has useful tests under `src/tests/feishu/`, but much
of the production state machine still lives in `index.tsx` closures. The new
baseline test records explicit event timelines so the refactor can compare
behavior before and after extracting `InboundGateway`, `ProtocolNormalizer`, and
`ConversationRuntime`.

## Golden Baseline Coverage

New file:

- `src/tests/baseline/full-duplex-golden.test.ts`

Covered current behavior:

- Base PM idle: accepted message is delivered directly to the base PM turn.
- Base PM busy: new messages start fork turns until fork capacity is full.
- Base PM + forks full: further messages enter pending queue.
- Fork completes while a pending item exists: pending item is drained and starts
  as the next fork when capacity allows.
- Multiple forks complete out of order: merge back into base history is sorted
  by arrival sequence, not completion order.
- Base turn end: buffered fork Q/A is appended to the base checkpoint.
- Base idle before next turn: buffered fork Q/A is flushed before the next direct
  base dispatch.
- Empty messages are skipped.
- Same-content duplicate messages inside the current short window are skipped.
- Late tool results for done/killed workers are dropped instead of delivered.

These tests intentionally assert the current timeline exactly. They are not
allowed to encode idealized behavior that the current code does not have.

## Existing Related Coverage

Already present:

- `src/tests/feishu/input-window.test.ts`: input fragment merge window behavior.
- `src/tests/feishu/reply-aggregator.test.ts`: Feishu reply aggregation and send
  failure recovery.
- `src/tests/feishu/outbound.test.ts`: suppress/filter/format/sanitize rules for
  user-visible Feishu output.
- `src/tests/feishu/concurrent-dispatch.test.ts`: basic concurrent dispatch
  simulation.
- `src/tests/feishu/concurrent-scenarios.test.ts`: larger Phase B/C/D/E
  concurrency and merge-back simulation.
- `src/tests/e2e/headless/protocol-parsing.test.ts`: current model-output
  protocol parser behavior.

## Uncovered Risks

The following remain intentionally marked as not fully covered by pure unit
tests:

- Real Feishu WebSocket protobuf frame variants beyond the currently simulated
  message shapes.
- Real Feishu API send/reply/card patch failures under network latency and rate
  limits.
- True concurrent Node event-loop ordering between SSE stream completion,
  `setImmediate` callbacks, tool execution, and Feishu message arrival.
- Real LLM protocol drift across model providers, especially DeepSeek-family
  prose output and malformed JSON in long sessions.
- TUI user interactions during active Feishu sessions, including ESC/killed
  state interactions with external message arrival.
- End-to-end scheduled task behavior against a real LLM/Feishu session. The
  pure `TaskScheduler` is covered, and the TUI `/schedule` loop is wired, but
  delivery completion is currently "task handed to PM", not "PM finished work".

Do not write fake unit tests that only appear to cover these risks. Either build
a real integration harness or leave the gap documented here.

## Equivalence Verification Protocol

For every future extraction step:

1. Run `npm run typecheck`.
2. Run `node --import tsx/esm --test src/tests/baseline/full-duplex-golden.test.ts`.
3. Run the affected focused tests, for example `src/tests/feishu/*.test.ts` or
   protocol parser tests.
4. Run `npm test` when the change is not trivial.
5. Compare the golden event sequence. Any mismatch must be classified as one of:
   - refactor regression, fix before proceeding;
   - intentional behavior change, document the reason and update the baseline in
     the same change;
   - old baseline was incomplete or wrong, document why before updating it.

Recommended refactor order after this baseline:

1. Inbound/Outbound message layer alignment. Initial Feishu inbound parser extraction is complete.
2. ProtocolNormalizer. Complete as `src/protocol/normalizer.ts`, with `httpAgent.ts` compatibility re-export.
3. ConversationRuntime. Pure runtime extracted and covered by golden-aligned tests; production Feishu scheduling still uses the existing `index.tsx` path, with `ConversationRuntime` wired in shadow mode behind `SPAWN_SHADOW_RUNTIME=1`.
4. DeepSeek v4 model validation before the 2026-07-24 migration deadline. Not yet run; requires real model credentials/environment.
5. TurnController, Worker first and PM/Leader second. Initial pure turn-state controller is extracted; production Worker/PM loops still use existing closure state, with `TurnController` wired in shadow mode behind `SPAWN_SHADOW_TURN=1`.
6. ExecutionBoundary. Workspace path boundary is extracted and wired into file/search tools (`Read`, `Write`, `Edit`, `Grep`, `Glob`, `LS`) while allowing workspace and OS temp roots.
7. TaskScheduler. Pure scheduler runtime is extracted and connected to TUI commands `/schedule` and `/tasks`; Feishu-facing scheduled task UX is still pending.

## Shadow Mode Requirement

Each extracted module should first run in shadow mode where practical:

- old path continues to drive production behavior;
- new module receives the same inputs;
- outputs are compared in logs or tests;
- only after outputs match should production routing switch to the new module;
- old code should be deleted only after the new path has focused tests and the
  golden baseline remains stable.
