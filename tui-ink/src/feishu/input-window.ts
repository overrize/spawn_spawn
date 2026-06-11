// Per-user input-merge window.
// Buffers rapid consecutive messages from the same user and flushes them as
// one combined input after a configurable silence gap (default 1500 ms).
// This prevents a single thought split across multiple quick messages from
// triggering N separate PM turns.
//
// Event-ID dedup is handled upstream (websocket.ts seenEventIds).
// This class only deals with merging, not dedup.

export interface WindowFragment {
  text: string;
  messageId: string;
}

/** Called when the silence timer expires or flush() is invoked explicitly. */
export type FlushCallback = (
  openId: string,
  mergedText: string,
  anchorMessageId: string, // first fragment's messageId — used as Feishu reply anchor
  chatId: string,
  chatType: string,
) => void;

interface Window {
  fragments: WindowFragment[];
  timer: ReturnType<typeof setTimeout>;
  anchorMessageId: string;
  chatId: string;
  chatType: string;
}

export class FeishuInputWindowManager {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly windowMs: number,
    private readonly onFlush: FlushCallback,
  ) {}

  /** Feed an incoming message into the window for openId. */
  feed(openId: string, text: string, messageId: string, chatId: string, chatType: string): void {
    const win = this.windows.get(openId);
    if (win) {
      win.fragments.push({ text, messageId });
      clearTimeout(win.timer);
      win.timer = setTimeout(() => this._flush(openId), this.windowMs);
      process.stderr.write(
        `[InputWindow] extend openId=...${openId.slice(-6)} fragments=${win.fragments.length}\n`,
      );
    } else {
      const timer = setTimeout(() => this._flush(openId), this.windowMs);
      this.windows.set(openId, {
        fragments: [{ text, messageId }],
        timer,
        anchorMessageId: messageId,
        chatId,
        chatType,
      });
      process.stderr.write(`[InputWindow] open openId=...${openId.slice(-6)}\n`);
    }
  }

  /** Force-flush a user's window immediately (e.g. on explicit send or test). */
  flush(openId: string): void {
    this._flush(openId);
  }

  /** Discard a pending window without dispatching (e.g. on session teardown). */
  clear(openId: string): void {
    const win = this.windows.get(openId);
    if (win) {
      clearTimeout(win.timer);
      this.windows.delete(openId);
      process.stderr.write(`[InputWindow] cleared openId=...${openId.slice(-6)}\n`);
    }
  }

  /** Number of open windows — for diagnostics / tests only. */
  openCount(): number {
    return this.windows.size;
  }

  private _flush(openId: string): void {
    const win = this.windows.get(openId);
    this.windows.delete(openId);
    if (!win || win.fragments.length === 0) return;
    clearTimeout(win.timer);

    const mergedText = win.fragments.map(f => f.text).join('\n');
    process.stderr.write(
      `[InputWindow] flush openId=...${openId.slice(-6)} fragments=${win.fragments.length}` +
      ` anchor=${win.anchorMessageId.slice(-8)} text="${mergedText.slice(0, 80)}"\n`,
    );
    this.onFlush(openId, mergedText, win.anchorMessageId, win.chatId, win.chatType);
  }
}
