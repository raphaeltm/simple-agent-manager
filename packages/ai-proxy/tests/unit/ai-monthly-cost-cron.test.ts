import { DEFAULT_AI_MONTHLY_COST_CACHE_TTL_SECONDS } from '@simple-agent-manager/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseGatewayMonthlyCost } from '../../src/ai-cost-estimate';
import type { AIGatewayLogEntry } from '../../src/ai-gateway-logs';
import type { AiProxyEnv as Env } from '../../src/env';

const mockIterateGatewayLogs = vi.fn();

vi.mock('../../src/ai-gateway-logs', async () => {
  const actual = await vi.importActual<typeof import('../../src/ai-gateway-logs')>(
    '../../src/ai-gateway-logs'
  );
  return {
    ...actual,
    iterateGatewayLogs: (...args: unknown[]) => mockIterateGatewayLogs(...args),
  };
});

vi.mock('@simple-agent-manager/worker-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@simple-agent-manager/worker-core')>()),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const {
  MAX_MONTHLY_COST_CACHE_TTL_SECONDS,
  resolveMonthlyCostCacheTtlSeconds,
  runMonthlyCostAggregation: runMonthlyCostAggregationWithPorts,
} = await import('../../src/ai-monthly-cost-cron');

/** The worker binds these from admin settings; the cron passes them through to log reads. */
const TEST_PORTS = {
  externalReadTimeoutMs: async () => 15_000,
  monthlyCostCeilingUsd: async () => 0,
};
const runMonthlyCostAggregation = (env: Env) => runMonthlyCostAggregationWithPorts(env, TEST_PORTS);

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
    list: vi.fn(async (options?: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((name) => name.startsWith(options?.prefix ?? ''))
        .map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null, cacheStatus: null })),
  } as unknown as KVNamespace & {
    _store: Map<string, string>;
    _ttlByKey: Map<string, number | undefined>;
  };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI_GATEWAY_ID: 'gateway-1',
    CF_ACCOUNT_ID: 'account-1',
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
    expect(resolveMonthlyCostCacheTtlSeconds('999999999')).toBe(MAX_MONTHLY_COST_CACHE_TTL_SECONDS);
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

    const result = await runMonthlyCostAggregation(
      makeEnv({
        AI_GATEWAY_ID: undefined,
        KV: kv,
      })
    );

    expect(result).toEqual({ enabled: false, usersUpdated: 0, totalEntries: 0, errors: 0 });
    expect(mockIterateGatewayLogs).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('aggregates per-user costs and writes current-month keys with a safe TTL', async () => {
    const kv = createMockKV();
    mockIterateGatewayLogs.mockImplementation(
      async (
        _env: Env,
        _ports: unknown,
        _gatewayId: string,
        _startDate: string,
        visitor: (entry: AIGatewayLogEntry) => void
      ) => {
        visitor(makeGatewayEntry({ id: 'entry-1', cost: 0.1, metadata: { userId: 'user-a' } }));
        visitor(makeGatewayEntry({ id: 'entry-2', cost: 0.25, metadata: { userId: 'user-a' } }));
        visitor(makeGatewayEntry({ id: 'entry-3', cost: 0.2, metadata: { userId: 'user-b' } }));
        visitor(makeGatewayEntry({ id: 'entry-4', cost: 9, metadata: null }));
        return { truncated: false };
      }
    );

    const result = await runMonthlyCostAggregation(
      makeEnv({
        KV: kv,
        AI_MONTHLY_COST_CACHE_TTL_SECONDS: '3600.9',
      })
    );

    expect(result).toEqual({ enabled: true, usersUpdated: 2, totalEntries: 4, errors: 0 });
    expect(
      parseGatewayMonthlyCost(kv._store.get('ai-monthly-cost:user-a:2026-06') ?? null)
    ).toEqual({
      costUsd: 0.35,
      asOfMs: expect.any(Number),
      truncated: false,
      // A complete read settles every log older than the default 10-minute lag margin.
      settled: { usd: 0.35, beforeMs: Date.parse('2026-06-15T12:24:56.000Z') },
    });
    expect(
      parseGatewayMonthlyCost(kv._store.get('ai-monthly-cost:user-b:2026-06') ?? null)
    ).toMatchObject({
      costUsd: 0.2,
      asOfMs: expect.any(Number),
      truncated: false,
    });
    expect(kv._ttlByKey.get('ai-monthly-cost:user-a:2026-06')).toBe(3600);
    expect(kv._ttlByKey.get('ai-monthly-cost:user-b:2026-06')).toBe(3600);
    expect(mockIterateGatewayLogs).toHaveBeenCalledWith(
      expect.objectContaining({ KV: kv }),
      TEST_PORTS,
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
    mockIterateGatewayLogs.mockImplementation(
      async (
        _env: Env,
        _ports: unknown,
        _gatewayId: string,
        _startDate: string,
        visitor: (entry: AIGatewayLogEntry) => void
      ) => {
        visitor(makeGatewayEntry({ metadata: { userId: 'user-a' } }));
        return { truncated: false };
      }
    );

    const result = await runMonthlyCostAggregation(
      makeEnv({
        KV: kv,
        AI_MONTHLY_COST_CACHE_TTL_SECONDS: '-1',
      })
    );

    expect(result.errors).toBe(0);
    expect(kv._ttlByKey.get('ai-monthly-cost:user-a:2026-06')).toBe(
      DEFAULT_AI_MONTHLY_COST_CACHE_TTL_SECONDS
    );
  });

  it('caps excessively high TTL configuration before writing to KV', async () => {
    const kv = createMockKV();
    mockIterateGatewayLogs.mockImplementation(
      async (
        _env: Env,
        _ports: unknown,
        _gatewayId: string,
        _startDate: string,
        visitor: (entry: AIGatewayLogEntry) => void
      ) => {
        visitor(makeGatewayEntry({ metadata: { userId: 'user-a' } }));
        return { truncated: false };
      }
    );

    const result = await runMonthlyCostAggregation(
      makeEnv({
        KV: kv,
        AI_MONTHLY_COST_CACHE_TTL_SECONDS: '999999999',
      })
    );

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
    mockIterateGatewayLogs.mockImplementation(
      async (
        _env: Env,
        _ports: unknown,
        _gatewayId: string,
        _startDate: string,
        visitor: (entry: AIGatewayLogEntry) => void
      ) => {
        visitor(makeGatewayEntry({ id: 'entry-1', cost: 0.1, metadata: { userId: 'user-a' } }));
        visitor(makeGatewayEntry({ id: 'entry-2', cost: 0.2, metadata: { userId: 'user-b' } }));
        return { truncated: false };
      }
    );

    const result = await runMonthlyCostAggregation(makeEnv({ KV: kv }));

    expect(result).toEqual({ enabled: true, usersUpdated: 1, totalEntries: 2, errors: 1 });
    expect(kv._store.has(failingKey)).toBe(false);
    expect(
      parseGatewayMonthlyCost(kv._store.get('ai-monthly-cost:user-b:2026-06') ?? null)
    ).toMatchObject({
      costUsd: 0.2,
      asOfMs: expect.any(Number),
      truncated: false,
    });
  });

  describe('a read past the page cap', () => {
    const NOW = Date.parse('2026-06-15T12:34:56.000Z');
    const MIN = 60_000;
    const at = (ms: number) => new Date(ms).toISOString();
    const key = (user: string) => `ai-monthly-cost:${user}:2026-06`;
    /** Serve `entries` as the read, newest first, reporting the page cap as reached. */
    const serve = (entries: AIGatewayLogEntry[], truncated = true) =>
      mockIterateGatewayLogs.mockImplementation(
        async (
          _env: Env,
          _ports: unknown,
          _gatewayId: string,
          _startDate: string,
          visitor: (entry: AIGatewayLogEntry) => void
        ) => {
          for (const entry of entries) visitor(entry);
          return { truncated };
        }
      );
    const spend = (user: string, createdMs: number, cost: number) =>
      makeGatewayEntry({ cost, created_at: at(createdMs), metadata: { userId: user } });
    const read = (kv: ReturnType<typeof createMockKV>, user: string) =>
      parseGatewayMonthlyCost(kv._store.get(key(user)) ?? null);

    it('adds spend that pushed older logs out of the window (Codex P1 on #3015)', async () => {
      const kv = createMockKV();
      const boundary = NOW - 70 * MIN;
      // Previous complete read: $100, all of it settled before `boundary`.
      kv._store.set(
        key('user-a'),
        JSON.stringify({
          costUsd: 100,
          asOfMs: boundary + 10 * MIN,
          settledUsd: 100,
          settledBeforeMs: boundary,
        })
      );
      // This read is the newest window: $10 of new spend, and $90 of the old logs ($10 of old
      // logs fell out of the window). Its own total is also $100.
      serve([spend('user-a', NOW - 5 * MIN, 10), spend('user-a', boundary - MIN, 90)]);
      await runMonthlyCostAggregation(makeEnv({ KV: kv }));
      expect(read(kv, 'user-a')).toEqual({
        costUsd: 110,
        asOfMs: NOW,
        truncated: false,
        // The $10 is newer than this run's lag margin, so it is not settled yet.
        settled: { usd: 100, beforeMs: NOW - 10 * MIN },
      });
    });

    it('accumulates exactly across consecutive truncated runs', async () => {
      const kv = createMockKV();
      // Run 1, complete: $5 an hour before.
      vi.setSystemTime(NOW - 60 * MIN);
      serve([spend('user-a', NOW - 120 * MIN, 5)], false);
      await runMonthlyCostAggregation(makeEnv({ KV: kv }));
      // Run 2, truncated window that no longer contains the $5 log: $3 new.
      vi.setSystemTime(NOW);
      serve([spend('user-a', NOW - 30 * MIN, 3), spend('user-b', NOW - 80 * MIN, 0)]);
      await runMonthlyCostAggregation(makeEnv({ KV: kv }));
      expect(read(kv, 'user-a')).toMatchObject({ costUsd: 8, truncated: false });
      // Run 3, an hour later: the window moved again, $2 new; the $3 log is still in it.
      vi.setSystemTime(NOW + 60 * MIN);
      serve([spend('user-a', NOW + 20 * MIN, 2), spend('user-a', NOW - 30 * MIN, 3)]);
      await runMonthlyCostAggregation(makeEnv({ KV: kv }));
      expect(read(kv, 'user-a')).toMatchObject({ costUsd: 10, truncated: false });
    });

    it('carries a user with no log in the window forward at their settled spend', async () => {
      const kv = createMockKV();
      kv._store.set(
        key('user-b'),
        JSON.stringify({
          costUsd: 0.3,
          asOfMs: NOW - 60 * MIN,
          settledUsd: 0.3,
          settledBeforeMs: NOW - 70 * MIN,
        })
      );
      kv._store.set('ai-monthly-cost:user-c:1999-01', '9');
      serve([spend('user-a', NOW - 80 * MIN, 1)]);
      await runMonthlyCostAggregation(makeEnv({ KV: kv }));
      // All of user-b's spend is in logs older than this window, which reaches back past their
      // boundary: the total is their settled spend, still exact.
      expect(read(kv, 'user-b')).toMatchObject({ costUsd: 0.3, truncated: false });
      expect(kv._store.get('ai-monthly-cost:user-c:1999-01')).toBe('9');
    });

    it('marks a lower bound when the window does not reach the previous boundary', async () => {
      const kv = createMockKV();
      kv._store.set(
        key('user-a'),
        JSON.stringify({
          costUsd: 4,
          asOfMs: NOW - 60 * MIN,
          settledUsd: 4,
          settledBeforeMs: NOW - 70 * MIN,
        })
      );
      serve([spend('user-a', NOW - 5 * MIN, 1), spend('user-a', NOW - 50 * MIN, 2)]);
      await runMonthlyCostAggregation(makeEnv({ KV: kv }));
      expect(read(kv, 'user-a')).toEqual({
        costUsd: 7,
        asOfMs: NOW,
        truncated: true,
        settled: { usd: 6, beforeMs: NOW - 10 * MIN },
      });
    });

    it('treats a window that starts exactly at the boundary as a gap', async () => {
      const kv = createMockKV();
      const boundary = NOW - 70 * MIN;
      kv._store.set(
        key('user-a'),
        JSON.stringify({
          costUsd: 4,
          asOfMs: NOW - 60 * MIN,
          settledUsd: 4,
          settledBeforeMs: boundary,
        })
      );
      // Logs sharing the oldest timestamp may continue on the page the cap cut off.
      serve([spend('user-a', boundary, 1)]);
      await runMonthlyCostAggregation(makeEnv({ KV: kv }));
      expect(read(kv, 'user-a')).toMatchObject({ costUsd: 5, truncated: true });
    });

    it('keeps a lower bound flagged as it chains', async () => {
      const kv = createMockKV();
      kv._store.set(
        key('user-a'),
        JSON.stringify({
          costUsd: 4,
          asOfMs: NOW - 60 * MIN,
          truncated: true,
          settledUsd: 4,
          settledBeforeMs: NOW - 70 * MIN,
        })
      );
      // The window covers everything since the boundary, but the base itself was low.
      serve([spend('user-a', NOW - 5 * MIN, 1), spend('user-a', NOW - 80 * MIN, 1)]);
      await runMonthlyCostAggregation(makeEnv({ KV: kv }));
      expect(read(kv, 'user-a')).toMatchObject({ costUsd: 5, truncated: true });
    });

    it('never moves a settled boundary back when the lag margin grows', async () => {
      const kv = createMockKV();
      const boundary = NOW - 5 * MIN;
      // Settled with a 0-second margin: the $1 log at NOW - 7 min is in the $4.
      kv._store.set(
        key('user-a'),
        JSON.stringify({ costUsd: 4, asOfMs: boundary, settledUsd: 4, settledBeforeMs: boundary })
      );
      serve([spend('user-a', NOW - 7 * MIN, 1), spend('user-b', NOW - 30 * MIN, 1)]);
      await runMonthlyCostAggregation(makeEnv({ KV: kv })); // default 10-minute margin
      expect(read(kv, 'user-a')).toMatchObject({
        costUsd: 4,
        settled: { usd: 4, beforeMs: boundary },
      });
    });

    it('falls back to the larger total, as a lower bound, without a settled part', async () => {
      const kv = createMockKV();
      kv._store.set(key('user-a'), '{"costUsd":0.5,"asOfMs":1}');
      kv._store.set(key('user-b'), '0.300000');
      serve([spend('user-a', NOW - 5 * MIN, 0.1)]);
      await runMonthlyCostAggregation(makeEnv({ KV: kv }));
      expect(read(kv, 'user-a')).toEqual({ costUsd: 0.5, asOfMs: NOW, truncated: true });
      expect(read(kv, 'user-b')).toEqual({ costUsd: 0.3, asOfMs: NOW, truncated: true });
    });

    it('counts a log with an unparseable time in the total but never settles it', async () => {
      const kv = createMockKV();
      serve(
        [
          spend('user-a', NOW - 60 * MIN, 1),
          makeGatewayEntry({ cost: 2, created_at: 'garbage', metadata: { userId: 'user-a' } }),
        ],
        false
      );
      await runMonthlyCostAggregation(makeEnv({ KV: kv }));
      expect(read(kv, 'user-a')).toMatchObject({ costUsd: 3, settled: { usd: 1 } });
    });

    it('settles by the admin lag margin', async () => {
      const kv = createMockKV();
      serve([spend('user-a', NOW - 20 * MIN, 1)], false);
      await runMonthlyCostAggregationWithPorts(makeEnv({ KV: kv }), {
        ...TEST_PORTS,
        costEstimateGatewayLagSeconds: async () => 30 * 60,
      });
      expect(read(kv, 'user-a')).toMatchObject({
        costUsd: 1,
        settled: { usd: 0, beforeMs: NOW - 30 * MIN },
      });
    });
  });
});
