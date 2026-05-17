import { ANSI } from "./types.js";
import { isatty } from "node:tty";

/**
 * Terminal screen management for SpawnTUI.
 *
 * Manages raw mode, alternate screen buffer, resize events, mouse tracking,
 * kitty keyboard protocol, and cleanup on process exit.
 */
export class Screen {
  private _entered = false;
  private _originalRawMode: boolean | null = null;
  private _resizeCallbacks: Array<(width: number, height: number) => void> = [];
  private _keyCallbacks: Array<(buf: Buffer) => void> = [];
  private _sigwinchHandler: (() => void) | null = null;
  private _sigintHandler: ((signal: NodeJS.Signals) => void) | null = null;
  private _sigtermHandler: ((signal: NodeJS.Signals) => void) | null = null;
  private _exitHandler: ((code: number) => void) | null = null;
  private _uncaughtHandler: ((err: Error) => void) | null = null;

  /**
   * Enable terminal raw mode and switch to alternate screen buffer.
   * Also enables mouse tracking, kitty keyboard protocol, hides cursor,
   * and clears the screen.
   */
  enter(): void {
    if (this._entered) return;

    try {
      const isTTY = isatty((process.stdin as any).fd ?? 0);

      if (isTTY) {
        try {
          this._originalRawMode = (process.stdin as any).isRaw ?? false;
          const stdin = process.stdin as any;
          if (typeof stdin.setRawMode === 'function') {
            stdin.setRawMode(true);
            stdin.resume();
          }
        } catch {
          this._originalRawMode = null;
        }
      }

      // Switch to alternate screen
      process.stdout.write(ANSI.ALT_SCREEN);

      process.stdout.write(ANSI.ENABLE_MOUSE);

      process.stdout.write(ANSI.HIDE_CURSOR);
      process.stdout.write(ANSI.HIDE_CURSOR);

      // Clear screen and move cursor to home position
      process.stdout.write(ANSI.CLEAR_SCREEN);
      process.stdout.write(ANSI.CURSOR_HOME);

      // Subscribe to resize events
      this._sigwinchHandler = () => this._notifyResize();
      process.on("SIGWINCH", this._sigwinchHandler);

      // Register cleanup on process termination
      this._exitHandler = () => this.exit();
      process.on("exit", this._exitHandler);

      this._sigintHandler = () => {
        this.exit();
        process.exit(130);
      };
      process.on("SIGINT", this._sigintHandler);

      this._sigtermHandler = () => {
        this.exit();
        process.exit(143);
      };
      process.on("SIGTERM", this._sigtermHandler);

      this._uncaughtHandler = (err: Error) => {
        process.stderr.write(`Uncaught exception: ${err.message}\n`);
        this.exit();
        process.exit(1);
      };
      process.on("uncaughtException", this._uncaughtHandler);

      this._entered = true;

      // Notify resize callbacks immediately with current size
      this._notifyResize();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Screen.enter() failed: ${msg}\n`);
    }
  }

  /**
   * Restore terminal state:
   * - Disable mouse tracking
   * - Disable kitty keyboard protocol
   * - Show cursor
   * - Switch back to normal screen buffer
   * - Restore raw mode (if applicable)
   * - Remove signal/exit handlers
   */
  exit(): void {
    if (!this._entered) return;

    try {
      process.stdout.write(ANSI.DISABLE_MOUSE);

      process.stdout.write(ANSI.SHOW_CURSOR);

      process.stdout.write(ANSI.NORMAL_SCREEN);

      // Restore raw mode
      if (isatty((process.stdin as any).fd ?? 0) && this._originalRawMode !== null) {
        try {
          const stdin = process.stdin as any;
          if (typeof stdin.setRawMode === 'function') {
            stdin.setRawMode(this._originalRawMode);
          }
        } catch {}
      }

      // Remove SIGWINCH handler
      if (this._sigwinchHandler) {
        process.off("SIGWINCH", this._sigwinchHandler);
        this._sigwinchHandler = null;
      }

      // Remove exit handler
      if (this._exitHandler) {
        process.off("exit", this._exitHandler);
        this._exitHandler = null;
      }

      // Remove SIGINT handler
      if (this._sigintHandler) {
        process.off("SIGINT", this._sigintHandler);
        this._sigintHandler = null;
      }

      // Remove SIGTERM handler
      if (this._sigtermHandler) {
        process.off("SIGTERM", this._sigtermHandler);
        this._sigtermHandler = null;
      }

      // Remove uncaughtException handler
      if (this._uncaughtHandler) {
        process.off("uncaughtException", this._uncaughtHandler);
        this._uncaughtHandler = null;
      }

      this._entered = false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Screen.exit() failed: ${msg}\n`);
    }
  }

  /**
   * Register a callback to be invoked whenever the terminal is resized.
   * Also called immediately with the current terminal size.
   */
  onResize(callback: (width: number, height: number) => void): void {
    this._resizeCallbacks.push(callback);
    // Call immediately with current size
    const size = this.getSize();
    callback(size.width, size.height);
  }

  /**
   * Register a callback to be invoked for raw stdin data.
   */
  onKey(callback: (buf: Buffer) => void): void {
    this._keyCallbacks.push(callback);
    process.stdin.on("data", callback);
  }

  /**
   * Return the current terminal dimensions.
   * Falls back to 80×24 if columns/rows are unavailable.
   */
  getSize(): { width: number; height: number } {
    const width = process.stdout.columns ?? 80;
    const height = process.stdout.rows ?? 24;
    return { width, height };
  }

  /**
   * Set the terminal window title via OSC escape sequence.
   */
  setTitle(title: string): void {
    // OSC 0 ; title ST  (ST = \x1b\\ or \x07)
    process.stdout.write(`\x1b]0;${title}\x07`);
  }

  /** Notify all registered resize callbacks with current dimensions. */
  private _notifyResize(): void {
    const { width, height } = this.getSize();
    for (const cb of this._resizeCallbacks) {
      try {
        cb(width, height);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Resize callback error: ${msg}\n`);
      }
    }
  }
}

/** Singleton screen instance. */
export const screen = new Screen();
