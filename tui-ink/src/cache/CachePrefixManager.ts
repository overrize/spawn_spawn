// CachePrefixManager — 管理 Anthropic prompt caching 的缓存前缀
// 确保父 agent fork 子 agent 时，五项键值字节级一致以命中服务端 KV 缓存

/** 缓存前缀五项键值 — 必须字节级一致 */
export interface CacheSafeParams {
  /** System prompt 完整内容（不经模板替换的最终文本） */
  systemPrompt: string;
  /** 用户上下文：首次用户消息（任务目标/背景/约束/验收标准） */
  userContext: string;
  /** 系统上下文：agent id、role、cwd、在线 agent 列表等 */
  systemContext: string;
  /** 工具池顺序和定义：按字母顺序排列的工具 schema 文本 */
  toolPool: string;
  /** 对话历史前缀：截止到某个 message_index 的 user/assistant 消息列表 */
  conversationHistoryPrefix: string;
}

/** 序列化 CacheSafeParams 为字节级一致的字符串 — 用于缓存前缀比对 */
export function serializeCachePrefix(params: CacheSafeParams): string {
  // 五项按固定顺序拼接，用哨兵分隔符避免跨字段匹配
  return [
    params.systemPrompt,
    params.userContext,
    params.systemContext,
    params.toolPool,
    params.conversationHistoryPrefix,
  ].join("\n\n--- CACHE_PREFIX_SEPARATOR ---\n\n");
}

/** 从 CacheSafeParams 计算 SHA-256 校验和 — 用于快速判断前缀是否变化 */
export function computeCachePrefixHash(params: CacheSafeParams): string {
  const crypto = require("crypto") as typeof import("crypto");
  const hash = crypto.createHash("sha256");
  hash.update(serializeCachePrefix(params));
  return hash.digest("hex");
}
