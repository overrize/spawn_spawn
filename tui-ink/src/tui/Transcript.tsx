/**
 * Transcript — Claude Code-style scrolling conversation (spawn-1.0 M3-7c).
 *
 * Uses Ink <Static>: the header + each message are committed to the terminal
 * scrollback ONCE and scroll up naturally as the conversation grows (the header
 * scrolls away after startup, exactly like Claude Code). The live region
 * (plan drawer + input + status) is rendered by App BELOW this, anchored at the
 * bottom. No fixed viewport, no 3 columns, no anchored top header.
 */

import React from "react";
import { Box, Text, Static } from "ink";
import { useStore } from "../store.js";
import type { Message } from "../protocol.js";

interface Item { key: string; sender: string; lines: string[]; dim: boolean }

function toItem(m: Message): Item {
  const sender = m.agent === "user" ? "user" : m.agent;
  const dim = m.kind === "system" || m.kind === "tool_call" || m.kind === "tool_result";
  return { key: m.id, sender, lines: (m.text ?? "").split("\n"), dim };
}

export function Transcript({ header }: { header: string[] }): React.ReactElement {
  const sel = useStore((s) => s.selectedAgent);
  const msgs = useStore((s) => s.messagesByAgent.get(sel) ?? []);

  const items: Item[] = [
    { key: `__hdr__:${sel}`, sender: "", lines: header, dim: true },
    ...msgs.map((m) => ({ ...toItem(m), key: `${sel}:${m.id}` })),
  ];

  return (
    <Static items={items}>
      {(item) => (
        <Box key={item.key} flexDirection="column" paddingX={1} marginTop={item.sender ? 1 : 0}>
          {item.sender ? <Text color="cyan" bold>{item.sender}</Text> : null}
          {item.lines.map((l, i) => (
            <Text key={i} dimColor={item.dim}>{item.sender ? "  " + l : l}</Text>
          ))}
        </Box>
      )}
    </Static>
  );
}

/** Startup banner — the only time a header shows; it scrolls away as chat grows. */
export function startupHeader(model: string): string[] {
  return [
    "",
    "  ▌ spawn · multi-agent",
    `  ▌ model ${model} · type a message · @agent to switch · /command`,
    "",
  ];
}
