export interface CursorAnchorState {
  enabled: boolean;
  focused: boolean;
  row: number;
  col: number;
}

const state: CursorAnchorState = {
  enabled: process.env.SPAWN_INPUT_CURSOR_ANCHOR !== "0",
  focused: false,
  row: 1,
  col: 1,
};

export function setCursorAnchor(patch: Partial<CursorAnchorState>): void {
  Object.assign(state, patch);
}

export function getCursorAnchorSequence(): string {
  if (!state.enabled) return "";
  if (!state.focused) return "\x1b[?25h";
  // Move the real terminal cursor for IME anchoring, then hide it so the user
  // only sees ink-text-input's block cursor. This avoids double-cursor UI.
  return `\x1b[${state.row};${state.col}H\x1b[?25l`;
}
