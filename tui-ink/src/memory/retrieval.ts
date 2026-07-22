/**
 * Goal-relevance fact retrieval (spawn-1.0 M3-1 vector memory).
 *
 * Replaces the old time-ordered / weight-only fact injection: given the current
 * task goal, surface the most RELEVANT facts from the working set + cold archive
 * (so a month-old constraint resurfaces when a new task touches it, instead of
 * being lost to GC or buried by recency).
 *
 * The scorer is pluggable. The default is the CJK-aware n-gram factSimilarity
 * (M1-2) — i.e. the "embedding-unavailable → n-gram degrade" path the plan calls
 * for. A real embedding cosine can slot in later without changing callers.
 */

import type { MemoryFact } from "./types.js";
import { factSimilarity } from "./SecretaryProxy.js";
import { loadArchivedFacts } from "./MemoryStore.js";

export type FactScorer = (query: string, factText: string) => number;

/** Top-k facts by relevance to `goal`. Ties broken by weight then recency. */
export function retrieveByGoal(
  goal: string,
  facts: MemoryFact[],
  k: number,
  scorer: FactScorer = factSimilarity,
): MemoryFact[] {
  if (k <= 0 || facts.length === 0) return [];
  if (!goal.trim()) {
    // No goal → fall back to weight then recency.
    return [...facts].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1) || b.ts - a.ts).slice(0, k);
  }
  const scored = facts.map((f) => ({
    f,
    // relevance dominates; small weight/recency nudge as tiebreak
    s: scorer(goal, f.text) + 0.03 * Math.log1p(f.weight ?? 1),
  }));
  scored.sort((a, b) => b.s - a.s || (b.f.weight ?? 1) - (a.f.weight ?? 1) || b.f.ts - a.f.ts);
  return scored.slice(0, k).map((x) => x.f);
}

/**
 * Retrieve the top-k facts relevant to `goal` across an agent's live working set
 * AND its cold archive, de-duplicated by id. This is what spawn/resume injects
 * instead of "last 5 by time".
 */
export function retrieveRelevant(
  agentId: string,
  workingSet: MemoryFact[],
  goal: string,
  k: number,
  scorer: FactScorer = factSimilarity,
): MemoryFact[] {
  const archived = loadArchivedFacts(agentId);
  const seen = new Set<string>();
  const pool: MemoryFact[] = [];
  for (const f of [...workingSet, ...archived]) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    pool.push(f);
  }
  return retrieveByGoal(goal, pool, k, scorer);
}
