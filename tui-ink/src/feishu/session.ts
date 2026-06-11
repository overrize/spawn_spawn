// Per-task Feishu session state — replaces the implicit feishuCardPromise model.
// Each user message becomes a FeishuTask with its own card and block map.

import type { PatchScheduler } from './patch-scheduler.js';

export interface CardBlock {
  agentPath: string;   // 'PM' | 'PM/TL-1' | 'PM/TL-1/Worker-3' etc.
  title: string;
  body: string;
  state: 'pending' | 'streaming' | 'done' | 'failed';
  order: number;       // DAG topological order → card element order
}

export interface FeishuTask {
  taskId: string;
  pmId: string;
  replyId: string;
  replyType: 'open_id' | 'chat_id';
  rootMessageId: string;     // user's message — used for reply API anchor + reaction deletion
  replyMessageId: string | null; // ID of our reply card once created (null until first flush)
  reactionId: string | null;
  blocks: Map<string, CardBlock>;
  startedAt: number;
  status: 'running' | 'done' | 'failed';
  footer?: string;
  scheduler: PatchScheduler;
}

// taskId → FeishuTask
export const taskRegistry = new Map<string, FeishuTask>();
// card message_id → taskId (for future card-action callbacks)
export const cardIndex = new Map<string, string>();
// pmId → current active taskId (so replyHook knows which task to emit into)
export const pmCurrentTask = new Map<string, string>();
