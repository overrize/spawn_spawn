import { AgentTask, TaskQueue } from './Task.js';
import { ForkAgent } from '../agent/ForkAgent.js';
import { SpawnAgent } from '../agent/SpawnAgent.js';

export interface TaskExecutorOptions {
  minDurationMs: number;
  maxDurationMs: number;
  progressIntervalMs: number;
}

const DEFAULT_OPTIONS: TaskExecutorOptions = {
  minDurationMs: 2000,
  maxDurationMs: 8000,
  progressIntervalMs: 200,
};

export async function executeTaskOnFork(
  fork: ForkAgent,
  taskId: string,
  spawn: SpawnAgent,
  queue: TaskQueue,
  options: TaskExecutorOptions = DEFAULT_OPTIONS,
): Promise<void> {
  const task = queue.start(taskId);
  if (!task) return;

  const totalDuration = options.minDurationMs + Math.random() * (options.maxDurationMs - options.minDurationMs);
  const steps = Math.ceil(totalDuration / options.progressIntervalMs);
  const stepMs = totalDuration / steps;

  try {
    spawn.memorySet(`task:${taskId}:status`, 'running');
    spawn.memorySet(`task:${taskId}:agent`, fork.id);
    spawn.memorySet(`task:${taskId}:desc`, task.description);

    for (let i = 1; i <= steps; i++) {
      await sleep(stepMs);
      const progress = Math.round((i / steps) * 100);
      queue.progress(taskId, progress);
      spawn.memorySet(`task:${taskId}:progress`, progress);
      spawn.memorySet(`task:${taskId}:step`, `Step ${i}/${steps}`);
    }

    const result = `Completed: ${task.description}`;
    queue.complete(taskId, result);
    spawn.memorySet(`task:${taskId}:status`, 'completed');
    spawn.memorySet(`task:${taskId}:result`, result);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    queue.fail(taskId, error);
    spawn.memorySet(`task:${taskId}:status`, 'failed');
    spawn.memorySet(`task:${taskId}:error`, error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
