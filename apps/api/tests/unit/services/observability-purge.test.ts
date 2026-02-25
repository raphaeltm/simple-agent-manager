import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../../src/index';

// Use vi.hoisted() so mock functions are available when vi.mock factories run
const {
  mockDelete,
  mockSelect,
  mockSelectFrom,
} = vi.hoisted(() => {
  const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
  const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });

  // The purge function calls:
  //   1. drizzle.select({ count }).from(table) — awaits directly (no .where())
  //   2. drizzle.select({ id }).from(table).orderBy().limit() — chain
  // We need mockSelectFrom to support both patterns.
  const mockSelectFrom = vi.fn();
  const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });

  return { mockDelete, mockSelect, mockSelectFrom };
});

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    select: mockSelect,
    delete: mockDelete,
  }),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ type: 'eq', val })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  gte: vi.fn((_col: unknown, val: unknown) => ({ type: 'gte', val })),
  lte: vi.fn((_col: unknown, val: unknown) => ({ type: 'lte', val })),
  like: vi.fn((_col: unknown, val: unknown) => ({ type: 'like', val })),
  desc: vi.fn((col: unknown) => ({ type: 'desc', col })),
  count: vi.fn(() => 'count_agg'),
  sql: { raw: vi.fn() },
  or: vi.fn((...args: unknown[]) => ({ type: 'or', args })),
}));

vi.mock('../../../src/db/observability-schema', () => ({
  platformErrors: {
    id: 'id',
    source: 'source',
    level: 'level',
    message: 'message',
    timestamp: 'timestamp',
    createdAt: 'created_at',
  },
}));

vi.mock('../../../src/db/schema', () => ({
  nodes: { id: 'id', status: 'status' },
  workspaces: { id: 'id', status: 'status' },
  tasks: { id: 'id', status: 'status' },
}));

import { purgeExpiredErrors } from '../../../src/services/observability';

/**
 * Helper: create a thenable that also has chainable query methods.
 * Used to mock drizzle's `.from()` which can be both awaited directly
 * or chained with .where()/.orderBy()/.limit().
 */
function createThenableResult(value: unknown[]) {
  const result = {
    then: (resolve: (val: unknown) => void) => Promise.resolve(value).then(resolve),
    where: vi.fn().mockReturnValue({
      then: (resolve: (val: unknown) => void) => Promise.resolve(value).then(resolve),
    }),
    orderBy: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(value),
    }),
  };
  return result;
}

describe('Observability Purge', () => {
  const mockDb = {} as D1Database;

  function createEnv(overrides: Partial<Env> = {}): Env {
    return { ...overrides } as Env;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delete rows older than retention days', async () => {
    // Count query returns 50 (under 100k max)
    mockSelectFrom.mockReturnValueOnce(createThenableResult([{ count: 50 }]));

    const env = createEnv({ OBSERVABILITY_ERROR_RETENTION_DAYS: '7' });
    await purgeExpiredErrors(mockDb, env);

    expect(mockDelete).toHaveBeenCalled();
  });

  it('should use default 30-day retention when env not set', async () => {
    mockSelectFrom.mockReturnValueOnce(createThenableResult([{ count: 50 }]));

    const env = createEnv();
    await purgeExpiredErrors(mockDb, env);

    expect(mockDelete).toHaveBeenCalled();
  });

  it('should delete excess rows when count exceeds max', async () => {
    // Count returns 150,000 (over 100,000 max)
    mockSelectFrom.mockReturnValueOnce(createThenableResult([{ count: 150_000 }]));

    // For excess rows query: select({ id }).from(table).orderBy().limit()
    const excessRows = Array.from({ length: 50_000 }, (_, i) => ({ id: `id-${i}` }));
    mockSelectFrom.mockReturnValueOnce({
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(excessRows),
      }),
    });

    const env = createEnv();
    const result = await purgeExpiredErrors(mockDb, env);

    expect(result.deletedByCount).toBe(50_000);
  });

  it('should not delete by count when under max', async () => {
    // Count returns 500 (under 100,000 max)
    mockSelectFrom.mockReturnValueOnce(createThenableResult([{ count: 500 }]));

    const env = createEnv();
    const result = await purgeExpiredErrors(mockDb, env);

    expect(result.deletedByCount).toBe(0);
  });

  it('should respect configurable max rows from env', async () => {
    // Count returns 60 (over max of 50)
    mockSelectFrom.mockReturnValueOnce(createThenableResult([{ count: 60 }]));

    // Return 10 excess IDs
    const excessRows = Array.from({ length: 10 }, (_, i) => ({ id: `id-${i}` }));
    mockSelectFrom.mockReturnValueOnce({
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(excessRows),
      }),
    });

    const env = createEnv({ OBSERVABILITY_ERROR_MAX_ROWS: '50' });
    const result = await purgeExpiredErrors(mockDb, env);

    expect(result.deletedByCount).toBe(10);
  });

  it('should return purge result with both counters', async () => {
    mockSelectFrom.mockReturnValueOnce(createThenableResult([{ count: 10 }]));

    const env = createEnv();
    const result = await purgeExpiredErrors(mockDb, env);

    expect(result).toHaveProperty('deletedByAge');
    expect(result).toHaveProperty('deletedByCount');
    expect(typeof result.deletedByAge).toBe('number');
    expect(typeof result.deletedByCount).toBe('number');
  });
});
