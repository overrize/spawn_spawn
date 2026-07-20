export type ScheduledTaskState =
  | "scheduled"
  | "running"
  | "waiting_user"
  | "done"
  | "failed"
  | "cancelled";

export interface ScheduledTask {
  id: string;
  conversationId: string;
  text: string;
  runAt: number;
  state: ScheduledTaskState;
  createdAt: number;
  updatedAt: number;
}

export type SchedulerEvent =
  | { type: "task.scheduled"; task: ScheduledTask }
  | { type: "task.due"; task: ScheduledTask }
  | { type: "task.rescheduled"; task: ScheduledTask; previousRunAt: number }
  | { type: "task.cancelled"; task: ScheduledTask }
  | { type: "task.completed"; task: ScheduledTask }
  | { type: "task.failed"; task: ScheduledTask; reason: string }
  | { type: "task.waiting_user"; task: ScheduledTask };

export class TaskScheduler {
  private readonly tasks = new Map<string, ScheduledTask>();
  private seq = 0;

  schedule(input: {
    conversationId: string;
    text: string;
    runAt: number;
    now?: number;
    id?: string;
  }): SchedulerEvent {
    const now = input.now ?? Date.now();
    const task: ScheduledTask = {
      id: input.id ?? `task-${++this.seq}`,
      conversationId: input.conversationId,
      text: input.text,
      runAt: input.runAt,
      state: "scheduled",
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    return { type: "task.scheduled", task: { ...task } };
  }

  due(now = Date.now()): SchedulerEvent[] {
    const events: SchedulerEvent[] = [];
    for (const task of [...this.tasks.values()].sort((a, b) => a.runAt - b.runAt || a.createdAt - b.createdAt)) {
      if (task.state !== "scheduled") continue;
      if (task.runAt > now) continue;
      task.state = "running";
      task.updatedAt = now;
      events.push({ type: "task.due", task: { ...task } });
    }
    return events;
  }

  reschedule(id: string, runAt: number, now = Date.now()): SchedulerEvent | null {
    const task = this.tasks.get(id);
    if (!task || task.state === "done" || task.state === "failed" || task.state === "cancelled") return null;
    const previousRunAt = task.runAt;
    task.runAt = runAt;
    task.state = "scheduled";
    task.updatedAt = now;
    return { type: "task.rescheduled", task: { ...task }, previousRunAt };
  }

  markWaitingUser(id: string, now = Date.now()): SchedulerEvent | null {
    const task = this.tasks.get(id);
    if (!task || task.state !== "running") return null;
    task.state = "waiting_user";
    task.updatedAt = now;
    return { type: "task.waiting_user", task: { ...task } };
  }

  complete(id: string, now = Date.now()): SchedulerEvent | null {
    const task = this.tasks.get(id);
    if (!task || task.state === "cancelled") return null;
    task.state = "done";
    task.updatedAt = now;
    return { type: "task.completed", task: { ...task } };
  }

  fail(id: string, reason: string, now = Date.now()): SchedulerEvent | null {
    const task = this.tasks.get(id);
    if (!task || task.state === "cancelled") return null;
    task.state = "failed";
    task.updatedAt = now;
    return { type: "task.failed", task: { ...task }, reason };
  }

  cancel(id: string, now = Date.now()): SchedulerEvent | null {
    const task = this.tasks.get(id);
    if (!task || task.state === "done" || task.state === "failed" || task.state === "cancelled") return null;
    task.state = "cancelled";
    task.updatedAt = now;
    return { type: "task.cancelled", task: { ...task } };
  }

  get(id: string): ScheduledTask | null {
    const task = this.tasks.get(id);
    return task ? { ...task } : null;
  }

  list(): ScheduledTask[] {
    return [...this.tasks.values()]
      .map((task) => ({ ...task }))
      .sort((a, b) => a.runAt - b.runAt || a.createdAt - b.createdAt);
  }
}
