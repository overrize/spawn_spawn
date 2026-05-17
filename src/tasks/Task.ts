import { AgentId } from '../core/types.js';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface AgentTask {
  id: string;
  description: string;
  status: TaskStatus;
  progress: number;
  startedAt: number | null;
  completedAt: number | null;
  duration: number;
  result: string | null;
  error: string | null;
  assignedTo: AgentId | null;
}

export interface TaskSnapshot {
  tasks: AgentTask[];
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

let taskCounter = 0;

export function createTaskId(): string {
  return `task-${Date.now().toString(36)}-${(++taskCounter).toString(36)}`;
}

export function createTask(description: string, assignedTo?: AgentId): AgentTask {
  return {
    id: createTaskId(),
    description,
    status: 'pending',
    progress: 0,
    startedAt: null,
    completedAt: null,
    duration: 0,
    result: null,
    error: null,
    assignedTo: assignedTo ?? null,
  };
}

export class TaskQueue {
  private tasks: Map<string, AgentTask> = new Map();
  private listeners: Set<() => void> = new Set();

  enqueue(task: AgentTask): void {
    task.status = 'pending';
    this.tasks.set(task.id, task);
    this.notify();
  }

  start(taskId: string): AgentTask | null {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'pending') return null;
    task.status = 'running';
    task.startedAt = Date.now();
    this.notify();
    return task;
  }

  progress(taskId: string, progress: number): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return;
    task.progress = Math.max(0, Math.min(100, Math.round(progress)));
    if (task.startedAt) {
      task.duration = Date.now() - task.startedAt;
    }
    this.notify();
  }

  complete(taskId: string, result?: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return;
    task.status = 'completed';
    task.progress = 100;
    task.completedAt = Date.now();
    if (task.startedAt) task.duration = task.completedAt - task.startedAt;
    task.result = result ?? null;
    this.notify();
  }

  fail(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = 'failed';
    task.completedAt = Date.now();
    if (task.startedAt) task.duration = task.completedAt - task.startedAt;
    task.error = error;
    this.notify();
  }

  get(taskId: string): AgentTask | undefined {
    return this.tasks.get(taskId);
  }

  getAll(): AgentTask[] {
    return [...this.tasks.values()];
  }

  getRunning(): AgentTask[] {
    return this.getAll().filter(t => t.status === 'running');
  }

  getPending(): AgentTask[] {
    return this.getAll().filter(t => t.status === 'pending');
  }

  snapshot(): TaskSnapshot {
    const tasks = this.getAll();
    return {
      tasks,
      pending: tasks.filter(t => t.status === 'pending').length,
      running: tasks.filter(t => t.status === 'running').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      failed: tasks.filter(t => t.status === 'failed').length,
    };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.tasks.clear();
    this.notify();
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch {}
    }
  }
}
