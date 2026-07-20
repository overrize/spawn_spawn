// Card renderer: subscribes to PMBridge events, renders multi-block cards.
// One card per task, each agent gets its own block, blocks are appended in DAG order.

import { taskRegistry, cardIndex, FeishuTask, CardBlock } from './session.js';
import { PatchScheduler } from './patch-scheduler.js';
import { PMEvent } from './pm-bridge.js';
import { patchCardMessage, replyToMessageWithCard, sendTextMessage, deleteProcessingReaction } from './message.js';
import { TokenManager } from './auth.js';
import { feishuLog } from './debug.js';
import { FeishuInteractiveContent, FeishuCardElement } from './types.js';

// ── Card rendering ────────────────────────────────────────────────────────────

function buildCardElements(task: FeishuTask): FeishuCardElement[] {
  const sorted = [...task.blocks.values()].sort((a, b) => a.order - b.order);
  const elements: FeishuCardElement[] = [];
  // Use subtle ✓ for intermediate done blocks; bold ✅ only when the whole task is complete
  const doneIcon = task.status === 'done' ? '✅' : '✓';

  for (const block of sorted) {
    const icon = { pending: '⏳', streaming: '▋', done: doneIcon, failed: '❌' }[block.state];
    elements.push({ tag: 'markdown', content: `**${block.title}** ${icon}` });
    if (block.body) elements.push({ tag: 'markdown', content: block.body });
    elements.push({ tag: 'hr' });
  }
  if (elements.at(-1)?.tag === 'hr') elements.pop();

  return elements;
}

function buildCard(task: FeishuTask): FeishuInteractiveContent {
  const elements = buildCardElements(task);

  if (elements.length === 0) {
    // Scheduler only fires after first delta, so this is a rare race-condition guard
    elements.push({ tag: 'markdown', content: '▋' });
  }
  if (task.footer) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: task.footer }] });
  }

  const h =
    task.status === 'done'   ? { template: 'green', title: '✅ 已回复' } :
    task.status === 'failed' ? { template: 'red',   title: '❌ 处理失败' } :
                               { template: 'blue',  title: '🦞 PM 回复中 ▋' };
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: h.title }, template: h.template as 'green' | 'red' | 'blue' },
    elements,
  };
}

// ── Task factory ──────────────────────────────────────────────────────────────

export function createTask(
  props: {
    pmId: string;
    replyId: string;
    replyType: 'open_id' | 'chat_id';
    rootMessageId: string;
  },
  tokenManager: TokenManager,
): FeishuTask {
  // Scheduler captures task via ref so it can access cardMessageId after it resolves
  const ref: { task: FeishuTask | null } = { task: null };

  const scheduler = new PatchScheduler(
    async () => {
      const t = ref.task;
      if (!t) return;
      const card = buildCard(t);
      if (!t.replyMessageId) {
        // First flush: create the reply card, anchored under the user's original message
        const msgId = await replyToMessageWithCard(t.rootMessageId, card, tokenManager);
        if (msgId) {
          t.replyMessageId = msgId;
          cardIndex.set(msgId, t.taskId);
          feishuLog(`[CardRenderer] created reply card ${msgId} for task ${t.taskId}`);
        }
      } else {
        await patchCardMessage(t.replyMessageId, card, tokenManager);
      }
    },
    async () => {
      const t = ref.task;
      if (!t) return;
      const body = [...t.blocks.values()].find(b => b.agentPath === 'PM')?.body ?? '处理失败';
      await sendTextMessage(t.replyId, t.replyType, body, tokenManager);
    },
  );

  const task: FeishuTask = {
    taskId: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    ...props,
    replyMessageId: null,
    reactionId: null,
    blocks: new Map<string, CardBlock>(),
    startedAt: Date.now(),
    status: 'running',
    footer: undefined,
    scheduler,
  };
  ref.task = task;
  return task;
}

// ── Event handler factory ─────────────────────────────────────────────────────

export function createCardRenderer(tokenManager: TokenManager): (e: PMEvent) => void {
  return function handlePMEvent(e: PMEvent): void {
    const task = taskRegistry.get(e.taskId);
    if (!task) return;

    switch (e.type) {
      case 'task_spawned': {
        task.blocks.set(e.agentPath, {
          agentPath: e.agentPath,
          title: e.title,
          body: '',
          state: 'pending',
          order: task.blocks.size,
        });
        // Card is created on first actual content (agent_delta or agent_done), not here.
        // This prevents a premature "pending" card from appearing for format=text (bubble) turns.
        break;
      }

      case 'agent_delta': {
        let block = task.blocks.get(e.agentPath);
        if (!block) {
          block = { agentPath: e.agentPath, title: e.agentPath, body: '', state: 'streaming', order: task.blocks.size };
          task.blocks.set(e.agentPath, block);
        }
        block.body += e.text;
        block.state = 'streaming';
        task.scheduler.schedule();
        break;
      }

      case 'agent_done': {
        if (task.status === 'done' || task.status === 'failed') {
          feishuLog(`[CardRenderer] duplicate agent_done ignored for task ${e.taskId}`);
          break;
        }
        const block = task.blocks.get(e.agentPath);
        if (block) {
          if (e.finalText !== undefined) block.body = e.finalText;
          block.state = 'done';
          task.scheduler.schedule();
        }
        break;
      }

      case 'task_done': {
        if (task.status === 'done') {
          feishuLog(`[CardRenderer] duplicate task_done ignored for task ${e.taskId}`);
          break;
        }
        // Mark any still-streaming blocks as done
        for (const b of task.blocks.values()) {
          if (b.state === 'streaming' || b.state === 'pending') b.state = 'done';
        }
        task.status = 'done';
        task.footer = `耗时 ${((Date.now() - task.startedAt) / 1000).toFixed(1)}s`;
        if (task.reactionId && task.rootMessageId) {
          deleteProcessingReaction(task.rootMessageId, task.reactionId, tokenManager);
        }
        // flush = cancel timer + immediate patch with footer
        task.scheduler.flush();
        feishuLog(`[CardRenderer] task ${e.taskId} done, card patched with footer`);
        break;
      }

      case 'task_failed': {
        const block = task.blocks.get(e.agentPath);
        if (block) block.state = 'failed';
        task.status = 'failed';
        if (task.reactionId && task.rootMessageId) {
          deleteProcessingReaction(task.rootMessageId, task.reactionId, tokenManager);
        }
        task.scheduler.flush();
        feishuLog(`[CardRenderer] task ${e.taskId} failed: ${e.error}`);
        break;
      }
    }
  };
}
