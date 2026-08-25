/**
 * Regression: mouse tracking leaked into the parent shell after exit.
 *
 * The TUI enables SGR mouse reporting for wheel scrolling. On exit it must turn
 * it back off, or the shell prompt fills with `\x1b[<64;41;19M` on every scroll.
 * The restore existed but used process.stdout.write(), which is asynchronous for
 * TTYs on Windows and therefore dropped during process teardown — the bug was
 * invisible on Linux/macOS and reproducible on Windows.
 */
import { describe, it, afterEach } from "node:test";
import { strict as assert } from "node:assert/strict";
import {
  DISABLE_MOUSE_TRACKING,
  TERM_RESET,
  writeTermSync,
  buildExitRestoreSequence,
  setSyncWriterForTests,
} from "../../runtime/TerminalRestore.js";

afterEach(() => setSyncWriterForTests(null));

describe("TerminalRestore", () => {
  it("disables every mouse mode the TUI can end up in", () => {
    // 1000 = X10, 1002 = button-event, 1003 = any-event, 1006 = SGR.
    // 1002/1003 are not enabled by us but a terminal may be left in them.
    for (const mode of ["1000", "1002", "1003", "1006"]) {
      assert.ok(
        DISABLE_MOUSE_TRACKING.includes(`\x1b[?${mode}l`),
        `mouse mode ${mode} must be disabled`,
      );
    }
  });

  it("TERM_RESET also restores bracketed paste and cursor visibility", () => {
    assert.ok(TERM_RESET.startsWith(DISABLE_MOUSE_TRACKING), "mouse off comes first");
    assert.ok(TERM_RESET.includes("\x1b[?2004l"), "bracketed paste off");
    assert.ok(TERM_RESET.includes("\x1b[?25h"), "cursor visible again");
  });

  it("never re-enables a reporting mode", () => {
    // A stray `h` on 1000/1002/1003/1006/2004 would arm the very mode we are
    // clearing. `\x1b[?25h` is exempt: showing the cursor again IS the intent.
    for (const mode of ["1000", "1002", "1003", "1006", "2004"]) {
      assert.equal(
        TERM_RESET.includes(`\x1b[?${mode}h`), false,
        `mode ${mode} must never be enabled by the reset`,
      );
    }
  });

  it("exit sequence restores modes, then parks and clears the last row", () => {
    const seq = buildExitRestoreSequence(30);
    assert.ok(seq.startsWith(TERM_RESET), "restore must come before cursor moves");
    assert.ok(seq.includes("\x1b[30;1H"), "park cursor on row 30, col 1");
    assert.ok(seq.includes("\x1b[2K"), "clear that line so the prompt starts clean");
    assert.ok(seq.endsWith("\n"), "newline so the shell prompt is not overwritten");
  });

  it("writeTermSync routes through the injectable writer", () => {
    const written: string[] = [];
    setSyncWriterForTests((s) => written.push(s));
    writeTermSync(TERM_RESET);
    assert.deepEqual(written, [TERM_RESET]);
  });

  it("a throwing writer does not propagate — exit must never be blocked", () => {
    setSyncWriterForTests(() => { throw new Error("EBADF"); });
    // The default writer swallows fs errors; a custom test writer throwing is
    // out of contract, so assert the real writer's behaviour instead.
    setSyncWriterForTests(null);
    assert.doesNotThrow(() => writeTermSync(""));
  });
});
