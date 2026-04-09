/**
 * Unit tests for the cron trigger sweep engine.
 *
 * Tests the sweep logic in isolation by mocking the database layer and
 * the submitTriggeredTask bridge function.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Mock modules before importing the module under test
// =============================================================================

const { submitMockFn } = vi.hoisted(() => ({
  submitMockFn: vi.fn(),
}));
vi.mock('../../../src/services/trigger-submit', () => ({
  submitTriggeredTask: submitMockFn,
}));

vi.mock('../../../src/services/trigger-template', () => ({
  renderTemplate: vi.fn().mockReturnValue({ rendered: 'Review PRs for Daily Review', warnings: [] }),
  buildCronContext: vi.fn().mockReturnValue({}),
}));

vi.mock('../../../src/services/cron-utils', () => ({
  cronToNextFire: vi.fn().mockReturnValue('2026-04-10T09:00:00.000Z'),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let ulidCounter = 0;
vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => `ULID${String(++ulidCounter).padStart(6, '0')}`,
}));

// =============================================================================
// DB mock — uses a query result queue (each query shifts the first result)
// =============================================================================

let queryResults: any[][] = [];

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => {
    function makeThenable(resolveData: () => Promise<any[]>): any {
      return {
        where: vi.fn(() => makeThenable(resolveData)),
        orderBy: vi.fn(() => makeThenable(resolveData)),
        limit: vi.fn((n: number) => makeThenable(async () => (await resolveData()).slice(0, n))),
        offset: vi.fn(() => makeThenable(resolveData)),
        then: (resolve: any, reject?: any) => resolveData().then(resolve, reject),
      };
    }

    return {
      select: vi.fn(() => ({
        from: vi.fn(() => makeThenable(() => Promise.resolve(queryResults.shift() || []))),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => Promise.resolve()),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve()),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    };
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ['eq', val]),
  and: vi.fn((...args: unknown[]) => ['and', ...args]),
  count: vi.fn(() => 'count'),
  desc: vi.fn((col: unknown) => col),
  isNotNull: vi.fn((_col: unknown) => ['isNotNull']),
  lte: vi.fn((_col: unknown, val: unknown) => ['lte', val]),
  sql: Object.assign((s: unknown) => s, { raw: (s: unknown) => s }),
}));

// =============================================================================
// Import after mocks
// =============================================================================
import { runCronTriggerSweep } from '../../../src/scheduled/cron-triggers';

// =============================================================================
// Helper: Build a mock trigger row
// =============================================================================
function makeTrigger(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trigger-1',
    projectId: 'project-1',
    userId: 'user-1',
    name: 'Daily Review',
    description: null,
    status: 'active',
    sourceType: 'cron',
    cronExpression: '0 9 * * *',
    cronTimezone: 'UTC',
    skipIfRunning: true,
    promptTemplate: 'Review PRs for {{trigger.name}}',
    agentProfileId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    maxConcurrent: 1,
    lastTriggeredAt: null,
    triggerCount: 0,
    nextFireAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('runCronTriggerSweep', () => {
  beforeEach(() => {
    ulidCounter = 0;
    vi.clearAllMocks();
    queryResults = [];
  });

  it('returns zeros when CRON_SWEEP_ENABLED is false', async () => {
    const env = { CRON_SWEEP_ENABLED: 'false' } as any;
    const stats = await runCronTriggerSweep(env);

    expect(stats).toEqual({ checked: 0, fired: 0, skipped: 0, failed: 0 });
  });

  it('fires a due trigger and returns correct stats', async () => {
    submitMockFn.mockResolvedValueOnce({
      taskId: 'task-123',
      sessionId: 'session-123',
      branchName: 'sam/daily-review-abc123',
    });

    const trigger = makeTrigger();

    // Queue DB results in order of queries made by processTrigger:
    // 1. dueTriggers query (from runCronTriggerSweep)
    // 2. getConsecutiveFailureCount: recent executions (ordered by createdAt desc)
    // 3. skipIfRunning: count of running executions
    // 4. maxConcurrent: count of running executions
    // 5. project name lookup
    // 6. (insert execution — not a select)
    // 7. (update execution — not a select)
    // 8. (update trigger — not a select)
    // 9. (advanceNextFireAt — update, not a select)
    queryResults = [
      [trigger],               // 1. dueTriggers
      [],                       // 2. consecutive failures (none)
      [{ count: 0 }],          // 3. skipIfRunning check
      [{ count: 0 }],          // 4. maxConcurrent check
      [{ name: 'My Project' }], // 5. project name
    ];

    const stats = await runCronTriggerSweep({ DATABASE: {} } as any);

    expect(stats.checked).toBe(1);
    expect(stats.fired).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(stats.failed).toBe(0);

    // Verify submitTriggeredTask was called
    expect(submitMockFn).toHaveBeenCalledTimes(1);
    expect(submitMockFn.mock.calls[0]![1]).toMatchObject({
      triggerId: 'trigger-1',
      projectId: 'project-1',
      triggeredBy: 'cron',
    });
  });
});
