import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted() so mock functions are available when vi.mock factories run
//
// Drizzle query chains are thenable — `await select().from().where().orderBy()`
// calls `.then()` on the result of `orderBy()`. We create thenable objects that
// resolve to an array when awaited.
const { mockSelectFrom, mockSelect } = vi.hoisted(() => {
  function thenable(data: unknown[] = []) {
    return {
      then: (resolve: (v: unknown[]) => void) => resolve(data),
      all: vi.fn().mockResolvedValue(data),
    };
  }

  const mockSelectOrderBy = vi.fn().mockReturnValue(thenable([]));
  const mockSelectWhere = vi.fn().mockReturnValue({
    orderBy: mockSelectOrderBy,
    ...thenable([]),
  });
  const mockSelectFrom = vi.fn().mockReturnValue({
    where: mockSelectWhere,
    orderBy: mockSelectOrderBy,
    ...thenable([]),
  });
  const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });

  return { mockSelectFrom, mockSelect, mockSelectWhere, mockSelectOrderBy };
});

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({
    select: mockSelect,
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
    stack: 'stack',
    context: 'context',
    userId: 'user_id',
    nodeId: 'node_id',
    workspaceId: 'workspace_id',
    ipAddress: 'ip_address',
    userAgent: 'user_agent',
    timestamp: 'timestamp',
    createdAt: 'created_at',
  },
}));

vi.mock('../../../src/db/schema', () => ({
  nodes: { id: 'id', status: 'status' },
  workspaces: { id: 'id', status: 'status' },
  tasks: { id: 'id', status: 'status' },
}));

import { getErrorTrends } from '../../../src/services/observability';

describe('getErrorTrends()', () => {
  const mockDb = {} as D1Database;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty buckets when no errors exist', async () => {
    const result = await getErrorTrends(mockDb, '1h');

    expect(result.range).toBe('1h');
    expect(result.interval).toBe('5m');
    expect(result.buckets.length).toBeGreaterThan(0);
    // All buckets should have zero totals
    for (const bucket of result.buckets) {
      expect(bucket.total).toBe(0);
      expect(bucket.bySource.client).toBe(0);
      expect(bucket.bySource['vm-agent']).toBe(0);
      expect(bucket.bySource.api).toBe(0);
    }
  });

  it('should use 5m interval for 1h range', async () => {
    const result = await getErrorTrends(mockDb, '1h');

    expect(result.interval).toBe('5m');
    // 1h / 5m = 12 buckets
    expect(result.buckets).toHaveLength(12);
  });

  it('should use 1h interval for 24h range', async () => {
    const result = await getErrorTrends(mockDb, '24h');

    expect(result.interval).toBe('1h');
    // 24h / 1h = 24 buckets
    expect(result.buckets).toHaveLength(24);
  });

  it('should use 1d interval for 7d range', async () => {
    const result = await getErrorTrends(mockDb, '7d');

    expect(result.interval).toBe('1d');
    expect(result.buckets).toHaveLength(7);
  });

  it('should use 1d interval for 30d range', async () => {
    const result = await getErrorTrends(mockDb, '30d');

    expect(result.interval).toBe('1d');
    expect(result.buckets).toHaveLength(30);
  });

  it('should default to 24h range for unknown ranges', async () => {
    const result = await getErrorTrends(mockDb, 'invalid');

    expect(result.interval).toBe('1h');
    expect(result.buckets).toHaveLength(24);
  });

  it('should correctly bucket errors by time', async () => {
    const now = Date.now();
    const fiveMinMs = 5 * 60 * 1000;
    const oneHourAgo = now - 60 * 60 * 1000;

    // Place errors in specific buckets
    const mockRows = [
      { source: 'client', timestamp: oneHourAgo + fiveMinMs * 2 + 1000 }, // bucket 2
      { source: 'client', timestamp: oneHourAgo + fiveMinMs * 2 + 2000 }, // bucket 2
      { source: 'api', timestamp: oneHourAgo + fiveMinMs * 5 + 1000 },    // bucket 5
    ];

    // Configure mock to return our test rows via thenable
    const mockOrderBy = vi.fn().mockReturnValue({
      then: (resolve: (v: unknown[]) => void) => resolve(mockRows),
    });
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    mockSelectFrom.mockReturnValueOnce({ where: mockWhere });

    const result = await getErrorTrends(mockDb, '1h');

    // Find bucket at index 2 — should have 2 client errors
    expect(result.buckets[2].total).toBe(2);
    expect(result.buckets[2].bySource.client).toBe(2);

    // Find bucket at index 5 — should have 1 api error
    expect(result.buckets[5].total).toBe(1);
    expect(result.buckets[5].bySource.api).toBe(1);

    // Other buckets should be zero
    expect(result.buckets[0].total).toBe(0);
    expect(result.buckets[1].total).toBe(0);
  });

  it('should group by source correctly', async () => {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    const mockRows = [
      { source: 'client', timestamp: oneHourAgo + 1000 },
      { source: 'vm-agent', timestamp: oneHourAgo + 2000 },
      { source: 'api', timestamp: oneHourAgo + 3000 },
      { source: 'api', timestamp: oneHourAgo + 4000 },
    ];

    const mockOrderBy = vi.fn().mockReturnValue({
      then: (resolve: (v: unknown[]) => void) => resolve(mockRows),
    });
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    mockSelectFrom.mockReturnValueOnce({ where: mockWhere });

    const result = await getErrorTrends(mockDb, '1h');

    // All in first bucket (0-5min)
    expect(result.buckets[0].total).toBe(4);
    expect(result.buckets[0].bySource.client).toBe(1);
    expect(result.buckets[0].bySource['vm-agent']).toBe(1);
    expect(result.buckets[0].bySource.api).toBe(2);
  });

  it('should return ISO 8601 timestamps for bucket boundaries', async () => {
    const result = await getErrorTrends(mockDb, '1h');

    for (const bucket of result.buckets) {
      // Should be a valid ISO timestamp
      expect(new Date(bucket.timestamp).toISOString()).toBe(bucket.timestamp);
    }
  });

  it('should have monotonically increasing bucket timestamps', async () => {
    const result = await getErrorTrends(mockDb, '24h');

    for (let i = 1; i < result.buckets.length; i++) {
      const prev = new Date(result.buckets[i - 1].timestamp).getTime();
      const curr = new Date(result.buckets[i].timestamp).getTime();
      expect(curr).toBeGreaterThan(prev);
    }
  });

  it('should initialize all source counts to 0 in empty buckets', async () => {
    const result = await getErrorTrends(mockDb, '1h');

    for (const bucket of result.buckets) {
      expect(bucket.bySource).toHaveProperty('client', 0);
      expect(bucket.bySource).toHaveProperty('vm-agent', 0);
      expect(bucket.bySource).toHaveProperty('api', 0);
    }
  });

  it('should ignore errors with unknown sources', async () => {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    const mockRows = [
      { source: 'client', timestamp: oneHourAgo + 1000 },
      { source: 'unknown-source', timestamp: oneHourAgo + 2000 },
    ];

    const mockOrderBy = vi.fn().mockReturnValue({
      then: (resolve: (v: unknown[]) => void) => resolve(mockRows),
    });
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    mockSelectFrom.mockReturnValueOnce({ where: mockWhere });

    const result = await getErrorTrends(mockDb, '1h');

    // Total counts all rows, but bySource only increments known sources
    expect(result.buckets[0].total).toBe(2);
    expect(result.buckets[0].bySource.client).toBe(1);
    // Unknown source is not tracked in bySource
    expect(result.buckets[0].bySource['unknown-source']).toBeUndefined();
  });
});
