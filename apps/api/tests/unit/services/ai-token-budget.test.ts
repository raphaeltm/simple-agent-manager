/**
 * Unit tests for AI proxy token budget tracking service.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  buildBudgetKey,
  checkTokenBudget,
  getTokenUsage,
  incrementTokenUsage,
} from '../../../src/services/ai-token-budget';
import type { Env } from '../../../src/env';

/** Create a mock KV namespace with in-memory storage. */
function createMockKV(): KVNamespace & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    get: vi.fn(async (key: string, type?: string) => {
      const val = store.get(key);
      if (val === undefined) return null;
      if (type === 'json') return JSON.parse(val);
      return val;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null, cacheStatus: null })),
  } as unknown as KVNamespace & { _store: Map<string, string> };
}

describe('buildBudgetKey', () => {
  it('creates key with userId and date', () => {
    const date = new Date('2026-04-13T10:00:00Z');
    expect(buildBudgetKey('user-123', date)).toBe('ai-budget:user-123:2026-04-13');
  });

  it('uses current date when none provided', () => {
    const key = buildBudgetKey('user-456');
    expect(key).toMatch(/^ai-budget:user-456:\d{4}-\d{2}-\d{2}$/);
  });
});

describe('getTokenUsage', () => {
  it('returns zero counts for new user', async () => {
    const kv = createMockKV();
    const usage = await getTokenUsage(kv, 'user-new');
    expect(usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('returns existing usage from KV', async () => {
    const kv = createMockKV();
    const key = buildBudgetKey('user-existing');
    kv._store.set(key, JSON.stringify({ inputTokens: 1000, outputTokens: 500 }));

    const usage = await getTokenUsage(kv, 'user-existing');
    expect(usage.inputTokens).toBe(1000);
    expect(usage.outputTokens).toBe(500);
  });
});

describe('incrementTokenUsage', () => {
  it('creates entry for first-time user', async () => {
    const kv = createMockKV();
    const result = await incrementTokenUsage(kv, 'user-first', 100, 50);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(kv.put).toHaveBeenCalledOnce();
  });

  it('accumulates tokens across calls', async () => {
    const kv = createMockKV();
    await incrementTokenUsage(kv, 'user-accum', 100, 50);
    const result = await incrementTokenUsage(kv, 'user-accum', 200, 100);
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(150);
  });

  it('stores with TTL via KV.put', async () => {
    const kv = createMockKV();
    await incrementTokenUsage(kv, 'user-ttl', 10, 5);
    expect(kv.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { expirationTtl: 86400 + 3600 },
    );
  });
});

describe('checkTokenBudget', () => {
  const makeEnv = (overrides: Partial<Env> = {}) =>
    ({
      AI_PROXY_DAILY_INPUT_TOKEN_LIMIT: undefined,
      AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT: undefined,
      ...overrides,
    }) as unknown as Env;

  it('allows requests when under budget', async () => {
    const kv = createMockKV();
    const result = await checkTokenBudget(kv, 'user-ok', makeEnv());
    expect(result.allowed).toBe(true);
    expect(result.inputLimit).toBe(500_000);
    expect(result.outputLimit).toBe(200_000);
  });

  it('denies requests when input tokens exceed limit', async () => {
    const kv = createMockKV();
    // Pre-fill with tokens exceeding default limit
    const key = buildBudgetKey('user-over');
    kv._store.set(key, JSON.stringify({ inputTokens: 600_000, outputTokens: 100 }));

    const result = await checkTokenBudget(kv, 'user-over', makeEnv());
    expect(result.allowed).toBe(false);
  });

  it('denies requests when output tokens exceed limit', async () => {
    const kv = createMockKV();
    const key = buildBudgetKey('user-out');
    kv._store.set(key, JSON.stringify({ inputTokens: 100, outputTokens: 300_000 }));

    const result = await checkTokenBudget(kv, 'user-out', makeEnv());
    expect(result.allowed).toBe(false);
  });

  it('respects env var overrides for limits', async () => {
    const kv = createMockKV();
    const key = buildBudgetKey('user-custom');
    kv._store.set(key, JSON.stringify({ inputTokens: 900, outputTokens: 0 }));

    const result = await checkTokenBudget(
      kv,
      'user-custom',
      makeEnv({ AI_PROXY_DAILY_INPUT_TOKEN_LIMIT: '1000' }),
    );
    expect(result.allowed).toBe(true);
    expect(result.inputLimit).toBe(1000);

    // Now exceed the custom limit
    kv._store.set(key, JSON.stringify({ inputTokens: 1001, outputTokens: 0 }));
    const result2 = await checkTokenBudget(
      kv,
      'user-custom',
      makeEnv({ AI_PROXY_DAILY_INPUT_TOKEN_LIMIT: '1000' }),
    );
    expect(result2.allowed).toBe(false);
  });
});
