/**
 * InkView — the vertical single-main-view TUI wired to the LIVE store (M3-7c).
 * Old UI's rich style, new scrolling interaction. Replaces App()'s render+input.
 *
 * Reads the store, owns view state + input + scroll locally, dispatches
 * navigation/approval/commands to callbacks App provides (no logic dup).
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore, getState, selectAgent } from "../store.js";
import { buildSnapshot } from "./snapshot.js";
import { renderFrame } from "./render.js";
import { reduce, initialViewState, type ViewState } from "./viewState.js";

function visibleIds(): string[] {
  return [...getState().agents.values()].filter((a) => !a.hidden).map((a) => a.id);
}
function step(current: string, dir: 1 | -1): string {
  const ids = visibleIds();
  if (!ids.length) return current;
  const i = ids.indexOf(current);
  return ids[(i < 0 ? 0 : (i + dir + ids.length) % ids.length)]!;
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
  const [scroll, setScroll] = useState(0);
  // Re-render on any store change.
  useStore((s) => s.messagesByAgent);
  useStore((s) => s.agents);
  useStore((s) => s.pendingApprovals);
  useStore((s) => s.todosByAgent);

  const cols = Math.max(60, process.stdout.columns ?? 96);
  const rows = Math.max(12, process.stdout.rows ?? 30);

  useInput((char, key) => {
    const state = getState();
    const pending = state.pendingApprovals[0];

    if (key.ctrl && char === "c") { onExit(); return; }
    if (char === "q" && !input) { onExit(); return; }

    if (pending) {
      if (char === "y") { onApprove(pending.tool_id!); return; }
      if (char === "n") { onReject(pending.tool_id!); return; }
    }

    // Enter: submit text if any; else in home open chat.
    if (key.return) {
      if (input.trim()) { onCommand(input.trim()); setInput(""); setScroll(0); return; }
      setView((v) => reduce(v, "enter"));
      return;
    }
    if (key.escape) { setView((v) => reduce(v, "esc")); return; }
    if (key.ctrl && char === "t") { setView((v) => reduce(v, "ctrl+t")); return; }
    if (key.ctrl && char === "l") { setView((v) => reduce(v, "ctrl+l")); return; }

    // Up/Down + Tab: in home select agent; in chat/logs scroll history.
    const dirKey = key.upArrow ? -1 : key.downArrow ? 1 : 0;
    if (key.tab) { selectAgent(step(state.selectedAgent, key.shift ? -1 : 1)); return; }
    if (dirKey !== 0) {
      if (view.mode === "home") selectAgent(step(state.selectedAgent, dirKey as 1 | -1));
      else setScroll((sc) => Math.max(0, sc - dirKey)); // up = older (scroll += 1)
      return;
    }
    if (char === "[") { setScroll((sc) => sc + 3); return; }
    if (char === "]") { setScroll((sc) => Math.max(0, sc - 3)); return; }

    if (key.backspace || key.delete) { setInput((s) => s.slice(0, -1)); return; }
    if (char && !key.ctrl && !key.meta) setInput((s) => s + char);
  });

  const snap = buildSnapshot(getState(), { model, webOn, input, scrollOffset: scroll });
  return (
    <Box flexDirection="column">
      <Text>{renderFrame(snap, view, cols, rows).join("\n")}</Text>
    </Box>
  );
}
