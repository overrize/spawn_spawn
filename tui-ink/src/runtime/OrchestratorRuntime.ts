/**
 * OrchestratorRuntime — façade for orchestration rules (spawn-1.0 M1-6d). Owns the
 * dependency-clean orchestration functions: the communication matrix and resume
 * hand-off. killAgent + spawn-dispatch guards stay inline (cross-cut Feishu/store)
 * and move in 6e — see docs/spawn-1.0/M1-6d-SPEC.md §2.
 */

import type { TuiEvent } from "../protocol.js";
import { HttpConvAgent } from "../adapters/httpAgent.js";
import { globalBus } from "../bus/Bus.js";
import { SecretaryProxy } from "../memory/SecretaryProxy.js";
import { destroySecretary } from "./MemoryRuntime.js";

export { ProcessManager } from "../pm/ProcessManager.js";
export { ConversationRuntime } from "./ConversationRuntime.js";
export { TaskScheduler } from "./TaskScheduler.js";
export { TurnController } from "./TurnController.js";
export { classifyFollowup, isStatusQuery } from "./FollowupRouter.js";
export { decideAgentIdleAfterNoTools, isActionEventType, decideDoneGuard } from "./AgentIdlePolicy.js";
export type { DoneGuardVerdict } from "./AgentIdlePolicy.js";
export type { AgentIdleAction, AgentIdleState } from "./AgentIdlePolicy.js";

type MessageEvent = Extract<TuiEvent, { type: "message" }>;

interface MessageLegalCtx {
  getState: () => { agents: Map<string, { role?: string }> };
  applyEvent: (e: TuiEvent) => void;
  pm: { observe: (e: TuiEvent) => void };
}

/**
 * Communication matrix: Worker → user and Worker → Worker are illegal. On a
 * violation, emit an agent.error (not delivered to the recipient) and return false.
 * Byte-equivalent to the old god-file top-level function.
 */
export function checkMessageLegal(ev: MessageEvent, ctx: MessageLegalCtx): boolean {
  const senderRole = ctx.getState().agents.get(ev.agent)?.role;
  if (!senderRole) return true; // unknown sender, allow
  const recipientRole = ctx.getState().agents.get(ev.to)?.role;

  // Worker → user: block
  if (senderRole === "Worker" && ev.to === "user") {
    ctx.applyEvent({ v: 1, type: "agent.error", agent: ev.agent, code: "illegal_message",
      detail: `Worker ${ev.agent} 不能直接 message.to=user（应 message.to=leader）。已拦截。` });
    ctx.pm.observe(ev); // still let PM log it
    return false;
  }
  // Worker → Worker: block
  if (senderRole === "Worker" && recipientRole === "Worker") {
    ctx.applyEvent({ v: 1, type: "agent.error", agent: ev.agent, code: "illegal_message",
      detail: `Worker ${ev.agent} 不能 message.to=${ev.to}（Worker 间不能直接通信）。已拦截。` });
    return false;
  }
  return true;
}

interface ResumeReplaceCtx {
  agents: Map<string, HttpConvAgent>;
  secretaries: Map<string, SecretaryProxy>;
  killedAgents: Set<string>;
}

/** Tear down the live agent (keeping its persisted sessions) so it can be resumed. */
export function replaceAgentForResume(id: string, ctx: ResumeReplaceCtx): void {
  ctx.agents.get(id)?.kill?.();
  ctx.agents.delete(id);
  globalBus.unregisterAgent(id);
  destroySecretary(ctx.secretaries, id);
  ctx.killedAgents.delete(id);
}
