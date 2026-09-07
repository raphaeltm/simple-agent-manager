import {
  DEFAULT_AI_MONTHLY_COST_CACHE_TTL_SECONDS,
} from '@simple-agent-manager/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import type { AIGatewayLogEntry } from '../../../src/services/ai-gateway-logs';

const mockIterateGatewayLogs = vi.fn();

vi.mock('../../../src/services/ai-gateway-logs', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/ai-gateway-logs')>(
    '../../../src/services/ai-gateway-logs'
  );
  return {
    ...actual,
    iterateGatewayLogs: (...args: unknown[]) => mockIterateGatewayLogs(...args),
  };
});

vi.mock('../../../src/lib/logger', () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const {
  MAX_MONTHLY_COST_CACHE_TTL_SECONDS,
  resolveMonthlyCostCacheTtlSeconds,
  runMonthlyCostAggregation,
} = await import('../../../src/services/ai-monthly-cost-cron');

function makeGatewayEntry(overrides: Partial<AIGatewayLogEntry> = {}): AIGatewayLogEntry {
  return {
    id: 'entry-1',
    model: 'gpt-4.1',
    provider: 'openai',
    tokens_in: 100,
    tokens_out: 50,
    cost: 0.1,
    success: true,
    cached: false,
    created_at: '2026-06-15T10:00:00.000Z',
    duration: 250,
    metadata: { userId: 'user-a' },
    ...overrides,
  };
}

function createMockKV(failingKeys: Set<string> = new Set()): KVNamespace & {
  _store: Map<string, string>;
  _ttlByKey: Map<string, number | undefined>;
} {
  const store = new Map<string, string>();
  const ttlByKey = new Map<string, number | undefined>();
  return {
    _store: store,
    _ttlByKey: ttlByKey,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string, options?: KVNamespacePutOptions) => {
      if (failingKeys.has(key)) {
        throw new Error(`KV write failed for ${key}`);
      }
      store.set(key, value);
      ttlByKey.set(key, options?.expirationTtl);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null, cacheStatus: null })),
  } as unknown as KVNamespace & {
    _store: Map<string, string>;
    _ttlByKey: Map<string, number | undefined>;
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI_GATEWAY_ID: 'gateway-1',
    KV: createMockKV(),
    AI_MONTHLY_COST_CACHE_TTL_SECONDS: undefined,
    AI_MONTHLY_COST_AGGREGATION_MAX_PAGES: undefined,
    ...overrides,
  } as Env;
}

describe('resolveMonthlyCostCacheTtlSeconds', () => {
  it('falls back for missing, empty, invalid, zero, negative, NaN, and below-min values', () => {
    for (const raw of [undefined, '', '   ', 'abc', '0', '-1', 'NaN', '59']) {
      expect(resolveMonthlyCostCacheTtlSeconds(raw)).toBe(
        DEFAULT_AI_MONTHLY_COST_CACHE_TTL_SECONDS
      );
    }
  });

  it('floors positive fractional values deterministically', () => {
    expect(resolveMonthlyCostCacheTtlSeconds('3600.9')).toBe(3600);
  });

  it('caps excessively high values', () => {
    expect(resolveMonthlyCostCacheTtlSeconds('999999999')).toBe(
      MAX_MONTHLY_COST_CACHE_TTL_SECONDS
    );
  });
});

describe('runMonthlyCostAggregation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:34:56.000Z'));
    mockIterateGatewayLogs.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is disabled when AI_GATEWAY_ID is absent', async () => {
    const kv = createMockKV();

    const result = await runMonthlyCostAggregation(makeEnv({
      AI_GATEWAY_ID: undefined,
      KV: kv,
    }));

    expect(result).toEqual({ enabled: false, usersUpdated: 0, totalEntries: 0, errors: 0 });
    expect(mockIterateGatewayLogs).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('aggregates per-user costs and writes current-month keys with a safe TTL', async () => {
    const kv = createMockKV();
    mockIterateGatewayLogs.mockImplementation(async (
      _env: Env,
      _gatewayId: string,
      _startDate: string,
      visitor: (entry: AIGatewayLogEntry) => void
    ) => {
      visitor(makeGatewayEntry({ id: 'entry-1', cost: 0.1, metadata: { userId: 'user-a' } }));
      visitor(makeGatewayEntry({ id: 'entry-2', cost: 0.25, metadata: { userId: 'user-a' } }));
      visitor(makeGatewayEntry({ id: 'entry-3', cost: 0.2, metadata: { userId: 'user-b' } }));
      visitor(makeGatewayEntry({ id: 'entry-4', cost: 9, metadata: null }));
    });

    const result = await runMonthlyCostAggregation(makeEnv({
      KV: kv,
      AI_MONTHLY_COST_CACHE_TTL_SECONDS: '3600.9',
    }));

    expect(result).toEqual({ enabled: true, usersUpdated: 2, totalEntries: 4, errors: 0 });
    expect(kv._store.get('ai-monthly-cost:user-a:2026-06')).toBe('0.350000');
    expect(kv._store.get('ai-monthly-cost:user-b:2026-06')).toBe('0.200000');
    expect(kv._ttlByKey.get('ai-monthly-cost:user-a:2026-06')).toBe(3600);
    expect(kv._ttlByKey.get('ai-monthly-cost:user-b:2026-06')).toBe(3600);
    expect(mockIterateGatewayLogs).toHaveBeenCalledWith(
      expect.objectContaining({ KV: kv }),
      'gateway-1',
      '2026-06-01T00:00:00.000Z',
      expect.any(Function),
      {
        defaultMaxPages: 200,
        maxPagesHardCap: 500,
        maxPagesEnvValue: undefined,
      }
    );
  });

  it('falls back to the default TTL for invalid negative configuration', async () => {
    const kv = createMockKV();
    mockIterateGatewayLogs.mockImplementation(async (
      _env: Env,
      _gatewayId: string,
      _startDate: string,
      visitor: (entry: AIGatewayLogEntry) => void
    ) => {
      visitor(makeGatewayEntry({ metadata: { userId: 'user-a' } }));
    });

    const result = await runMonthlyCostAggregation(makeEnv({
      KV: kv,
      AI_MONTHLY_COST_CACHE_TTL_SECONDS: '-1',
    }));

    expect(result.errors).toBe(0);
    expect(kv._ttlByKey.get('ai-monthly-cost:user-a:2026-06')).toBe(
      DEFAULT_AI_MONTHLY_COST_CACHE_TTL_SECONDS
    );
  });

  it('caps excessively high TTL configuration before writing to KV', async () => {
    const kv = createMockKV();
    mockIterateGatewayLogs.mockImplementation(async (
      _env: Env,
      _gatewayId: string,
      _startDate: string,
      visitor: (entry: AIGatewayLogEntry) => void
    ) => {
      visitor(makeGatewayEntry({ metadata: { userId: 'user-a' } }));
    });

    const result = await runMonthlyCostAggregation(makeEnv({
      KV: kv,
      AI_MONTHLY_COST_CACHE_TTL_SECONDS: '999999999',
    }));

    expect(result.errors).toBe(0);
    expect(kv._ttlByKey.get('ai-monthly-cost:user-a:2026-06')).toBe(
      MAX_MONTHLY_COST_CACHE_TTL_SECONDS
    );
  });

  it('returns an error and skips KV writes when Gateway iteration fails', async () => {
    const kv = createMockKV();
    mockIterateGatewayLogs.mockRejectedValue(new Error('Gateway unavailable'));

    const result = await runMonthlyCostAggregation(makeEnv({ KV: kv }));

    expect(result).toEqual({ enabled: true, usersUpdated: 0, totalEntries: 0, errors: 1 });
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('counts per-user KV write failures without stopping other users', async () => {
    const failingKey = 'ai-monthly-cost:user-a:2026-06';
    const kv = createMockKV(new Set([failingKey]));
    mockIterateGatewayLogs.mockImplementation(async (
      _env: Env,
      _gatewayId: string,
      _startDate: string,
      visitor: (entry: AIGatewayLogEntry) => void
    ) => {
      visitor(makeGatewayEntry({ id: 'entry-1', cost: 0.1, metadata: { userId: 'user-a' } }));
      visitor(makeGatewayEntry({ id: 'entry-2', cost: 0.2, metadata: { userId: 'user-b' } }));
    });

    const result = await runMonthlyCostAggregation(makeEnv({ KV: kv }));

    expect(result).toEqual({ enabled: true, usersUpdated: 1, totalEntries: 2, errors: 1 });
    expect(kv._store.has(failingKey)).toBe(false);
    expect(kv._store.get('ai-monthly-cost:user-b:2026-06')).toBe('0.200000');
  });
});
