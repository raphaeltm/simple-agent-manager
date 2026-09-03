import { beforeEach, describe, expect, it, vi } from 'vitest';

const { enabledMock, isolateMock, logInfoMock, sessionSleepLifecycleRepairMock, sessionSleepMock } =
  vi.hoisted(() => ({
    enabledMock: vi.fn(),
    isolateMock: vi.fn(async () => undefined),
    logInfoMock: vi.fn(),
    sessionSleepLifecycleRepairMock: vi.fn(),
    sessionSleepMock: vi.fn(),
  }));

vi.mock('../../../src/services/operational-kill-switch', () => ({
  isOperationalLoopEnabled: enabledMock,
}));
vi.mock('../../../src/scheduled/platform-feedback-hourly', () => ({
  isHourlyPlatformMaintenanceCron: vi.fn(() => false),
  scheduleHourlyPlatformMaintenance: vi.fn(() => false),
}));
vi.mock('../../../src/scheduled/sweep-isolation', () => ({
  createSweepIsolator: vi.fn(() => ({ isolate: isolateMock, failedSweeps: () => [] })),
}));
vi.mock('../../../src/scheduled/session-sleep', () => ({
  runSessionSleepSweep: sessionSleepMock,
}));
vi.mock('../../../src/scheduled/session-sleep-lifecycle-repair', () => ({
  runSessionSleepLifecycleRepair: sessionSleepLifecycleRepairMock,
}));
vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock('../../../src/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/logger')>()),
  log: { info: logInfoMock, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { scheduled } = await import('../../../src/scheduled/handler');

const controller = { cron: '*/5 * * * *' } as ScheduledController;
const context = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const env = { DATABASE: {}, OBSERVABILITY_DATABASE: {}, KV: {} } as never;

describe('scheduled operational sweep kill switch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stops every operational sweep while disabled', async () => {
    enabledMock.mockResolvedValue(false);

    await scheduled(controller, env, context);

    expect(isolateMock).not.toHaveBeenCalled();
    expect(logInfoMock).toHaveBeenCalledWith('cron.skipped_disabled', {
      cron: controller.cron,
      type: 'sweep',
      switch: 'cron',
    });
  });

  it('resumes the complete sweep block after re-enable', async () => {
    enabledMock.mockResolvedValue(true);

    await scheduled(controller, env, context);

    expect(isolateMock).toHaveBeenCalled();
    const sweepNames = isolateMock.mock.calls.map(([name]) => name);
    expect(sweepNames).toContain('node_cleanup');
    expect(sweepNames).toContain('session_sleep_lifecycle_repair');
    expect(sweepNames).toContain('deployment_release_retention');
    expect(sweepNames).toContain('session_snapshot_purge');
    expect(sweepNames).toContain('terminal_session_ledger_reconciliation');
    expect(sweepNames).toContain('project_data_storage_relief_preflight');
    expect(sweepNames.indexOf('session_sleep_lifecycle_repair')).toBeLessThan(
      sweepNames.indexOf('node_cleanup')
    );
    expect(sweepNames.indexOf('session_sleep_lifecycle_repair')).toBeLessThan(
      sweepNames.indexOf('terminal_session_ledger_reconciliation')
    );
    expect(sweepNames.indexOf('terminal_session_ledger_reconciliation')).toBeLessThan(
      sweepNames.indexOf('project_data_storage_relief_preflight')
    );
    expect(sweepNames.indexOf('project_data_storage_relief_preflight')).toBeLessThan(
      sweepNames.indexOf('project_data_archive_sharding')
    );
    expect(sweepNames.indexOf('project_data_archive_sharding')).toBeLessThan(
      sweepNames.indexOf('session_sleep')
    );
    expect(sweepNames.indexOf('deployment_release_retention')).toBeLessThan(
      sweepNames.indexOf('compose_artifact_cleanup')
    );
    const sleepLifecycleRepairCallback = isolateMock.mock.calls.find(
      ([name]) => name === 'session_sleep_lifecycle_repair'
    )?.[1];
    expect(sleepLifecycleRepairCallback).toEqual(expect.any(Function));
    await sleepLifecycleRepairCallback?.();
    expect(sessionSleepLifecycleRepairMock).toHaveBeenCalledWith(env, expect.any(Date));
    const sessionSleepCallback = isolateMock.mock.calls.find(
      ([name]) => name === 'session_sleep'
    )?.[1];
    expect(sessionSleepCallback).toEqual(expect.any(Function));
    await sessionSleepCallback?.();
    expect(sessionSleepMock).toHaveBeenCalledWith(env, expect.any(Date), context);
    expect(logInfoMock).toHaveBeenCalledWith(
      'cron.completed',
      expect.objectContaining({ type: 'sweep', failedSweeps: [] })
    );
  });
});
