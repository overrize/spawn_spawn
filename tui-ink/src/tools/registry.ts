// Tool Registry — 每个工具是独立的 ToolDef 对象，单一职责
// 架构借鉴自 claude_leack ExecutionRegistry 的 frozen-dataclass 思路
// 但实现了真正的执行逻辑（他们的 execute_tool 只是 stub）

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

// ── 类型 ──────────────────────────────────────────────────────────────────────

export interface ToolResult {
  ok: boolean;
  output: string;
}

export type AgentRole = "Leader" | "Worker";

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly argsSchema: string;      // 注入 system prompt 用
  readonly needsApproval: boolean;  // true = 走 y/n 审批门
  readonly roles: ReadonlySet<AgentRole>;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

// ── 工具实现 ──────────────────────────────────────────────────────────────────

const Read: ToolDef = {
  name: "Read",
  description: "读文件，带行号",
  argsSchema: "path(str), offset?(int 行号), limit?(int default:200)",
  needsApproval: false,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const p = String(a.file_path ?? a.path ?? "");
    if (!p) return err("missing path");
    const raw = fs.readFileSync(p, "utf8");
    const lines = raw.split("\n");
    const start = Math.max(0, typeof a.offset === "number" ? a.offset : 0);
    const limit = typeof a.limit === "number" ? a.limit : 200;
    const end = Math.min(lines.length, start + limit);
    const body = lines.slice(start, end)
      .map((l, i) => `${start + i + 1}\t${l}`).join("\n");
    return ok(`${p} (lines ${start + 1}–${end} / ${lines.length})\n${body}`);
  },
};

const Write: ToolDef = {
  name: "Write",
  description: "写文件（覆盖/新建，自动建目录）",
  argsSchema: "path(str), content(str)",
  needsApproval: true,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const p = String(a.file_path ?? a.path ?? "");
    const content = String(a.content ?? "");
    if (!p) return err("missing path");
    fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
    return ok(`Written ${content.length} chars to ${p}`);
  },
};

const Edit: ToolDef = {
  name: "Edit",
  description: "精确字符串替换，old_string 必须唯一",
  argsSchema: "path(str), old_string(str), new_string(str)",
  needsApproval: true,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const p = String(a.file_path ?? a.path ?? "");
    const oldStr = String(a.old_string ?? "");
    const newStr = String(a.new_string ?? "");
    if (!p) return err("missing path");
    // Empty old_string → create new file (only if it doesn't exist)
    if (!oldStr) {
      if (fs.existsSync(p)) return err("old_string is empty but file exists; use Write to overwrite");
      fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
      fs.writeFileSync(p, newStr, "utf8");
      return ok(`Created ${p} (${newStr.length} chars)`);
    }
    const content = fs.readFileSync(p, "utf8");
    const count = content.split(oldStr).length - 1;
    if (count === 0) return err(`old_string not found in ${p}`);
    if (count > 1)   return err(`old_string found ${count} times in ${p}; be more specific`);
    // When deleting (newStr=""), also handle trailing newline
    let updated = content.replace(oldStr, newStr);
    if (newStr === "" && !oldStr.endsWith("\n") && content.includes(oldStr + "\n")) {
      updated = content.replace(oldStr + "\n", "");
    }
    fs.writeFileSync(p, updated, "utf8");
    return ok(`Edited ${p}: replaced 1 occurrence`);
  },
};

const BANNED_COMMANDS = new Set([
  "curl", "wget", "nc", "ncat", "netcat", "telnet", "ssh", "scp", "ftp", "rsync",
]);
function isBanned(cmd: string): string | null {
  const first = cmd.trim().split(/[\s|;&<>]/)[0]?.split(/[/\\]/).pop() ?? "";
  return BANNED_COMMANDS.has(first.toLowerCase()) ? first : null;
}

const Bash: ToolDef = {
  name: "Bash",
  description: "执行 shell 命令（状态持久，环境变量跨调用保留）",
  argsSchema: "command(str), timeout?(ms default:60000)",
  needsApproval: true,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const cmd = String(a.command ?? a.cmd ?? "");
    const timeout = typeof a.timeout === "number" ? a.timeout : 60_000;
    if (!cmd) return err("missing command");
    const banned = isBanned(cmd);
    if (banned) return err(`Banned command: "${banned}". Use a Worker tool for network access instead.`);
    try {
      const out = String(execSync(cmd, { encoding: "utf8", timeout, cwd: process.cwd(), shell: true as any }));
      return ok(middleTruncate(out || "(no output)"));
    } catch (e: any) {
      const out = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
      return { ok: false, output: middleTruncate(out || e.message || "command failed", 10_000) };
    }
  },
};

const Grep: ToolDef = {
  name: "Grep",
  description: "正则搜索文件内容（基于 rg）",
  argsSchema: "pattern(str), path?(str), glob?(str), case_insensitive?(bool), context?(int)",
  needsApproval: false,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const pat  = String(a.pattern ?? "");
    const dir  = String(a.path ?? ".");
    const glob = a.glob ? `--glob ${JSON.stringify(String(a.glob))}` : "";
    const ci   = a.case_insensitive ? "-i" : "";
    const ctx  = typeof a.context === "number" ? `-C ${a.context}` : "";
    const cmd  = `rg -n --no-heading ${ci} ${ctx} ${glob} ${JSON.stringify(pat)} ${JSON.stringify(dir)}`.replace(/\s+/g, " ").trim();
    try {
      const out = String(execSync(cmd, { encoding: "utf8", timeout: 10_000, cwd: process.cwd() }));
      return ok(out.slice(0, 20_000) || "(no matches)");
    } catch (e: any) {
      return ok((String(e.stdout ?? "")).slice(0, 20_000) || "(no matches)");
    }
  },
};

const Glob: ToolDef = {
  name: "Glob",
  description: "文件名模式匹配，结果按路径排序",
  argsSchema: "pattern(str), path?(str)",
  needsApproval: false,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const pat  = String(a.pattern ?? "**/*");
    const base = String(a.path ?? ".");
    try {
      const out = String(execSync(
        `rg --files --glob ${JSON.stringify(pat)} ${JSON.stringify(base)}`,
        { encoding: "utf8", timeout: 10_000, cwd: process.cwd() },
      ));
      const sorted = out.trim().split("\n").filter(Boolean).sort().join("\n");
      return ok(sorted.slice(0, 20_000) || "(no files)");
    } catch (e: any) {
      return ok((String(e.stdout ?? "")).slice(0, 20_000) || "(no files)");
    }
  },
};

const LS: ToolDef = {
  name: "LS",
  description: "列目录（d=目录 f=文件）",
  argsSchema: "path?(str default:cwd)",
  needsApproval: false,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const dir = String(a.path ?? ".");
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const lines = entries.map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`);
    return ok(lines.join("\n") || "(empty)");
  },
};

const Think: ToolDef = {
  name: "Think",
  description: "记录推理步骤，无副作用，助于规划前的明确思考",
  argsSchema: "thought(str)",
  needsApproval: false,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const t = String(a.thought ?? "");
    if (!t) return err("missing thought");
    return ok("Your thought has been logged.");
  },
};

// ── 注册表（Map 保证 O(1) 查找）─────────────────────────────────────────────

const ALL_TOOLS: ToolDef[] = [Read, Write, Edit, Bash, Grep, Glob, LS, Think];

export const TOOL_REGISTRY = new Map<string, ToolDef>(
  ALL_TOOLS.map((t) => [t.name, t]),
);

// ── 公开 API ──────────────────────────────────────────────────────────────────

/** 按角色过滤（借鉴 claude_leack get_tools(simple_mode) 思路） */
export function getToolsForRole(role: AgentRole): ToolDef[] {
  return ALL_TOOLS.filter((t) => t.roles.has(role));
}

/** 执行工具 — 替换原 index.tsx 里的 switch-case */
export async function executeTool(name: string, args: unknown): Promise<ToolResult> {
  const tool = TOOL_REGISTRY.get(name);
  if (!tool) {
    return {
      ok: false,
      output: `Unknown tool "${name}". Available: ${ALL_TOOLS.map((t) => t.name).join(", ")}`,
    };
  }
  try {
    return await tool.execute((args ?? {}) as Record<string, unknown>);
  } catch (e: any) {
    return { ok: false, output: `Error in ${name}: ${e.message?.slice(0, 500) ?? "unknown"}` };
  }
}

/**
 * 检查工具是否需要审批（注册表是权威来源，防止 agent 篡改 needs_approval）
 * 借鉴 claude_leack ToolPermissionContext.blocks() 的思路做推断式校验
 */
export function toolNeedsApproval(name: string): boolean {
  return TOOL_REGISTRY.get(name)?.needsApproval ?? true; // 未知工具默认需要审批
}

/** 生成注入 system prompt 的工具表格 */
export function buildToolSchemaBlock(role: AgentRole): string {
  const tools = getToolsForRole(role);
  const rows = tools.map((t) =>
    `| ${t.name.padEnd(5)} | ${t.argsSchema.padEnd(52)} | ${t.needsApproval ? "**true** " : "false    "} | ${t.description} |`
  );
  const header = [
    "| 工具  | 参数                                                 | needs_approval | 说明 |",
    "|-------|------------------------------------------------------|----------------|------|",
  ].join("\n");

  const EXAMPLES: Record<string, string> = {
    Read:  `{"path":"src/pm/ProcessManager.ts","limit":100}`,
    Write: `{"path":"src/utils/helper.ts","content":"export function foo() {}"}`,
    Edit:  `{"path":"src/index.ts","old_string":"const x = 1","new_string":"const x = 2"}`,
    Bash:  `{"command":"npm run test 2>&1 | head -50"}`,
    Grep:  `{"pattern":"preCheckSpawn","path":"src","glob":"*.ts","context":3}`,
    Glob:  `{"pattern":"src/**/*.ts"}`,
    LS:    `{"path":"src"}`,
    Think: `{"thought":"I should read the config first before deciding which files to edit"}`,
  };
  const examples = tools
    .filter((t) => EXAMPLES[t.name])
    .map((t) => `- ${t.name}: ${EXAMPLES[t.name]}`);

  return `${header}\n${rows.join("\n")}\n\nargs 示例：\n${examples.join("\n")}`;
}

// ── helpers ───────────────────────────────────────────────────────────────────
function ok(output: string): ToolResult  { return { ok: true,  output }; }
function err(output: string): ToolResult { return { ok: false, output }; }

function middleTruncate(s: string, max = 20_000): string {
  if (s.length <= max) return s;
  const head = Math.floor(max / 2);
  const tail  = max - head;
  const skipped = s.slice(head, s.length - tail);
  const skippedLines = (skipped.match(/\n/g)?.length ?? 0);
  return s.slice(0, head)
    + `\n\n[... ${skipped.length} chars / ~${skippedLines} lines truncated ...]\n\n`
    + s.slice(-tail);
}
