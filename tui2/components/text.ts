import { AgentStatus } from "../../src/core/types.js";
import { DrawCommand, RGBA, TextStyle, Theme } from "../engine/types.js";

export function text(
  x: number,
  y: number,
  content: string,
  style?: TextStyle,
): DrawCommand {
  return { type: "text", x, y, text: content, style };
}

export function styled(partial?: TextStyle): TextStyle {
  return {
    fg: partial?.fg,
    bg: partial?.bg,
    bold: partial?.bold ?? false,
    dim: partial?.dim ?? false,
    italic: partial?.italic ?? false,
    underline: partial?.underline ?? false,
    inverse: partial?.inverse ?? false,
  };
}

export function statusColor(status: AgentStatus, theme: Theme): RGBA {
  switch (status) {
    case AgentStatus.RUNNING:
      return theme.colors.success;
    case AgentStatus.PAUSED:
    case AgentStatus.TERMINATING:
      return theme.colors.warning;
    case AgentStatus.ERROR:
    case AgentStatus.TERMINATED:
      return theme.colors.error;
    case AgentStatus.IDLE:
      return theme.colors.muted;
    case AgentStatus.INITIALIZING:
    case AgentStatus.RESUMING:
      return theme.colors.info;
    default:
      return theme.colors.foreground;
  }
}

export function statusIcon(status: AgentStatus): string {
  switch (status) {
    case AgentStatus.RUNNING:
      return "●";
    case AgentStatus.PAUSED:
      return "◐";
    case AgentStatus.ERROR:
      return "✕";
    case AgentStatus.TERMINATED:
      return "◌";
    case AgentStatus.IDLE:
      return "○";
    case AgentStatus.INITIALIZING:
      return "◒";
    case AgentStatus.RESUMING:
      return "◓";
    case AgentStatus.TERMINATING:
      return "◑";
    default:
      return "○";
  }
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  if (maxLen <= 1) return "…";
  return str.slice(0, maxLen - 1) + "…";
}

export function padRight(str: string, width: number): string {
  if (str.length >= width) return str;
  return str + " ".repeat(width - str.length);
}
