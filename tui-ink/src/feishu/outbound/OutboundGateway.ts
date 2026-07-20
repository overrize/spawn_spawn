/**
 * OutboundGateway — unified exit point for all content sent to Feishu users.
 *
 * Every message.to=user fragment from any PM/fork passes through this pipeline:
 *
 *   1. SuppressFilter   — should we send this at all?
 *   2. (ContentResolver)— handled at flush() time: inject pending artifact files
 *   3. FormatDecider    — text bubble or document card?
 *   4. Sanitizer        — unescape, strip/preserve markdown
 *   5. Dispatcher       — aggregator.onChunk() (+ onTurnEnd at flush)
 *
 * Single rule to add a "never send this" case: edit SuppressFilter only.
 * Single rule to add a new format trigger: edit FormatDecider only.
 * Single rule to add a new sanitization step: edit Sanitizer only.
 */

import * as fs from "node:fs";
import { shouldSuppress } from "./SuppressFilter.js";
import { decideFormat } from "./FormatDecider.js";
import { sanitize } from "./Sanitizer.js";
import type { OutboundMsg, OutboundContext } from "./types.js";
import type { FeishuReplyAggregator } from "../replyAggregator.js";

export class OutboundGateway {
  constructor(
    /** Return the aggregator for a PM, or undefined if session not active. */
    private readonly getAggregator: (pmId: string) => FeishuReplyAggregator | undefined,
    /** Return pending artifact file paths for a PM (files to inject at turnEnd). */
    private readonly getPendingArtifacts: (pmId: string) => string[] | undefined,
    /** Clear pending artifact paths after injection. */
    private readonly clearPendingArtifacts: (pmId: string) => void,
  ) {}

  /**
   * Process one message.to=user fragment through the pipeline.
   * Called each time a PM/fork emits a message to user.
   */
  accept(msg: OutboundMsg, ctx: OutboundContext): void {
    // 1. SuppressFilter
    const suppressReason = shouldSuppress(msg, ctx);
    if (suppressReason) {
      process.stderr.write(
        `[outbound] suppressed [${msg.agentId}→user]: ${suppressReason} | "${msg.text.slice(0, 60)}"\n`,
      );
      return;
    }

    // 3. FormatDecider
    const format = decideFormat(msg.text, msg.format);

    // 4. Sanitizer
    const clean = sanitize(msg.text, format);
    if (!clean.trim()) return;

    // 5. Dispatcher (per-fragment)
    this.getAggregator(ctx.pmId)?.onChunk(clean, format, { agentId: msg.agentId });
  }

  /**
   * Flush a PM turn to Feishu.
   *
   * Runs ContentResolver: reads any artifact files TL reported this turn and
   * injects them as document chunks BEFORE triggering aggregator.onTurnEnd().
   * This guarantees full file content reaches Feishu even when PM only sent a summary.
   *
   * Call this instead of aggregator.onTurnEnd() in every turnEndHook.
   */
  flush(pmId: string): void {
    // 2. ContentResolver — inject pending artifact files
    const paths = this.getPendingArtifacts(pmId);
    if (paths?.length) {
      this.clearPendingArtifacts(pmId);
      const agg = this.getAggregator(pmId);
      if (agg) {
        for (const filePath of [...new Set(paths)]) {
          try {
            const content = fs.readFileSync(filePath, "utf8");
            process.stderr.write(
              `[outbound] artifact inject "${filePath}" (${content.length}c) → ${pmId}\n`,
            );
            // Artifacts are always documents; let FormatDecider confirm.
            const fmt = decideFormat(content, "document");
            agg.onChunk(sanitize(content, fmt), fmt, { agentId: pmId });
          } catch (err) {
            process.stderr.write(
              `[outbound] failed to read artifact "${filePath}": ${(err as Error).message}\n`,
            );
          }
        }
      } else {
        process.stderr.write(
          `[outbound] no aggregator for ${pmId} — discarding ${paths.length} artifact(s)\n`,
        );
      }
    }

    // 5. Dispatcher (turn-end)
    this.getAggregator(pmId)?.onTurnEnd();
  }
}

export type { OutboundMsg, OutboundContext };
