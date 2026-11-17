/**
 * The daily `0 3 * * *` cron. Every job is its own `waitUntil` promise with its own catch, so one
 * failing or slow job cannot skip or delay the others (`.claude/rules/53`). Split out of
 * `handler.ts` (`.claude/rules/18-file-size-limits.md`).
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { runCloudflareCostSnapshot } from '../services/cloudflare-cost-snapshot';
import { runLifecycleLatencyDailyEvaluation } from '../services/lifecycle-latency';
import { purgeRuntimeSecretMaterial } from '../services/runtime-secret-request-maintenance';
import { runAnalyticsForwardJob } from './analytics-forward';
import { runDebugPackagePurge } from './debug-package-purge';
import { runOperationsAuditPurge } from './operations-audit-purge';
import { runOperationsTelemetryRetention } from './operations-telemetry-retention';

export const DAILY_CRON = '0 3 * * *';

function logFailure(event: string) {
  return (err: unknown) => {
    log.error(event, { error: err instanceof Error ? err.message : String(err) });
  };
}

export function scheduleDailyJobs(
  env: Env,
  cron: string,
  waitUntil: (promise: Promise<unknown>) => void
): void {
  waitUntil(
    (async () => {
      const forward = await runAnalyticsForwardJob(env);
      log.info('cron.completed', {
        cron,
        type: 'daily-forward',
        forwardEnabled: forward.enabled,
        forwardEventsQueried: forward.eventsQueried,
        forwardSegmentSent: forward.segment.sent,
        forwardGA4Sent: forward.ga4.sent,
        forwardCursorUpdated: forward.cursorUpdated,
      });
    })().catch(logFailure('cron.analytics_forward_failed'))
  );
  // Separate promise: an analytics failure must not skip the audit retention purge.
  waitUntil(runOperationsAuditPurge(env, cron));
  waitUntil(runDebugPackagePurge(env, cron));
  waitUntil(runOperationsTelemetryRetention(env, cron));
  // Expired collected secret values are already refused at read time; this deletes them.
  waitUntil(purgeRuntimeSecretMaterial(env).catch(logFailure('cron.runtime_secret_purge_failed')));
  // Separate promise again, so none of the jobs above can suppress the latency check.
  waitUntil(
    runLifecycleLatencyDailyEvaluation(env).catch(logFailure('cron.lifecycle_latency_daily_failed'))
  );
  // Insights slice CF: the previous days' Cloudflare usage for Admin Health & cost. It records its
  // own Cloudflare failures; this catch covers settings or D1 failing underneath it.
  waitUntil(
    runCloudflareCostSnapshot(env).catch(logFailure('cron.cloudflare_cost_snapshot_failed'))
  );
}
