/**
 * The daily cron runs every job as its own promise (`.claude/rules/53`): a Cloudflare cost
 * snapshot that throws must not stop the other daily jobs, and a failing earlier job must not
 * stop the snapshot. Each job is replaced at its module boundary; `scheduleDailyJobs` and its
 * catches run for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const jobs = vi.hoisted(() => ({
  forward: vi.fn(),
  auditPurge: vi.fn(),
  debugPurge: vi.fn(),
  telemetryRetention: vi.fn(),
  secretPurge: vi.fn(),
  latency: vi.fn(),
  cloudflare: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../../../src/scheduled/analytics-forward', () => ({
  runAnalyticsForwardJob: jobs.forward,
}));
vi.mock('../../../src/scheduled/operations-audit-purge', () => ({
  runOperationsAuditPurge: jobs.auditPurge,
}));
vi.mock('../../../src/scheduled/debug-package-purge', () => ({
  runDebugPackagePurge: jobs.debugPurge,
}));
vi.mock('../../../src/scheduled/operations-telemetry-retention', () => ({
  runOperationsTelemetryRetention: jobs.telemetryRetention,
}));
vi.mock('../../../src/services/runtime-secret-request-maintenance', () => ({
  purgeRuntimeSecretMaterial: jobs.secretPurge,
}));
vi.mock('../../../src/services/lifecycle-latency', () => ({
  runLifecycleLatencyDailyEvaluation: jobs.latency,
}));
vi.mock('../../../src/services/cloudflare-cost-snapshot', () => ({
  runCloudflareCostSnapshot: jobs.cloudflare,
}));
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: jobs.logError },
}));

const { DAILY_CRON, scheduleDailyJobs } = await import('../../../src/scheduled/daily-jobs');

const env = {} as never;

async function runDaily(): Promise<PromiseSettledResult<unknown>[]> {
  const scheduled: Promise<unknown>[] = [];
  scheduleDailyJobs(env, DAILY_CRON, (promise) => scheduled.push(promise));
  return Promise.allSettled(scheduled);
}

describe('scheduleDailyJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jobs.forward.mockResolvedValue({
      enabled: false,
      eventsQueried: 0,
      segment: { sent: 0 },
      ga4: { sent: 0 },
      cursorUpdated: false,
    });
    for (const job of [
      jobs.auditPurge,
      jobs.debugPurge,
      jobs.telemetryRetention,
      jobs.secretPurge,
      jobs.latency,
    ])
      job.mockResolvedValue(undefined);
    jobs.cloudflare.mockResolvedValue({ status: 'ok' });
  });

  it('runs the Cloudflare cost snapshot with every other daily job', async () => {
    const settled = await runDaily();

    expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(jobs.cloudflare).toHaveBeenCalledWith(env);
    expect(jobs.latency).toHaveBeenCalledTimes(1);
    expect(jobs.auditPurge).toHaveBeenCalledTimes(1);
  });

  it('a failing snapshot is contained and logged; the other jobs still run', async () => {
    jobs.cloudflare.mockRejectedValue(new Error('D1 unavailable'));

    const settled = await runDaily();

    // The snapshot's promise resolves after its catch, so it cannot surface as unhandled.
    expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(jobs.logError).toHaveBeenCalledWith('cron.cloudflare_cost_snapshot_failed', {
      error: 'D1 unavailable',
    });
    for (const job of [
      jobs.forward,
      jobs.auditPurge,
      jobs.debugPurge,
      jobs.telemetryRetention,
      jobs.secretPurge,
      jobs.latency,
    ])
      expect(job).toHaveBeenCalledTimes(1);
  });

  it('failing earlier jobs do not stop the snapshot', async () => {
    jobs.forward.mockRejectedValue(new Error('forward broke'));
    jobs.latency.mockRejectedValue(new Error('latency broke'));
    jobs.secretPurge.mockRejectedValue(new Error('purge broke'));

    await runDaily();

    expect(jobs.cloudflare).toHaveBeenCalledTimes(1);
    expect(jobs.logError).toHaveBeenCalledWith('cron.lifecycle_latency_daily_failed', {
      error: 'latency broke',
    });
  });
});
