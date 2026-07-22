/**
 * SpawnHeader — startup banner shown at the top of the conversation until the
 * first message arrives, then it's hidden ("scrolls away" like Claude Code).
 * Top/bottom rule lines, same style as the input bar. (spawn-1.0 M3-7c, path A:
 * single-column fixed viewport reusing ConvPane — no <Static>, no artifacts.)
 */

import React from "react";
import { Box, Text } from "ink";

export function SpawnHeader({ model }: { model: string }): React.ReactElement {
  const cwd = process.cwd();
  const rule = "─".repeat(process.stdout.columns ?? 80);
  return (
    <Box flexDirection="column" flexShrink={0}>
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
