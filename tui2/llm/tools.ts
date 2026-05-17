import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export interface ToolResult {
  tool_call_id: string;
  role: 'tool';
  content: string;
}

export const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Returns the file content as a string.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Absolute or relative path to the file' },
          offset: { type: 'number', description: 'Line number to start reading from (1-indexed, optional)' },
          limit: { type: 'number', description: 'Maximum number of lines to read (optional)' },
        },
        required: ['filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or overwrite a file with the given content. Creates parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to the file to write' },
          content: { type: 'string', description: 'Content to write to the file' },
        },
        required: ['filePath', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: 'Execute a shell command and return its output. Use for running tests, builds, git, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          workdir: { type: 'string', description: 'Working directory for the command (optional)' },
        },
        required: ['command'],
      },
    },
  },
];

export function executeTool(call: ToolCall): ToolResult {
  const args = JSON.parse(call.function.arguments);
  let content: string;

  try {
    switch (call.function.name) {
      case 'read_file': {
        const filePath = path.resolve(args.filePath);
        if (!fs.existsSync(filePath)) {
          content = `Error: File not found: ${filePath}`;
        } else {
          const data = fs.readFileSync(filePath, 'utf-8');
          const lines = data.split('\n');
          const start = (args.offset ?? 1) - 1;
          const end = args.limit ? start + args.limit : lines.length;
          content = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
          if (content.length > 8000) {
            content = content.slice(0, 8000) + `\n... (${lines.length - end} more lines)`;
          }
        }
        break;
      }
      case 'write_file': {
        const filePath = path.resolve(args.filePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, args.content, 'utf-8');
        content = `File written: ${filePath} (${args.content.length} bytes)`;
        break;
      }
      case 'execute_command': {
        const opts: { cwd?: string; timeout?: number; encoding: BufferEncoding } = {
          encoding: 'utf-8',
          timeout: 30000,
        };
        if (args.workdir) opts.cwd = path.resolve(args.workdir);
        const output = execSync(args.command, opts);
        content = output.slice(0, 4000);
        if (output.length > 4000) content += '\n... (output truncated)';
        break;
      }
      default:
        content = `Unknown tool: ${call.function.name}`;
    }
  } catch (err) {
    content = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }

  return {
    tool_call_id: call.id,
    role: 'tool',
    content,
  };
}
