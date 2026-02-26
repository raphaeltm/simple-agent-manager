import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted() so mock functions are available when vi.mock factories run
const {
  mockObsSelectFrom,
  mockObsSelect,
  mockMainSelectFrom,
  mockMainSelect,
} = vi.hoisted(() => {
  // Observability DB mock chain
  const mockObsSelectGet = vi.fn();
  const mockObsSelectWhere = vi.fn().mockReturnValue({ get: mockObsSelectGet });
  const mockObsSelectFrom = vi.fn().mockReturnValue({ where: mockObsSelectWhere, get: mockObsSelectGet });
  const mockObsSelect = vi.fn().mockReturnValue({ from: mockObsSelectFrom });

  // Main DB mock chain
  const mockMainSelectGet = vi.fn();
  const mockMainSelectWhere = vi.fn().mockReturnValue({ get: mockMainSelectGet });
  const mockMainSelectFrom = vi.fn().mockReturnValue({ where: mockMainSelectWhere, get: mockMainSelectGet });
  const mockMainSelect = vi.fn().mockReturnValue({ from: mockMainSelectFrom });

  return {
    mockObsSelectFrom,
    mockObsSelect,
    mockObsSelectGet,
    mockObsSelectWhere,
    mockMainSelectFrom,
    mockMainSelect,
    mockMainSelectGet,
    mockMainSelectWhere,
  };
});

// Track which DB instance was created
let drizzleCallCount = 0;
vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockImplementation(() => {
    drizzleCallCount++;
    // First call is main DB, second call is observability DB
    if (drizzleCallCount % 2 === 1) {
      return { select: mockMainSelect };
    }
    return { select: mockObsSelect };
  }),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ type: 'eq', val })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  gte: vi.fn((_col: unknown, val: unknown) => ({ type: 'gte', val })),
  lte: vi.fn((_col: unknown, val: unknown) => ({ type: 'lte', val })),
  like: vi.fn((_col: unknown, val: unknown) => ({ type: 'like', val })),
  desc: vi.fn((col: unknown) => ({ type: 'desc', col })),
  count: vi.fn(() => 'count_fn'),
  or: vi.fn((...args: unknown[]) => ({ type: 'or', args })),
  sql: Object.assign((..._args: unknown[]) => '', { raw: vi.fn() }),
}));

import { getHealthSummary } from '../../../src/services/observability';

describe('getHealthSummary()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleCallCount = 0;
  });

  it('should return health summary with counts from both databases', async () => {
    // Mock main DB: nodes=3, workspaces=5, tasks=2
    // Mock obs DB: errors=42
    // Promise.all resolves all 4 queries
    const mockMainDb = {} as D1Database;
    const mockObsDb = {} as D1Database;

    // The function uses Promise.all with 4 queries
    // We need the select chain to return results for each query
    const nodeResult = { count: 3 };
    const wsResult = { count: 5 };
    const taskResult = { count: 2 };
    const errorResult = { count: 42 };

    // Each .select().from().where() returns one result
    // Since Promise.all runs all 4, we need 4 different resolutions
    // The mock returns array wrapped (Drizzle select returns array)
    mockMainSelectFrom
      .mockReturnValueOnce({
        where: vi.fn().mockResolvedValue([nodeResult]),
      })
      .mockReturnValueOnce({
        where: vi.fn().mockResolvedValue([wsResult]),
      })
      .mockReturnValueOnce({
        where: vi.fn().mockResolvedValue([taskResult]),
      });

    mockObsSelectFrom.mockReturnValueOnce({
      where: vi.fn().mockResolvedValue([errorResult]),
    });

    const result = await getHealthSummary(mockMainDb, mockObsDb);

    expect(result).toHaveProperty('activeNodes');
    expect(result).toHaveProperty('activeWorkspaces');
    expect(result).toHaveProperty('inProgressTasks');
    expect(result).toHaveProperty('errorCount24h');
    expect(result).toHaveProperty('timestamp');
    // Timestamp should be a valid ISO string
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });

  it('should return zero values when databases have no matching rows', async () => {
    const mockMainDb = {} as D1Database;
    const mockObsDb = {} as D1Database;

    // All queries return count of 0
    mockMainSelectFrom
      .mockReturnValueOnce({
        where: vi.fn().mockResolvedValue([{ count: 0 }]),
      })
      .mockReturnValueOnce({
        where: vi.fn().mockResolvedValue([{ count: 0 }]),
      })
      .mockReturnValueOnce({
        where: vi.fn().mockResolvedValue([{ count: 0 }]),
      });

    mockObsSelectFrom.mockReturnValueOnce({
      where: vi.fn().mockResolvedValue([{ count: 0 }]),
    });

    const result = await getHealthSummary(mockMainDb, mockObsDb);

    expect(result.activeNodes).toBe(0);
    expect(result.activeWorkspaces).toBe(0);
    expect(result.inProgressTasks).toBe(0);
    expect(result.errorCount24h).toBe(0);
  });

  it('should return a valid ISO 8601 timestamp', async () => {
    const mockMainDb = {} as D1Database;
    const mockObsDb = {} as D1Database;

    mockMainSelectFrom
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue([{ count: 0 }]) })
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue([{ count: 0 }]) })
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue([{ count: 0 }]) });

    mockObsSelectFrom.mockReturnValueOnce({
      where: vi.fn().mockResolvedValue([{ count: 0 }]),
    });

    const before = new Date().toISOString();
    const result = await getHealthSummary(mockMainDb, mockObsDb);
    const after = new Date().toISOString();

    expect(result.timestamp >= before).toBe(true);
    expect(result.timestamp <= after).toBe(true);
  });

  it('should query the observability DB for errors in the last 24 hours', async () => {
    const mockMainDb = {} as D1Database;
    const mockObsDb = {} as D1Database;

    const mockWhere = vi.fn().mockResolvedValue([{ count: 10 }]);

    mockMainSelectFrom
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue([{ count: 0 }]) })
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue([{ count: 0 }]) })
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue([{ count: 0 }]) });

    mockObsSelectFrom.mockReturnValueOnce({ where: mockWhere });

    const result = await getHealthSummary(mockMainDb, mockObsDb);

    expect(result.errorCount24h).toBe(10);
    // The where clause was called (verifying it filtered by time)
    expect(mockWhere).toHaveBeenCalledTimes(1);
  });

  it('should handle null count results gracefully', async () => {
    const mockMainDb = {} as D1Database;
    const mockObsDb = {} as D1Database;

    // Return undefined/null count
    mockMainSelectFrom
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue([undefined]) })
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue([undefined]) })
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue([undefined]) });

    mockObsSelectFrom.mockReturnValueOnce({
      where: vi.fn().mockResolvedValue([undefined]),
    });

    const result = await getHealthSummary(mockMainDb, mockObsDb);

    expect(result.activeNodes).toBe(0);
    expect(result.activeWorkspaces).toBe(0);
    expect(result.inProgressTasks).toBe(0);
    expect(result.errorCount24h).toBe(0);
  });
});
