/**
 * The scheduled `gcp_price_table` step: a refresh where every credential failed returns
 * `failed` rather than throwing, so the handler must turn it into a failed sweep when any
 * failure was a fault, or operators are never told. Driven through the real `scheduled()` handler and the real sweep isolator;
 * every other sweep is stubbed out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { notifyFailedSweepsMock, refreshMock } = vi.hoisted(() => ({
  notifyFailedSweepsMock: vi.fn(async () => ({ notifiedSweeps: 0, notificationsSent: 0 })),
  refreshMock: vi.fn(),
}));

vi.mock('../../../src/services/operational-kill-switch', () => ({
  isOperationalLoopEnabled: vi.fn(async () => true),
}));
vi.mock('../../../src/scheduled/platform-feedback-hourly', () => ({
  isHourlyPlatformMaintenanceCron: vi.fn(() => false),
  scheduleHourlyPlatformMaintenance: vi.fn(() => false),
}));
vi.mock('../../../src/scheduled/sweep-isolation', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/scheduled/sweep-isolation')>();
  return {
    createSweepIsolator: vi.fn((env: Parameters<typeof real.createSweepIsolator>[0]) => {
      const isolator = real.createSweepIsolator(env);
      return {
        ...isolator,
        // Only the step under test runs; every other sweep reports "no data this tick".
        isolate: (name: string, fn: () => Promise<unknown>) =>
          name === 'gcp_price_table' ? isolator.isolate(name, fn) : Promise.resolve(undefined),
      };
    }),
  };
});
vi.mock('../../../src/services/observability', () => ({ persistError: vi.fn() }));
vi.mock('../../../src/services/gcp-price-table', () => ({
  refreshGcpPriceTableIfDue: refreshMock,
}));
vi.mock('../../../src/scheduled/failed-sweep-notifications', () => ({
  notifyFailedSweeps: notifyFailedSweepsMock,
}));
vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock('../../../src/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/logger')>()),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { scheduled } = await import('../../../src/scheduled/handler');

const controller = { cron: '*/5 * * * *' } as ScheduledController;
const context = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const env = { DATABASE: {}, OBSERVABILITY_DATABASE: {}, KV: {} } as never;

describe('scheduled gcp_price_table step', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports a refresh where every credential failed and one was a fault as a failed sweep', async () => {
    refreshMock.mockResolvedValue({ status: 'failed', attempts: 3, faults: 1 });

    await scheduled(controller, env, context);

    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(notifyFailedSweepsMock).toHaveBeenCalledWith(env, ['gcp_price_table']);
  });

  it.each([
    { status: 'backoff', retryAt: '2026-11-07T13:00:00.000Z' },
    { status: 'fresh', fetchedAt: '2026-11-07T11:00:00.000Z' },
    { status: 'no-credential' },
    // Every credential failed for an owner-fixable reason (Cloud Billing off in their project);
    // the end-to-end case is in gcp-price-table-sweep-vertical.test.ts.
    { status: 'failed', attempts: 2, faults: 0 },
  ])('does not report $status as a failure', async (result) => {
    refreshMock.mockResolvedValue(result);

    await scheduled(controller, env, context);

    // Liveness: the step ran, so an empty failure list is its verdict, not a skipped step.
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(notifyFailedSweepsMock).toHaveBeenCalledWith(env, []);
  });
});
