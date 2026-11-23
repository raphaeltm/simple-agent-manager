import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CAPACITY_POOL_CONTINUATION_CRON } from '../../../src/services/capacity-pool-refresh-defaults';

const {
  capacityPoolContinuationMock,
  capacityPoolReconciliationMock,
  enabledMock,
  isolateMock,
  logInfoMock,
  sessionSleepLifecycleRepairMock,
  sessionSleepMock,
  providerOrphanMock,
  persistErrorMock,
  appRouteDnsMock,
} = vi.hoisted(() => ({
  capacityPoolContinuationMock: vi.fn(),
  capacityPoolReconciliationMock: vi.fn(),
  enabledMock: vi.fn(),
  isolateMock: vi.fn(async () => undefined),
  logInfoMock: vi.fn(),
  sessionSleepLifecycleRepairMock: vi.fn(),
  sessionSleepMock: vi.fn(),
  providerOrphanMock: vi.fn(),
  persistErrorMock: vi.fn().mockResolvedValue(undefined),
  appRouteDnsMock: vi.fn(),
}));

vi.mock('../../../src/services/operational-kill-switch', () => ({
  isOperationalLoopEnabled: enabledMock,
}));
vi.mock('../../../src/scheduled/platform-feedback-hourly', () => ({
  isHourlyPlatformMaintenanceCron: vi.fn(() => false),
  scheduleHourlyPlatformMaintenance: vi.fn(() => false),
}));
vi.mock('../../../src/scheduled/sweep-isolation', () => ({
  createSweepIsolator: vi.fn(() => ({
    isolate: isolateMock,
    failedSweeps: () => [],
    failures: () => [],
  })),
}));
vi.mock('../../../src/scheduled/session-sleep', () => ({
  runSessionSleepSweep: sessionSleepMock,
}));
vi.mock('../../../src/scheduled/session-sleep-lifecycle-repair', () => ({
  runSessionSleepLifecycleRepair: sessionSleepLifecycleRepairMock,
}));
vi.mock('../../../src/scheduled/capacity-pool-reconciliation', () => ({
  runScheduledCapacityPoolReconciliation: capacityPoolReconciliationMock,
}));
vi.mock('../../../src/scheduled/capacity-pool-continuation', () => ({
  runScheduledCapacityPoolContinuations: capacityPoolContinuationMock,
}));
vi.mock('../../../src/scheduled/provider-orphan-reconciliation', () => ({
  runProviderOrphanReconciliation: providerOrphanMock,
}));
vi.mock('../../../src/services/observability', () => ({ persistError: persistErrorMock }));
vi.mock('../../../src/services/app-route-dns-reconciliation', () => ({
  runAppRouteDnsReconciliation: appRouteDnsMock,
}));
vi.mock('../../../src/scheduled/failed-sweep-notifications', () => ({
  notifyFailedSweeps: vi.fn().mockResolvedValue({ notifiedSweeps: 0, notificationsSent: 0 }),
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
  beforeEach(() => {
    vi.clearAllMocks();
    isolateMock.mockImplementation(async () => undefined);
  });

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

  it('applies the same operational brake to the one-minute continuation', async () => {
    enabledMock.mockResolvedValue(false);
    isolateMock.mockImplementation(async (_name, callback) => callback());

    await scheduled({ cron: CAPACITY_POOL_CONTINUATION_CRON } as ScheduledController, env, context);

    expect(enabledMock).toHaveBeenCalledWith(env, 'cron');
    expect(isolateMock.mock.calls.map(([name]) => name)).toEqual(['capacity_pool_continuation']);
    expect(capacityPoolContinuationMock).not.toHaveBeenCalled();
    expect(capacityPoolReconciliationMock).not.toHaveBeenCalled();
    expect(context.waitUntil).not.toHaveBeenCalled();
    expect(logInfoMock).toHaveBeenCalledWith('cron.skipped_disabled', {
      cron: CAPACITY_POOL_CONTINUATION_CRON,
      type: 'capacity-pool-continuation',
      switch: 'cron',
    });
  });

  it('contains a failed one-minute kill-switch read and records the failed tick instead of success', async () => {
    enabledMock.mockRejectedValue(new Error('Kill switch unavailable'));
    isolateMock.mockImplementation(async (_name, callback) => {
      try {
        return await callback();
      } catch {
        return undefined;
      }
    });
    await expect(
      scheduled({ cron: CAPACITY_POOL_CONTINUATION_CRON } as ScheduledController, env, context)
    ).resolves.toBeUndefined();
    expect(capacityPoolContinuationMock).not.toHaveBeenCalled();
    expect(logInfoMock).toHaveBeenCalledWith(
      'cron.completed',
      expect.objectContaining({
        type: 'capacity-pool-continuation',
        resumed: null,
        failed: 1,
      })
    );
  });

  it('reports one-minute continuation outcomes without running unrelated sweeps', async () => {
    enabledMock.mockResolvedValue(true);
    capacityPoolContinuationMock.mockResolvedValue({ resumed: 3, failed: 1 });
    isolateMock.mockImplementation(async (_name, callback) => callback());
    await scheduled({ cron: CAPACITY_POOL_CONTINUATION_CRON } as ScheduledController, env, context);
    expect(logInfoMock).toHaveBeenCalledWith(
      'cron.completed',
      expect.objectContaining({
        type: 'capacity-pool-continuation',
        resumed: 3,
        failed: 1,
      })
    );
    expect(capacityPoolReconciliationMock).not.toHaveBeenCalled();
  });

  it('dispatches only the isolated catalog continuation on the one-minute trigger', async () => {
    enabledMock.mockResolvedValue(true);

    await scheduled({ cron: CAPACITY_POOL_CONTINUATION_CRON } as ScheduledController, env, context);

    expect(isolateMock.mock.calls.map(([name]) => name)).toEqual(['capacity_pool_continuation']);
    const callback = isolateMock.mock.calls[0]?.[1];
    expect(callback).toEqual(expect.any(Function));
    await callback?.();
    expect(capacityPoolContinuationMock).toHaveBeenCalledExactlyOnceWith(env);
    expect(capacityPoolReconciliationMock).not.toHaveBeenCalled();
    expect(sessionSleepMock).not.toHaveBeenCalled();
    expect(sessionSleepLifecycleRepairMock).not.toHaveBeenCalled();
    expect(context.waitUntil).not.toHaveBeenCalled();
  });

  it('resumes the complete sweep block after re-enable', async () => {
    enabledMock.mockResolvedValue(true);

    await scheduled(controller, env, context);

    expect(isolateMock).toHaveBeenCalled();
    const sweepNames = isolateMock.mock.calls.map(([name]) => name);
    expect(sweepNames).not.toContain('capacity_pool_continuation');
    expect(sweepNames).toContain('deployment_publish_jobs');
    expect(sweepNames).toContain('node_cleanup');
    expect(sweepNames).toContain('capacity_pool_reconciliation');
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
      sweepNames.indexOf('project_data_archive_sharding')
    );
    // Archive sharding copies whole sessions between ProjectData objects when its cadence is
    // due; it runs after every lifecycle sweep (session_sleep) so that copy budget
    // cannot push them back (`.claude/rules/47`). Only the relief preflight runs later.
    expect(sweepNames.indexOf('session_sleep')).toBeLessThan(
      sweepNames.indexOf('project_data_archive_sharding')
    );
    expect(sweepNames.indexOf('project_data_archive_sharding')).toBe(sweepNames.length - 2);
    // The relief preflight runs LAST. Its run budget is operator-tuned into the minutes
    // while an emergency plan converges, so anywhere earlier it would push every later
    // lifecycle sweep — session_sleep above all — back by that budget on every tick
    // (`.claude/rules/47`). Pinned as an ordering invariant, not an incidental position.
    expect(sweepNames.indexOf('project_data_storage_relief_preflight')).toBe(sweepNames.length - 1);
    expect(sweepNames.indexOf('session_sleep')).toBeLessThan(
      sweepNames.indexOf('project_data_storage_relief_preflight')
    );
    expect(sweepNames.indexOf('deployment_release_retention')).toBeLessThan(
      sweepNames.indexOf('compose_artifact_cleanup')
    );
    // The dangling app-route DNS sweep runs on every tick, after node teardown has released
    // this tick's nodes (services/app-route-dns-reconciliation.ts).
    expect(sweepNames.indexOf('node_tunnel_cleanup')).toBeLessThan(
      sweepNames.indexOf('app_route_dns_reconciliation')
    );
    expect(sweepNames.indexOf('deployment_node_cleanup')).toBeLessThan(
      sweepNames.indexOf('app_route_dns_reconciliation')
    );
    const appRouteDnsCallback = isolateMock.mock.calls.find(
      ([name]) => name === 'app_route_dns_reconciliation'
    )?.[1];
    expect(appRouteDnsCallback).toEqual(expect.any(Function));
    await appRouteDnsCallback?.();
    expect(appRouteDnsMock).toHaveBeenCalledWith(env);
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
    capacityPoolReconciliationMock.mockResolvedValue({
      installationEnsured: true,
      usersEnsured: 2,
      projectsEnsured: 3,
    });
    const capacityPoolCallback = isolateMock.mock.calls.find(
      ([name]) => name === 'capacity_pool_reconciliation'
    )?.[1];
    expect(capacityPoolCallback).toEqual(expect.any(Function));
    await capacityPoolCallback?.();
    expect(capacityPoolReconciliationMock).toHaveBeenCalledWith(env);
    expect(logInfoMock).toHaveBeenCalledWith(
      'cron.completed',
      expect.objectContaining({ type: 'sweep', failedSweeps: [] })
    );
  });

  it('carries the archive-sharding refused count into cron.completed', async () => {
    enabledMock.mockResolvedValue(true);
    isolateMock.mockImplementation(async (name: string) =>
      name === 'project_data_archive_sharding'
        ? {
            enabled: true,
            skipped: false,
            skipReason: null,
            selected: 3,
            migrated: 1,
            recoveredCrashGaps: 0,
            refused: 2,
            failed: 0,
            poisoned: 0,
            chunksCopied: 4,
            rowsCopied: 40,
          }
        : undefined
    );

    await scheduled(controller, env, context);

    expect(logInfoMock).toHaveBeenCalledWith(
      'cron.completed',
      expect.objectContaining({
        projectDataArchiveShardingEnabled: true,
        projectDataArchiveShardingSkipped: false,
        projectDataArchiveShardingSelected: 3,
        projectDataArchiveShardingMigrated: 1,
        projectDataArchiveShardingRefused: 2,
        projectDataArchiveShardingFailed: 0,
      })
    );
  });
});

describe('provider orphan failure reporting', () => {
  it.each([
    { errors: 1, skipped: true, accountErrors: 0 },
    { errors: 2, skipped: false, accountErrors: 0 },
    { errors: 0, skipped: true, accountErrors: 0 },
    // Failures confined to user/project accounts are logged, never a failed platform sweep.
    { errors: 0, skipped: false, accountErrors: 3 },
  ])(
    'reports errors=$errors accountErrors=$accountErrors skipped=$skipped and runs the following sweep',
    async ({ errors, skipped, accountErrors }) => {
      const { createSweepIsolator: realCreate } = await vi.importActual<
        typeof import('../../../src/scheduled/sweep-isolation')
      >('../../../src/scheduled/sweep-isolation');
      const { createSweepIsolator } = await import('../../../src/scheduled/sweep-isolation');
      const real = realCreate(env);
      const isolate = real.isolate.bind(real);
      const followingSweep = vi.fn().mockResolvedValue(undefined);
      vi.mocked(createSweepIsolator).mockReturnValueOnce({
        ...real,
        isolate: (name, fn) =>
          name === 'provider_orphan_reconciliation'
            ? isolate(name, fn)
            : name === 'capacity_pool_reconciliation'
              ? isolate(name, followingSweep)
              : Promise.resolve(undefined),
      });
      enabledMock.mockResolvedValue(true);
      providerOrphanMock.mockResolvedValue({
        errors,
        accountErrors,
        scanned: 3,
        destroyed: 1,
        deletionRequested: 2,
        skipped,
        skipReason: skipped ? 'credential-resolution-failed' : null,
      });
      persistErrorMock.mockClear();

      await scheduled(controller, env, context);

      expect(providerOrphanMock).toHaveBeenCalledWith(env);
      expect(followingSweep).toHaveBeenCalledOnce();
      if (errors > 0) {
        expect(persistErrorMock).toHaveBeenCalledWith(
          {},
          expect.objectContaining({
            context: {
              recoveryType: 'cron_sweep_failure',
              sweep: 'provider_orphan_reconciliation',
            },
          }),
          env
        );
      } else {
        expect(persistErrorMock).not.toHaveBeenCalled();
      }
      expect(logInfoMock).toHaveBeenCalledWith(
        'cron.completed',
        expect.objectContaining({
          failedSweeps: errors ? ['provider_orphan_reconciliation'] : [],
          failedSweepCount: errors ? 1 : 0,
          providerOrphansScanned: 3,
          providerOrphansDestroyed: 1,
          providerOrphansDeletionRequested: 2,
          providerOrphanErrors: errors,
          providerOrphanAccountErrors: accountErrors,
        })
      );
    }
  );
});
