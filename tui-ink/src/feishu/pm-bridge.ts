// PM → Feishu event bus.
// PMBridgeBase is the emitter; card-renderer subscribes to it.
// index.tsx emits events as the PM progresses (task_spawned, agent_delta, task_done, …).
// When PM gains true event streaming (spawn/done DAG events), index.tsx just emits more
// event types — card-renderer handles them without changes.

export type PMEvent =
  | { type: 'task_spawned';  taskId: string; agentPath: string; parentPath?: string; title: string }
  | { type: 'agent_delta';   taskId: string; agentPath: string; text: string }
  | { type: 'agent_done';    taskId: string; agentPath: string; finalText?: string }
  | { type: 'task_done';     taskId: string; summary: string }
  | { type: 'task_failed';   taskId: string; agentPath: string; error: string };

export type PMEventHandler = (e: PMEvent) => void;

export class PMBridgeBase {
  private readonly handlers = new Set<PMEventHandler>();

  subscribe(handler: PMEventHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  emit(e: PMEvent): void {
    for (const h of this.handlers) {
      try { h(e); } catch (err) {
        process.stderr.write(`[PMBridge] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }
}
