import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  runMonthlyCostAggregation,
  runAnalyticsForwardJob,
  runTrialRolloverAudit,
  runTrialWaitlistCleanup,
  checkProvisioningTimeouts,
  migrateOrphanedWorkspaces,
  runNodeCleanupSweep,
  recoverStuckTasks,
  runObservabilityPurge,
  runCronTriggerSweep,
  runTriggerExecutionCleanup,
  runComputeUsageCleanup,
  runTrialExpireSweep,
} = vi.hoisted(() => ({
  runMonthlyCostAggregation: vi.fn(),
  runAnalyticsForwardJob: vi.fn(),
  runTrialRolloverAudit: vi.fn(),
  runTrialWaitlistCleanup: vi.fn(),
  checkProvisioningTimeouts: vi.fn(),
  migrateOrphanedWorkspaces: vi.fn(),
  runNodeCleanupSweep: vi.fn(),
  recoverStuckTasks: vi.fn(),
  runObservabilityPurge: vi.fn(),
  runCronTriggerSweep: vi.fn(),
  runTriggerExecutionCleanup: vi.fn(),
  runComputeUsageCleanup: vi.fn(),
  runTrialExpireSweep: vi.fn(),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({ db: true })),
}));

vi.mock('../../../src/db/schema', () => ({}));
vi.mock('../../../src/services/ai-monthly-cost-cron', () => ({ runMonthlyCostAggregation }));
vi.mock('../../../src/scheduled/analytics-forward', () => ({ runAnalyticsForwardJob }));
vi.mock('../../../src/scheduled/trial-rollover', () => ({ runTrialRolloverAudit }));
vi.mock('../../../src/scheduled/trial-waitlist-cleanup', () => ({ runTrialWaitlistCleanup }));
vi.mock('../../../src/services/timeout', () => ({ checkProvisioningTimeouts }));
vi.mock('../../../src/services/workspace-migration', () => ({ migrateOrphanedWorkspaces }));
vi.mock('../../../src/scheduled/node-cleanup', () => ({ runNodeCleanupSweep }));
vi.mock('../../../src/scheduled/stuck-tasks', () => ({ recoverStuckTasks }));
vi.mock('../../../src/scheduled/observability-purge', () => ({ runObservabilityPurge }));
vi.mock('../../../src/scheduled/cron-triggers', () => ({ runCronTriggerSweep }));
vi.mock('../../../src/scheduled/trigger-execution-cleanup', () => ({ runTriggerExecutionCleanup }));
vi.mock('../../../src/scheduled/compute-usage-cleanup', () => ({ runComputeUsageCleanup }));
vi.mock('../../../src/scheduled/trial-expire', () => ({ runTrialExpireSweep }));

const { handleScheduled } = await import('../../../src/app/scheduled');

function makeCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        promises.push(promise);
      }),
    } as unknown as ExecutionContext,
    promises,
  };
}

describe('handleScheduled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runMonthlyCostAggregation.mockResolvedValue({ enabled: true, usersUpdated: 1, totalEntries: 2, errors: 0 });
    runAnalyticsForwardJob.mockResolvedValue({
      enabled: true,
      eventsQueried: 3,
      segment: { sent: 2 },
      ga4: { sent: 1 },
      cursorUpdated: true,
    });
    runTrialRolloverAudit.mockResolvedValue({ monthKey: '2026-06', pruned: 4 });
    runTrialWaitlistCleanup.mockResolvedValue({ purged: 5 });
    checkProvisioningTimeouts.mockResolvedValue(6);
    migrateOrphanedWorkspaces.mockResolvedValue(7);
    runNodeCleanupSweep.mockResolvedValue({
      staleDestroyed: 1,
      lifetimeDestroyed: 2,
      lifetimeSkipped: 3,
      errors: 0,
      orphanedWorkspacesFlagged: 4,
      orphanedNodesFlagged: 5,
    });
    recoverStuckTasks.mockResolvedValue({
      failedQueued: 1,
      failedDelegated: 2,
      failedInProgress: 3,
      heartbeatSkipped: 4,
      errors: 0,
      doHealthChecked: 5,
    });
    runObservabilityPurge.mockResolvedValue({ deletedByAge: 1, deletedByCount: 2 });
    runCronTriggerSweep.mockResolvedValue({ checked: 1, fired: 2, skipped: 3, failed: 0 });
    runTriggerExecutionCleanup.mockResolvedValue({
      staleRecovered: 1,
      staleQueuedRecovered: 2,
      retentionPurged: 3,
      errors: 0,
    });
    runComputeUsageCleanup.mockResolvedValue(8);
    runTrialExpireSweep.mockResolvedValue({ expired: 9 });
  });

  it('delegates hourly cost aggregation through waitUntil', async () => {
    const { ctx, promises } = makeCtx();

    await handleScheduled({ cron: '30 * * * *' } as ScheduledController, {} as never, ctx);
    await Promise.all(promises);

    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(runMonthlyCostAggregation).toHaveBeenCalledTimes(1);
    expect(checkProvisioningTimeouts).not.toHaveBeenCalled();
  });

  it('delegates the operational sweep jobs for the default cron', async () => {
    const { ctx } = makeCtx();
    const env = { DATABASE: {}, OBSERVABILITY_DATABASE: {} } as never;

    await handleScheduled({ cron: '*/5 * * * *' } as ScheduledController, env, ctx);

    expect(checkProvisioningTimeouts).toHaveBeenCalledWith({}, env, {});
    expect(migrateOrphanedWorkspaces).toHaveBeenCalledWith({ db: true });
    expect(runNodeCleanupSweep).toHaveBeenCalledWith(env);
    expect(recoverStuckTasks).toHaveBeenCalledWith(env);
    expect(runObservabilityPurge).toHaveBeenCalledWith(env);
    expect(runCronTriggerSweep).toHaveBeenCalledWith(env);
    expect(runTriggerExecutionCleanup).toHaveBeenCalledWith(env);
    expect(runComputeUsageCleanup).toHaveBeenCalledWith(env);
    expect(runTrialExpireSweep).toHaveBeenCalledWith(env);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
});
