import { describe, it, expect } from 'vitest';
import { CacheSafeParams, serializeCachePrefix } from '../cache/CachePrefixManager';

describe('serializeCachePrefix', () => {
  const baseParams: CacheSafeParams = {
    systemPrompt: 'You are a helpful assistant.',
    userContext: 'User has requested a task.',
    systemContext: 'System is running in test mode.',
    toolPool: JSON.stringify([
      { name: 'read', description: 'Read a file' },
      { name: 'write', description: 'Write a file' },
    ]),
    conversationHistoryPrefix: 'Previous messages...',
  };

  it('should produce identical output for identical input (same reference)', () => {
    const a = serializeCachePrefix(baseParams);
    const b = serializeCachePrefix(baseParams);
    expect(a).toBe(b);
  });

  it('should produce identical output for deep-equal but different reference input', () => {
    const toolPoolStr = JSON.stringify([
      { name: 'read', description: 'Read a file' },
      { name: 'write', description: 'Write a file' },
    ]);
    const params1: CacheSafeParams = {
      systemPrompt: 'You are a helpful assistant.',
      userContext: 'User has requested a task.',
      systemContext: 'System is running in test mode.',
      toolPool: toolPoolStr,
      conversationHistoryPrefix: 'Previous messages...',
    };
    const params2: CacheSafeParams = {
      systemPrompt: 'You are a helpful assistant.',
      userContext: 'User has requested a task.',
      systemContext: 'System is running in test mode.',
      toolPool: toolPoolStr,
      conversationHistoryPrefix: 'Previous messages...',
    };
    const a = serializeCachePrefix(params1);
    const b = serializeCachePrefix(params2);
    expect(a).toBe(b);
  });

  it('should produce different output for different systemPrompt', () => {
    const params1: CacheSafeParams = {
      ...baseParams,
      systemPrompt: 'You are a helpful assistant.',
    };
    const params2: CacheSafeParams = {
      ...baseParams,
      systemPrompt: 'You are a different assistant.',
    };
    const a = serializeCachePrefix(params1);
    const b = serializeCachePrefix(params2);
    expect(a).not.toBe(b);
  });

  it('should produce different output for different toolPool order', () => {
    const params1: CacheSafeParams = {
      ...baseParams,
      toolPool: JSON.stringify([
        { name: 'read', description: 'Read a file' },
        { name: 'write', description: 'Write a file' },
      ]),
    };
    const params2: CacheSafeParams = {
      ...baseParams,
      toolPool: JSON.stringify([
        { name: 'write', description: 'Write a file' },
        { name: 'read', description: 'Read a file' },
      ]),
    };
    const a = serializeCachePrefix(params1);
    const b = serializeCachePrefix(params2);
    expect(a).not.toBe(b);
  });

  it('should produce consistent output for empty strings', () => {
    const emptyParams: CacheSafeParams = {
      systemPrompt: '',
      userContext: '',
      systemContext: '',
      toolPool: '',
      conversationHistoryPrefix: '',
    };
    const a = serializeCachePrefix(emptyParams);
    const b = serializeCachePrefix(emptyParams);
    expect(a).toBe(b);
    // Verify structure: should contain 4 separators (5 fields)
    const SEP = '\n\n--- CACHE_PREFIX_SEPARATOR ---\n\n';
    expect(a.split(SEP)).toHaveLength(5);
  });
});
