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

type Item =
  | { kind: "banner"; key: string; model: string }
  | { kind: "msg"; key: string; sender: string; lines: string[]; dim: boolean };

function toItem(m: Message, key: string): Item {
  const sender = m.agent === "user" ? "user" : m.agent;
  const dim = m.kind === "system" || m.kind === "tool_call" || m.kind === "tool_result";
  return { kind: "msg", key, sender, lines: (m.text ?? "").split("\n"), dim };
}

/** Startup banner — top+bottom rule lines (same style as the input bar). Scrolls away. */
function Banner({ model }: { model: string }): React.ReactElement {
  const cwd = process.cwd();
  const rule = "─".repeat(process.stdout.columns ?? 80);
  return (
    <Box flexDirection="column">
      <Text dimColor>{rule}</Text>
      <Box flexDirection="column" paddingX={1}>
        <Text><Text color="cyan" bold>◆ spawn</Text><Text dimColor>  multi-agent · full-duplex</Text></Text>
        <Text dimColor>model:     <Text color="white">{model}</Text>   <Text color="cyan">/model</Text> to change</Text>
        <Text dimColor>directory: {cwd}</Text>
        <Text dimColor>commands:  <Text color="cyan">@agent</Text> switch · <Text color="cyan">/command</Text> · <Text color="cyan">Ctrl+T</Text> plan · <Text color="cyan">y/n</Text> approve</Text>
      </Box>
      <Text dimColor>{rule}</Text>
    </Box>
  );
}

export function Transcript({ model }: { model: string }): React.ReactElement {
  const sel = useStore((s) => s.selectedAgent);
  const msgs = useStore((s) => s.messagesByAgent.get(sel) ?? []);

  // Stable keys: the banner key is constant (never re-committed); message keys
  // are agent-scoped so switching agents appends the new agent's stream.
  const items: Item[] = [
    { kind: "banner", key: "__banner__", model },
    ...msgs.map((m) => toItem(m, `${sel}:${m.id}`)),
  ];

  return (
    <Static items={items}>
      {(item) =>
        item.kind === "banner" ? (
          <Banner key={item.key} model={item.model} />
        ) : (
          <Box key={item.key} flexDirection="column" paddingX={1} marginTop={item.sender ? 1 : 0}>
            {item.sender ? <Text color="cyan" bold>{item.sender}</Text> : null}
            {item.lines.map((l, i) => (
              <Text key={i} dimColor={item.dim}>{item.sender ? "  " + l : l}</Text>
            ))}
          </Box>
        )
      }
    </Static>
  );
}
