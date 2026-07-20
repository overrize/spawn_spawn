export interface FollowupDecision {
  isFollowup: boolean;
  reason: string;
}

export type ContinuityRoute =
  | "same_agent_queue"
  | "fork_new_agent"
  | "merge_with_pending_input"
  | "ask_clarification";

export interface ContinuityInput {
  text: string;
  baseAgentBusy?: boolean;
  hasPendingInputWindow?: boolean;
  msSinceLastUserMessage?: number;
  lastUserMessage?: string;
  activeTaskGoal?: string;
  recentEntities?: string[];
}

export interface ContinuityDecision {
  route: ContinuityRoute;
  confidence: number;
  reason: string;
}

const EXPLICIT_NEW_TASK_RE =
  /^(新任务|另一个任务|另外一个任务|换个任务|单独开|并行|同时|顺便帮我|另外帮我|new task\b|separate task\b|in parallel\b|also help\b)/i;

const EXPLICIT_FOLLOWUP_RE =
  /^(继续|接着|然后呢|那|这个|上面|刚才|前面|为什么|怎么做|具体|展开|详细|再说|补充|改成|换成|不是|不对|等等|等下|追问|follow up\b|continue\b|go on\b|why\b|how\b|what about\b|that\b|this\b)/i;

const CONTEXT_REF_RE =
  /(上面|刚才|前面|上一条|这个|这点|这里|那边|那个|它|他们|这些|这个方案|这个问题|this|that|above|previous|same agent|same thread|same conversation)/i;

const STANDALONE_TASK_RE =
  /^(让\s*agent|帮我|请|麻烦|检查|分析|审计|读取|修改|实现|跑|验证|看一下|查一下)/i;

const STANDALONE_ACTION_RE =
  /(检查|分析|审计|读取|修改|实现|跑|验证|说明|找出|指出|review|audit|check|inspect|read|modify|implement|test)/i;

const PATH_REF_RE =
  /(?:^|\s|：|:)(?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])+[\w.-]+(?:\.[A-Za-z0-9]+)?/;

const STATUS_QUERY_RE =
  /^(结论呢|结论|进度|到哪了|好了没|还没好吗|卡在哪里|为什么会卡住|为什么卡住|现在什么情况|什么情况|状态|status|progress|any update)[。！？!?.,，\s]*$/i;

const SHORT_ACK_RE =
  /^(嗯|好|好的|ok|OK|yes|对|不对|不是|继续|展开|具体点|详细点|为什么|怎么做|然后呢|收到|明白)[。！？!?.,，\s]*$/i;

const SHORT_AMBIGUOUS_MAX_CHARS = 60;
const MERGE_WINDOW_MS = 1_500;
const RECENT_FOLLOWUP_WINDOW_MS = 30_000;

const WORD_RE = /[A-Za-z][A-Za-z0-9_-]*|[\u4e00-\u9fff]{2,}/g;

function tokenize(text: string): Set<string> {
  const tokens = new Set((text.toLowerCase().match(WORD_RE) ?? []).filter((t) => t.length > 1));
  for (const segment of text.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i < segment.length - 1; i++) {
      tokens.add(segment.slice(i, i + 2));
    }
  }
  return tokens;
}

function overlapScore(a: string, b: string): number {
  const aa = tokenize(a);
  const bb = tokenize(b);
  if (aa.size === 0 || bb.size === 0) return 0;
  let intersect = 0;
  for (const token of aa) {
    if (bb.has(token)) intersect++;
  }
  return intersect / Math.min(aa.size, bb.size);
}

function hasRecentEntity(text: string, entities: string[] | undefined): boolean {
  if (!entities?.length) return false;
  const lower = text.toLowerCase();
  return entities.some((entity) => entity && lower.includes(entity.toLowerCase()));
}

export function isStatusQuery(text: string): boolean {
  return STATUS_QUERY_RE.test(text.trim());
}

export function discriminateContinuity(input: ContinuityInput): ContinuityDecision {
  const normalized = input.text.trim();
  if (!normalized) return { route: "ask_clarification", confidence: 1, reason: "empty" };

  if (input.hasPendingInputWindow || (input.msSinceLastUserMessage ?? Infinity) <= MERGE_WINDOW_MS) {
    return { route: "merge_with_pending_input", confidence: 0.95, reason: "within_input_window" };
  }

  if (EXPLICIT_NEW_TASK_RE.test(normalized)) {
    return { route: "fork_new_agent", confidence: 0.95, reason: "explicit_new_task" };
  }

  if (STANDALONE_TASK_RE.test(normalized) && STANDALONE_ACTION_RE.test(normalized) && PATH_REF_RE.test(normalized)) {
    return { route: "fork_new_agent", confidence: 0.88, reason: "explicit_standalone_task" };
  }

  if (EXPLICIT_FOLLOWUP_RE.test(normalized)) {
    return { route: "same_agent_queue", confidence: 0.92, reason: "explicit_followup" };
  }

  if (SHORT_ACK_RE.test(normalized)) {
    return { route: "same_agent_queue", confidence: 0.9, reason: "short_ack" };
  }

  if (CONTEXT_REF_RE.test(normalized) && normalized.length <= 120) {
    return { route: "same_agent_queue", confidence: 0.86, reason: "context_reference" };
  }

  if (hasRecentEntity(normalized, input.recentEntities)) {
    return { route: "same_agent_queue", confidence: 0.8, reason: "recent_entity_overlap" };
  }

  if (input.lastUserMessage && overlapScore(normalized, input.lastUserMessage) >= 0.34) {
    return { route: "same_agent_queue", confidence: 0.76, reason: "last_message_overlap" };
  }

  if (input.activeTaskGoal && overlapScore(normalized, input.activeTaskGoal) >= 0.28) {
    return { route: "same_agent_queue", confidence: 0.72, reason: "active_goal_overlap" };
  }

  if (normalized.length <= SHORT_AMBIGUOUS_MAX_CHARS) {
    return { route: "same_agent_queue", confidence: input.baseAgentBusy ? 0.7 : 0.62, reason: "short_ambiguous" };
  }

  if (input.baseAgentBusy && (input.msSinceLastUserMessage ?? Infinity) <= RECENT_FOLLOWUP_WINDOW_MS) {
    return { route: "same_agent_queue", confidence: 0.58, reason: "busy_recent_default" };
  }

  return { route: "fork_new_agent", confidence: 0.56, reason: "independent_or_unclear" };
}

/**
 * Conservative semantic gate for full-duplex chat.
 *
 * If the base PM is busy, obvious follow-ups should wait for that same PM's
 * history instead of being forked into a sibling PM. Short ambiguous fragments
 * are also treated as follow-ups because chat users often split one question
 * across multiple bubbles. Independent work can still fork when explicitly
 * marked as a new/parallel task.
 */
export function classifyFollowup(text: string): FollowupDecision {
  const decision = discriminateContinuity({ text, baseAgentBusy: true });
  return {
    isFollowup: decision.route === "same_agent_queue" || decision.route === "merge_with_pending_input",
    reason: decision.reason,
  };
}
