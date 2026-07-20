import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskScheduler } from "../../runtime/TaskScheduler.js";

describe("TaskScheduler", () => {
  it("schedules and triggers due tasks in runAt order", () => {
    const scheduler = new TaskScheduler();
    scheduler.schedule({ id: "later", conversationId: "u1", text: "later", runAt: 200, now: 0 });
    scheduler.schedule({ id: "earlier", conversationId: "u1", text: "earlier", runAt: 100, now: 0 });

    const due = scheduler.due(200);
    assert.deepEqual(due.map((event) => event.task.id), ["earlier", "later"]);
    assert.deepEqual(due.map((event) => event.task.state), ["running", "running"]);
  });

  it("does not trigger future tasks", () => {
    const scheduler = new TaskScheduler();
    scheduler.schedule({ id: "future", conversationId: "u1", text: "future", runAt: 500, now: 0 });
    assert.deepEqual(scheduler.due(100), []);
    assert.equal(scheduler.get("future")?.state, "scheduled");
  });

  it("treats missed scheduled tasks as due on the next tick", () => {
    const scheduler = new TaskScheduler();
    scheduler.schedule({ id: "missed", conversationId: "u1", text: "missed", runAt: 100, now: 0 });
    const due = scheduler.due(10_000);
    assert.equal(due.length, 1);
    assert.equal(due[0]!.task.id, "missed");
  });

  it("reschedules waiting/running task back to scheduled", () => {
    const scheduler = new TaskScheduler();
    scheduler.schedule({ id: "task", conversationId: "u1", text: "work", runAt: 100, now: 0 });
    scheduler.due(100);
    const event = scheduler.reschedule("task", 300, 150);
    assert.equal(event?.type, "task.rescheduled");
    assert.equal(event?.previousRunAt, 100);
    assert.equal(event?.task.state, "scheduled");
    assert.equal(event?.task.runAt, 300);
  });

  it("supports waiting_user state for full-duplex clarification", () => {
    const scheduler = new TaskScheduler();
    scheduler.schedule({ id: "task", conversationId: "u1", text: "work", runAt: 100, now: 0 });
    scheduler.due(100);
    const event = scheduler.markWaitingUser("task", 120);
    assert.equal(event?.type, "task.waiting_user");
    assert.equal(event?.task.state, "waiting_user");
  });

  it("cancelled tasks do not become due", () => {
    const scheduler = new TaskScheduler();
    scheduler.schedule({ id: "task", conversationId: "u1", text: "work", runAt: 100, now: 0 });
    scheduler.cancel("task", 50);
    assert.deepEqual(scheduler.due(200), []);
    assert.equal(scheduler.get("task")?.state, "cancelled");
  });

  it("completion and failure are terminal for reschedule/cancel", () => {
    const scheduler = new TaskScheduler();
    scheduler.schedule({ id: "done", conversationId: "u1", text: "done", runAt: 100, now: 0 });
    scheduler.complete("done", 110);
    assert.equal(scheduler.reschedule("done", 200), null);
    assert.equal(scheduler.cancel("done"), null);

    scheduler.schedule({ id: "failed", conversationId: "u1", text: "failed", runAt: 100, now: 0 });
    scheduler.fail("failed", "boom", 110);
    assert.equal(scheduler.reschedule("failed", 200), null);
  });
});
