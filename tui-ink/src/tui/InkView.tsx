/**
 * InkView — the new single-main-view TUI wired to the LIVE store (M3-7b, first wire).
 *
 * Opt-in via SPAWN_NEW_UI=1 so the default UI is untouched (zero regression).
 * This makes the new TUI actually runnable — `SPAWN_NEW_UI=1 npm run dev:watch`
 * shows it against live agents — rather than a render-only preview.
 *
 * Reads the store (useStore), owns view state + input locally, dispatches
 * navigation/approval to store commands, and forwards submitted lines to
 * onCommand (App's existing user-input handler).
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore, getState, selectAgent, scrollBy } from "../store.js";
import { buildSnapshot } from "./snapshot.js";
import { renderFrame } from "./render.js";
import { reduce, initialViewState, type ViewState, type ViewKey } from "./viewState.js";

function nextAgentId(current: string, dir: 1 | -1): string {
  const ids = [...getState().agents.values()].filter((a) => !a.hidden).map((a) => a.id);
  if (ids.length === 0) return current;
  const i = ids.indexOf(current);
  const n = i < 0 ? 0 : (i + dir + ids.length) % ids.length;
  return ids[n]!;
}

export function InkView({ onCommand, onApprove, onReject, onExit, model, webOn }: {
  onCommand: (line: string) => void;
  onApprove: (toolId: string) => void;
  onReject: (toolId: string) => void;
  onExit: () => void;
  model?: string;
  webOn?: boolean;
}): React.ReactElement {
  const [view, setView] = useState<ViewState>(initialViewState);
  const [input, setInput] = useState("");
  // Subscribe so the frame re-renders on any store change.
  useStore((s) => s.messagesByAgent);
  useStore((s) => s.agents);
  useStore((s) => s.pendingApprovals);

  const cols = Math.max(60, (process.stdout.columns ?? 88));

  useInput((char, key) => {
    const state = getState();
    const pending = state.pendingApprovals[0];

    // Exit (only when not composing a command).
    if (key.ctrl && char === "c") { onExit(); return; }
    if (char === "q" && !input) { onExit(); return; }

    // Approval overlay captures y/n exclusively (delegates side effects to App).
    if (pending) {
      if (char === "y") { onApprove(pending.tool_id!); return; }
      if (char === "n") { onReject(pending.tool_id!); return; }
    }

    // View-state keys
    let vk: ViewKey | null = null;
    if (key.ctrl && char === "t") vk = "ctrl+t";
    else if (key.ctrl && char === "l") vk = "ctrl+l";
    else if (key.escape) vk = "esc";
    else if (key.return) vk = "enter";
    else if (key.tab && key.shift) vk = "shift+tab";
    else if (key.tab) vk = "tab";
    else if (key.upArrow) vk = "up";
    else if (key.downArrow) vk = "down";

    if (vk === "enter" && input.trim()) {
      // Enter with text = submit to command handler (not a view transition).
      onCommand(input.trim());
      setInput("");
      return;
    }
    if (vk === "tab") { selectAgent(nextAgentId(state.selectedAgent, 1)); return; }
    if (vk === "shift+tab") { selectAgent(nextAgentId(state.selectedAgent, -1)); return; }
    if (vk === "up") { selectAgent(nextAgentId(state.selectedAgent, -1)); return; }
    if (vk === "down") { selectAgent(nextAgentId(state.selectedAgent, 1)); return; }
    if (vk === "ctrl+t" || vk === "ctrl+l" || vk === "esc" || vk === "enter") {
      setView((v) => reduce(v, vk!));
      return;
    }

    // Scroll
    if (char === "[") { scrollBy(-4); return; }
    if (char === "]") { scrollBy(4); return; }

    // Text input editing
    if (key.backspace || key.delete) { setInput((s) => s.slice(0, -1)); return; }
    if (char && !key.ctrl && !key.meta) setInput((s) => s + char);
  });

  const snap = buildSnapshot(getState(), { model, webOn, input });
  const lines = renderFrame(snap, view, cols);
  return (
    <Box flexDirection="column">
      <Text>{lines.join("\n")}</Text>
    </Box>
  );
}
