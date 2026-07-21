/**
 * View state machine for the single-main-view TUI (spawn-1.0 M3-7b-view).
 *
 * Pure: reduce(state, key) → state. No store, no I/O, no React — snapshot- and
 * unit-testable in isolation. Agent selection / scrolling are store commands
 * handled by the caller; this reducer owns only view-mode + plan-layer state.
 *
 * See TUI_REDESIGN.md for the state machine and keymap.
 */

export type ViewMode = "home" | "chat" | "logs";
/** Plan layer: 0 collapsed (1-line), 1 half, 2 full-expanded. */
export type PlanLevel = 0 | 1 | 2;

export interface ViewState {
  mode: ViewMode;
  planLevel: PlanLevel;
}

export const initialViewState: ViewState = { mode: "home", planLevel: 0 };

/** Normalized key names the reducer understands. */
export type ViewKey =
  | "enter" | "esc" | "ctrl+l" | "ctrl+t"
  | "up" | "down" | "tab" | "shift+tab";

/**
 * Advance view state for a key. Returns the same reference when nothing changes
 * (lets callers skip re-render). Selection keys (up/down/tab) don't change view
 * state — they're returned unchanged and the caller dispatches store commands.
 */
export function reduce(state: ViewState, key: ViewKey): ViewState {
  switch (key) {
    case "ctrl+t": {
      const next = ((state.planLevel + 1) % 3) as PlanLevel;
      return { ...state, planLevel: next };
    }
    case "ctrl+l": {
      // Toggle chat/logs; from home, enter logs.
      const mode: ViewMode = state.mode === "logs" ? "chat" : "logs";
      return { ...state, mode };
    }
    case "enter":
      // Home → open the selected agent's chat.
      return state.mode === "home" ? { ...state, mode: "chat" } : state;
    case "esc":
      // Collapse the plan first; otherwise return to home.
      if (state.planLevel > 0) return { ...state, planLevel: 0 };
      return state.mode === "home" ? state : { ...state, mode: "home" };
    default:
      // up / down / tab / shift+tab — selection, no view-state change.
      return state;
  }
}

/** True if the key is an agent-selection command the caller must dispatch to the store. */
export function isSelectionKey(key: ViewKey): boolean {
  return key === "up" || key === "down" || key === "tab" || key === "shift+tab";
}
