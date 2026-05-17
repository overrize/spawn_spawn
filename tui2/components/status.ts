import { Bounds, DrawCommand, Theme } from "../engine/types.js";
import { TeamAggregation } from "../store/index.js";
import { styled, text } from "./text.js";

export function statusBar(bounds: Bounds, team: TeamAggregation, theme: Theme): DrawCommand[] {
  const cmds: DrawCommand[] = [];

  cmds.push({ type: "fill", bounds, style: styled({ bg: theme.colors.surface }) });

  const brand = "⬢ SpawnTUI";
  cmds.push(text(bounds.x, bounds.y, brand, styled({ fg: theme.colors.accent })));

  if (team.activeAgents > 0) {
    cmds.push(text(bounds.x + brand.length, bounds.y, " RUNNING", styled({ fg: theme.colors.success })));
  }

  let statFg = theme.colors.muted;
  if (team.errorAgents > 0 || team.terminatedAgents > 0) {
    statFg = theme.colors.error;
  } else if (team.pausedAgents > 0) {
    statFg = theme.colors.warning;
  } else if (team.activeAgents > 0) {
    statFg = theme.colors.success;
  }

  const spawnText = `${team.spawns.length} spawns`;
  const forkText = `${team.forks.length} forks`;
  const keyText = `${team.totalMemoryKeys} keys`;
  const sep = " · ";
  const stats = spawnText + sep + forkText + sep + keyText;
  const statsX = bounds.x + bounds.width - stats.length;

  cmds.push(text(statsX, bounds.y, stats, styled({ fg: statFg })));

  return cmds;
}
