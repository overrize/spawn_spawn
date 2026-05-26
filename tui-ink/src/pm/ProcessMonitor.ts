// ProcessMonitor — 统一管理子 agent 的 foreground/background 状态
// 被 ProcessManager 委托调用，负责子 agent 生命周期跟踪与通知派发

import { EventEmitter } from "node:events";
import type { TuiEvent } from "../protocol.js";

const BG_TIMEOUT_MS = 120_000; // 2min 后台切换阈值

interface ForegroundSpawnHandle {
  childId: string;
  parentId: string;
  startedAt: number;
  mode: "foreground" | "background" | "done";
  promise: Promise<{ success: boolean; reason?: string; evidence?: string[] } | null>;
  setBackground: () => void;
  _resolve: (result: { success: boolean; reason?: string; evidence?: string[] } | null) => void;
}

export class ProcessMonitor extends EventEmitter {
  private foregroundSpawns = new Map<string, ForegroundSpawnHandle>();

  /** Register a new spawn and return a handle that resolves in 30s or switches to bg at 2min. */
  registerSpawn(childId: string, parentId: string): ForegroundSpawnHandle {
    // Cancel any existing foreground promise for this child
    this.cancelForeground(childId);

    let resolve: (r: { success: boolean; reason?: string; evidence?: string[] } | null) => void;
    const promise = new Promise<{ success: boolean; reason?: string; evidence?: string[] } | null>((res) => {
      resolve = res;
    });
    const realResolve = resolve!;

    const handle: ForegroundSpawnHandle = {
      childId,
      parentId,
      startedAt: Date.now(),
      mode: "foreground",
      promise,
      setBackground: () => {
        handle.mode = "background";
        realResolve(null);
        // Emit background notification to parent
        this.emit("child.background", { childId, parentId, reason: "manual" });
      },
      _resolve: realResolve,
    };

    this.foregroundSpawns.set(childId, handle);

    // Schedule 2min auto-background transition
    setTimeout(() => {
      const h = this.foregroundSpawns.get(childId);
      if (h && h.childId === childId && h.mode === "foreground") {
        h.setBackground();
        this.emit("child.background", { childId, parentId, reason: "timeout" });
      }
    }, BG_TIMEOUT_MS);

    return handle;
  }

  /** Complete or cancel a foreground wait (called when child finishes or errors). */
  completeForeground(childId: string, result: { success: boolean; reason?: string; evidence?: string[] } | null): void {
    const h = this.foregroundSpawns.get(childId);
    if (h) {
      if (h.mode === "foreground") {
        h.mode = "done";
        h._resolve(result);
      }
    }
  }

  /** Check if a child is still in foreground (not yet timeout/background). */
  isForeground(childId: string): boolean {
    return this.foregroundSpawns.get(childId)?.mode === "foreground";
  }

  /** Cancel foreground tracking for a child (cleanup). */
  cancelForeground(childId: string): void {
    const h = this.foregroundSpawns.get(childId);
    if (h) {
      h._resolve(null);
      this.foregroundSpawns.delete(childId);
    }
  }

  /** Get all currently tracked foreground child IDs for a parent. */
  getForegroundChildren(parentId: string): string[] {
    return Array.from(this.foregroundSpawns.values())
      .filter((h) => h.parentId === parentId)
      .map((h) => h.childId);
  }

  /** Called when a child agent completes (agent.done) — emits task.notification to parent. */
  onChildDone(childId: string, success: boolean, parentId: string, reason?: string, evidence?: string[]): void {
    // Complete foreground tracking if still active
    this.completeForeground(childId, { success, reason, evidence });

    // Emit task.notification event
    const notification: Extract<TuiEvent, { type: "task.notification" }> = {
      v: 1,
      type: "task.notification",
      agent: childId,
      parent: parentId,
      child_id: childId,
      success,
      reason,
      evidence,
    };
    this.emit("task.notification", notification);

    // Cleanup after notification
    this.foregroundSpawns.delete(childId);
  }

  /** Cleanup all tracking (on destroy). */
  destroy(): void {
    for (const [childId] of this.foregroundSpawns) {
      this.cancelForeground(childId);
    }
  }

  /** Get the handle for a child (for testing / internal use). */
  getHandle(childId: string): ForegroundSpawnHandle | undefined {
    return this.foregroundSpawns.get(childId);
  }
}
