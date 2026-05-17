export interface ParsedCommand {
  action: string;
  args: string[];
  raw: string;
}

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (cmd === 'spawn' || cmd === 's') {
    return { action: 'spawn', args, raw: trimmed };
  }
  if (cmd === 'fork' || cmd === 'f') {
    return { action: 'fork', args, raw: trimmed };
  }
  if (cmd === 'pause' || cmd === 'p') {
    return { action: 'pause', args, raw: trimmed };
  }
  if (cmd === 'resume' || cmd === 'r') {
    return { action: 'resume', args, raw: trimmed };
  }
  if (cmd === 'term' || cmd === 'terminate' || cmd === 'kill' || cmd === 't') {
    return { action: 'terminate', args, raw: trimmed };
  }
  if (cmd === 'memory' || cmd === 'mem' || cmd === 'm') {
    const sub = args[0]?.toLowerCase();
    if (sub === 'set' || sub === 's') {
      return { action: 'memory:set', args: args.slice(1), raw: trimmed };
    }
    if (sub === 'del' || sub === 'delete' || sub === 'd') {
      return { action: 'memory:del', args: args.slice(1), raw: trimmed };
    }
    if (sub === 'clear' || sub === 'c') {
      return { action: 'memory:clear', args: args.slice(1), raw: trimmed };
    }
    return { action: 'memory:show', args, raw: trimmed };
  }
  if (cmd === 'view' || cmd === 'v') {
    const sub = args[0]?.toLowerCase();
    if (sub === 'tree' || sub === 't') return { action: 'view:tree', args: [], raw: trimmed };
    if (sub === 'swarm' || sub === 's') return { action: 'view:swarm', args: [], raw: trimmed };
    if (sub === 'cards' || sub === 'c') return { action: 'view:cards', args: [], raw: trimmed };
    return { action: 'view:toggle', args: [], raw: trimmed };
  }
  if (cmd === 'theme' || cmd === 'th') {
    return { action: 'theme:cycle', args, raw: trimmed };
  }
  if (cmd === 'select' || cmd === 'sel') {
    return { action: 'select', args, raw: trimmed };
  }
  if (cmd === 'quit' || cmd === 'exit' || cmd === 'q') {
    return { action: 'quit', args, raw: trimmed };
  }
  if (cmd === 'help' || cmd === 'h' || cmd === '?') {
    return { action: 'help', args, raw: trimmed };
  }
  if (cmd === 'status' || cmd === 'st') {
    return { action: 'status', args, raw: trimmed };
  }

  return null;
}
