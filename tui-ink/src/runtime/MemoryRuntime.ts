/**
 * MemoryRuntime — façade for secretary lifecycle + resume-context injection
 * (spawn-1.0 M1-6c). Owns the closure-free memory glue: secretary create/destroy
 * and the RESUMED CONTEXT block. Per-event `secretary.observe(...)` forwarding stays
 * inline in the handlers and moves in 6e — see docs/spawn-1.0/M1-6c-SPEC.md §2.
 */

import { SecretaryProxy } from "../memory/SecretaryProxy.js";
import { createMemory, loadMemory } from "../memory/MemoryStore.js";
import { retrieveRelevant } from "../memory/retrieval.js";
import { logDiag, recordHealthMetric } from "./ObservabilityRuntime.js";

export { SecretaryProxy, factSimilarity, factTokens } from "../memory/SecretaryProxy.js";
export {
  createMemory,
  deleteAgentMemory,
  listUnfinishedAgents,
  loadMemory,
  loadMemoryByHash,
  loadSessions,
  topFactsByWeight,
} from "../memory/MemoryStore.js";

type CreateMemoryParams = Parameters<typeof createMemory>[0];

/**
 * Load-or-create the memory for an agent and register a SecretaryProxy for it.
 * `makeParams` is a thunk so createMemory params aren't built when resuming.
 */
export function initSecretary(
  secretaries: Map<string, SecretaryProxy>,
  id: string,
  resumedMemoryId: string | undefined,
  makeParams: () => CreateMemoryParams,
): SecretaryProxy {
  const existingMem = resumedMemoryId ? loadMemory(id) : null;
  const mem = existingMem ?? createMemory(makeParams());
  const sec = new SecretaryProxy(mem, { startNewSession: !existingMem });
  secretaries.set(id, sec);
  return sec;
}

/** Tear down and unregister an agent's secretary. */
export function destroySecretary(secretaries: Map<string, SecretaryProxy>, id: string): void {
  secretaries.get(id)?.destroy();
  secretaries.delete(id);
}

/**
 * Build the "RESUMED CONTEXT" system-prompt segment for a resuming agent. Returns
 * the string to append to the prompt template (or "" when there's nothing to inject,
 * recording a `resume_context_missing` metric in that case). Extracted verbatim from
 * buildSystemPrompt's resume block.
 */
export function buildResumeContext(
  resumedMemoryId: string,
  agentId: string,
  role: string,
  goal: string | undefined,
): string {
  const mem = loadMemory(resumedMemoryId);
  if (!mem) {
    logDiag(`[resume] WARN: loadMemory("${resumedMemoryId}") returned null — no context injected\n`);
    recordHealthMetric({
      agent_id: agentId,
      event_type: "resume_context_missing",
      severity: "warn",
      reason: `loadMemory("${resumedMemoryId}") returned null`,
      meta: {
        resumedMemoryId,
        role,
        goal: goal?.slice(0, 300),
      },
    });
    return "";
  }

  const budgetKb = mem.dispatch?.memory_quota_kb ?? 60;
  const budgetChars = budgetKb * 512; // rough: ~512 chars per KB in markdown

  // M3-1: retrieve facts most RELEVANT to the current goal, across the working
  // set + cold archive (falls back to weight/recency when goal is empty).
  const relevant = retrieveRelevant(resumedMemoryId, mem.working_set.facts, goal ?? "", 10);

  // Take top 10 respecting budget
  const topFacts: string[] = [];
  let charsUsed = 0;
  for (const f of relevant) {
    const line = `- [w${f.weight ?? 1}] ${f.text}`;
    if (charsUsed + line.length > budgetChars && topFacts.length > 0) break;
    topFacts.push(line);
    charsUsed += line.length;
  }

  const facts = topFacts.join("\n");
  const decisions = mem.working_set.decisions.map((d) => `- ${d.text}`).join("\n");
  const lastTodo = mem.tombstone.last_todo
    ? JSON.parse(mem.tombstone.last_todo).map((t: { state: string; text: string }) => `  [${t.state}] ${t.text}`).join("\n")
    : "(unknown)";
  logDiag(`[resume] context injected: facts=${topFacts.length}, decisions=${mem.working_set.decisions.length}, hint="${(mem.tombstone.resume_hint ?? "").slice(0, 80)}"\n`);
  // M1-8: surface the interrupted "现场" — tool.calls that never got a result.
  const pendingTools = mem.tombstone.pending_tool_calls ?? [];
  const pendingBlock = pendingTools.length
    ? `\n\n**中断时未完成的操作（需你决定重做或跳过）：**\n${pendingTools
        .map((t) => `- ${t.name}${t.needs_approval ? "（曾等待审批）" : ""} [id=${t.id}]`)
        .join("\n")}`
    : "";
  return `\n\n---\n\n## ⚠️ RESUMED CONTEXT\n\n你正在从中断恢复。上次中断原因：${mem.tombstone.resume_hint ?? "未知"}\n\nResume budget: ${budgetKb}KB\n\n**上次 TODO 状态：**\n${lastTodo}\n\n**已确认事实（weight top 10，预算内）：**\n${facts || "(无)"}\n\n**关键决定：**\n${decisions || "(无)"}${pendingBlock}\n\n**第一句必须输出 todo.set 重申当前计划，然后继续推进。**`;
}
