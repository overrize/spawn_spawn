/**
 * SpawnHeader — startup banner shown at the top of the Agents view. Top/bottom
 * rule lines (input-bar style) + a blinking mascot. It's the home banner; it's
 * gone once you Enter into a chat. (spawn-1.0 M3-7c)
 */

import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";

/** A little mascot whose eyes blink every few seconds. */
function Mascot(): React.ReactElement {
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    const t = setInterval(() => {
      setClosed(true);
      const c = setTimeout(() => setClosed(false), 140);
      return () => clearTimeout(c);
    }, 3200);
    return () => clearInterval(t);
  }, []);
  const eyes = closed ? "─ ─" : "● ●";
  return (
    <Box flexDirection="column" marginRight={2}>
      <Text color="cyan">╭─────╮</Text>
      <Text color="cyan">│ {eyes} │</Text>
      <Text color="cyan">╰─────╯</Text>
    </Box>
  );
}

export function SpawnHeader({ model }: { model: string }): React.ReactElement {
  const cwd = process.cwd();
  const rule = "─".repeat(process.stdout.columns ?? 80);
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text dimColor>{rule}</Text>
      <Box paddingX={1}>
        <Mascot />
        <Box flexDirection="column">
          <Text><Text color="cyan" bold>◆ spawn</Text><Text dimColor>  multi-agent · full-duplex</Text></Text>
          <Text dimColor>model:     <Text color="white">{model}</Text>   <Text color="cyan">/model</Text> to change</Text>
          <Text dimColor>directory: {cwd}</Text>
          <Text dimColor>commands:  <Text color="cyan">@agent</Text> switch · <Text color="cyan">/command</Text> · <Text color="cyan">Ctrl+T</Text> plan · <Text color="cyan">Ctrl+L</Text> logs</Text>
        </Box>
      </Box>
      <Text dimColor>{rule}</Text>
    </Box>
  );
}
