/**
 * Unit tests for AI proxy token budget tracking service.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  buildBudgetKey,
  buildBudgetSettingsKey,
  checkTokenBudget,
  deleteUserBudgetSettings,
  getTokenUsage,
  getUserBudgetSettings,
  incrementTokenUsage,
  resolveEffectiveLimits,
  saveUserBudgetSettings,
  validateBudgetUpdate,
} from '../../../src/services/ai-token-budget';

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

  it('allows requests when usage exactly equals limit', async () => {
    const kv = createMockKV();
    const key = buildBudgetKey('user-exact');
    kv._store.set(key, JSON.stringify({ inputTokens: 500_000, outputTokens: 200_000 }));

    const result = await checkTokenBudget(kv, 'user-exact', makeEnv());
    expect(result.allowed).toBe(true);
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

  it('uses user-set budget limits when present', async () => {
    const kv = createMockKV();
    // User sets a lower input limit
    const settingsKey = buildBudgetSettingsKey('user-budgeted');
    kv._store.set(settingsKey, JSON.stringify({
      dailyInputTokenLimit: 10_000,
      dailyOutputTokenLimit: 5_000,
      monthlyCostCapUsd: null,
      alertThresholdPercent: 80,
    }));

    // Usage is under user limit
    const key = buildBudgetKey('user-budgeted');
    kv._store.set(key, JSON.stringify({ inputTokens: 9_000, outputTokens: 0 }));

    const result = await checkTokenBudget(kv, 'user-budgeted', makeEnv());
    expect(result.allowed).toBe(true);
    expect(result.inputLimit).toBe(10_000);
    expect(result.outputLimit).toBe(5_000);

    // Now exceed user limit but still under platform default
    kv._store.set(key, JSON.stringify({ inputTokens: 11_000, outputTokens: 0 }));
    const result2 = await checkTokenBudget(kv, 'user-budgeted', makeEnv());
    expect(result2.allowed).toBe(false);
  });

  it('falls back to platform defaults when user has no custom settings', async () => {
    const kv = createMockKV();
    // No budget settings stored for this user

    const result = await checkTokenBudget(kv, 'user-nobudget', makeEnv());
    expect(result.allowed).toBe(true);
    expect(result.inputLimit).toBe(500_000); // platform default
    expect(result.outputLimit).toBe(200_000); // platform default
  });
});

// =============================================================================
// User Budget Settings CRUD
// =============================================================================

describe('getUserBudgetSettings / saveUserBudgetSettings / deleteUserBudgetSettings', () => {
  it('returns null when no settings exist', async () => {
    const kv = createMockKV();
    const settings = await getUserBudgetSettings(kv, 'user-nosettings');
    expect(settings).toBeNull();
  });

  it('saves and retrieves budget settings', async () => {
    const kv = createMockKV();
    const settings = {
      dailyInputTokenLimit: 100_000,
      dailyOutputTokenLimit: 50_000,
      monthlyCostCapUsd: 25.0,
      alertThresholdPercent: 90,
    };

    await saveUserBudgetSettings(kv, 'user-save', settings);

    const retrieved = await getUserBudgetSettings(kv, 'user-save');
    expect(retrieved).toEqual(settings);
  });

  it('deletes budget settings', async () => {
    const kv = createMockKV();
    await saveUserBudgetSettings(kv, 'user-del', {
      dailyInputTokenLimit: 100_000,
      dailyOutputTokenLimit: 50_000,
      monthlyCostCapUsd: null,
      alertThresholdPercent: 80,
    });

    await deleteUserBudgetSettings(kv, 'user-del');
    expect(kv.delete).toHaveBeenCalled();
  });
});

describe('buildBudgetSettingsKey', () => {
  it('creates key with userId', () => {
    expect(buildBudgetSettingsKey('user-123')).toBe('ai-budget-settings:user-123');
  });
});

describe('resolveEffectiveLimits', () => {
  const makeEnv = (overrides: Partial<Env> = {}) =>
    ({
      AI_PROXY_DAILY_INPUT_TOKEN_LIMIT: undefined,
      AI_PROXY_DAILY_OUTPUT_TOKEN_LIMIT: undefined,
      ...overrides,
    }) as unknown as Env;

  it('uses user settings when available', () => {
    const limits = resolveEffectiveLimits(
      {
        dailyInputTokenLimit: 10_000,
        dailyOutputTokenLimit: 5_000,
        monthlyCostCapUsd: null,
        alertThresholdPercent: 80,
      },
      makeEnv(),
    );
    expect(limits.dailyInputTokenLimit).toBe(10_000);
    expect(limits.dailyOutputTokenLimit).toBe(5_000);
  });

  it('falls back to platform env vars', () => {
    const limits = resolveEffectiveLimits(
      null,
      makeEnv({ AI_PROXY_DAILY_INPUT_TOKEN_LIMIT: '250000' }),
    );
    expect(limits.dailyInputTokenLimit).toBe(250_000);
    expect(limits.dailyOutputTokenLimit).toBe(200_000); // shared default
  });

  it('falls back to shared constants when no env vars set', () => {
    const limits = resolveEffectiveLimits(null, makeEnv());
    expect(limits.dailyInputTokenLimit).toBe(500_000);
    expect(limits.dailyOutputTokenLimit).toBe(200_000);
  });

  it('user null fields fall through to platform defaults', () => {
    const limits = resolveEffectiveLimits(
      {
        dailyInputTokenLimit: null,
        dailyOutputTokenLimit: 5_000,
        monthlyCostCapUsd: null,
        alertThresholdPercent: 80,
      },
      makeEnv(),
    );
    expect(limits.dailyInputTokenLimit).toBe(500_000); // platform default
    expect(limits.dailyOutputTokenLimit).toBe(5_000); // user-set
  });
});

describe('validateBudgetUpdate', () => {
  const makeEnv = (overrides: Partial<Env> = {}) =>
    ({
      AI_USAGE_MAX_DAILY_TOKEN_LIMIT: undefined,
      AI_USAGE_MAX_MONTHLY_COST_CAP_USD: undefined,
      ...overrides,
    }) as unknown as Env;

  it('validates a valid budget update', () => {
    const settings = validateBudgetUpdate({
      dailyInputTokenLimit: 100_000,
      dailyOutputTokenLimit: 50_000,
      monthlyCostCapUsd: 25.5,
      alertThresholdPercent: 90,
    }, makeEnv());

    expect(settings.dailyInputTokenLimit).toBe(100_000);
    expect(settings.dailyOutputTokenLimit).toBe(50_000);
    expect(settings.monthlyCostCapUsd).toBe(25.5);
    expect(settings.alertThresholdPercent).toBe(90);
  });

  it('allows null values (remove limit)', () => {
    const settings = validateBudgetUpdate({
      dailyInputTokenLimit: null,
      monthlyCostCapUsd: null,
    }, makeEnv());

    expect(settings.dailyInputTokenLimit).toBeNull();
    expect(settings.monthlyCostCapUsd).toBeNull();
  });

  it('rejects token limit below 1000', () => {
    expect(() => validateBudgetUpdate({
      dailyInputTokenLimit: 500,
    }, makeEnv())).toThrow('dailyInputTokenLimit must be between 1000 and');
  });

  it('rejects token limit above max', () => {
    expect(() => validateBudgetUpdate({
      dailyInputTokenLimit: 999_999_999,
    }, makeEnv())).toThrow('dailyInputTokenLimit must be between 1000 and');
  });

  it('rejects monthly cost cap below 0.01', () => {
    expect(() => validateBudgetUpdate({
      monthlyCostCapUsd: 0.001,
    }, makeEnv())).toThrow('monthlyCostCapUsd must be between 0.01 and');
  });

  it('rejects alert threshold outside 1-100', () => {
    expect(() => validateBudgetUpdate({
      alertThresholdPercent: 0,
    }, makeEnv())).toThrow('alertThresholdPercent must be between 1 and 100');

    expect(() => validateBudgetUpdate({
      alertThresholdPercent: 101,
    }, makeEnv())).toThrow('alertThresholdPercent must be between 1 and 100');
  });

  it('floors token limits to integers', () => {
    const settings = validateBudgetUpdate({
      dailyInputTokenLimit: 10_500.7,
    }, makeEnv());
    expect(settings.dailyInputTokenLimit).toBe(10_500);
  });

  it('rounds monthly cost to 2 decimal places', () => {
    const settings = validateBudgetUpdate({
      monthlyCostCapUsd: 25.555,
    }, makeEnv());
    expect(settings.monthlyCostCapUsd).toBe(25.56);
  });
});
