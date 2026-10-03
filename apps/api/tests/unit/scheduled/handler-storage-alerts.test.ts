import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The scheduled entrypoint, with the REAL sweep isolator for the two steps under test: the
 * archive drain (made to fail) and the storage alerts step that must still run after it.
 * Every other step is skipped so the test stays about this wiring.
 */
const { alertsMock, archiveMock, logInfoMock, notifyFailedSweepsMock } = vi.hoisted(() => ({
  alertsMock: vi.fn(),
  archiveMock: vi.fn(),
  logInfoMock: vi.fn(),
  notifyFailedSweepsMock: vi.fn(),
}));
const STEPS_UNDER_TEST = new Set(['project_data_archive_sharding', 'project_data_storage_alerts']);
const isolatedSteps: string[] = [];

vi.mock('../../../src/services/operational-kill-switch', () => ({
  isOperationalLoopEnabled: vi.fn(async () => true),
}));
vi.mock('../../../src/scheduled/platform-feedback-hourly', () => ({
  isHourlyPlatformMaintenanceCron: vi.fn(() => false),
  scheduleHourlyPlatformMaintenance: vi.fn(() => false),
}));
vi.mock('../../../src/scheduled/sweep-isolation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/scheduled/sweep-isolation')>();
  return {
    ...actual,
    createSweepIsolator: (env: Parameters<typeof actual.createSweepIsolator>[0]) => {
      const real = actual.createSweepIsolator(env);
      return {
        isolate: async <T>(name: string, fn: () => Promise<T>) => {
          isolatedSteps.push(name);
          return STEPS_UNDER_TEST.has(name) ? real.isolate(name, fn) : undefined;
        },
        failedSweeps: () => real.failedSweeps(),
      };
    },
  };
});
vi.mock('../../../src/scheduled/project-data-archive-sharding', () => ({
  runProjectDataArchiveSharding: archiveMock,
}));
vi.mock('../../../src/scheduled/project-data-storage-alerts', () => ({
  runProjectDataStorageAlerts: alertsMock,
}));
vi.mock('../../../src/scheduled/failed-sweep-notifications', () => ({
  notifyFailedSweeps: notifyFailedSweepsMock,
}));
vi.mock('../../../src/services/observability', () => ({ persistError: vi.fn() }));
vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock('../../../src/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/logger')>()),
  log: { info: logInfoMock, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { scheduled } = await import('../../../src/scheduled/handler');

const controller = { cron: '*/5 * * * *' } as ScheduledController;
const context = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const env = { DATABASE: {}, OBSERVABILITY_DATABASE: {}, KV: {} } as never;

describe('scheduled storage alerts step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isolatedSteps.length = 0;
    notifyFailedSweepsMock.mockResolvedValue({ notifiedSweeps: 1, notificationsSent: 2 });
    alertsMock.mockResolvedValue({
      candidates: 1,
      alerts: 1,
      notificationsSent: 2,
      throttled: 0,
      deliveryFailures: 0,
    });
  });

  it('runs right after the archive drain, even when the drain step fails', async () => {
    archiveMock.mockRejectedValue(new Error('archive coordinator exploded'));

    await scheduled(controller, env, context);

    expect(alertsMock).toHaveBeenCalledTimes(1);
    expect(isolatedSteps.indexOf('project_data_storage_alerts')).toBe(
      isolatedSteps.indexOf('project_data_archive_sharding') + 1
    );
    expect(notifyFailedSweepsMock).toHaveBeenCalledWith(env, ['project_data_archive_sharding']);
    expect(logInfoMock).toHaveBeenCalledWith(
      'cron.completed',
      expect.objectContaining({
        projectDataStorageAlertCandidates: 1,
        projectDataStorageAlertsSent: 2,
        projectDataStorageAlertsThrottled: 0,
        projectDataStorageAlertDeliveryFailures: 0,
      })
    );
  });

  it('reports its own failure as a failed sweep without stopping the cron', async () => {
    archiveMock.mockResolvedValue({ enabled: true, skipped: true });
    alertsMock.mockRejectedValue(new Error('D1 unavailable'));

    await scheduled(controller, env, context);

    expect(notifyFailedSweepsMock).toHaveBeenCalledWith(env, ['project_data_storage_alerts']);
    expect(logInfoMock).toHaveBeenCalledWith('cron.completed', expect.anything());
  });
});
