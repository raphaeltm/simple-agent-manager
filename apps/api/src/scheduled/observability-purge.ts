/**
 * Cron handler for observability error retention purge.
 *
 * Runs as part of the 5-minute cron sweep to:
 * 1. Delete errors older than OBSERVABILITY_ERROR_RETENTION_DAYS (default 30)
 * 2. Delete oldest excess rows when count exceeds OBSERVABILITY_ERROR_MAX_ROWS (default 100,000)
 *
 * See: specs/023-admin-observability/tasks.md (T023-T024)
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { activeLocalAnalyticsSink } from '../services/analytics-sink';
import { purgeExpiredErrors, type PurgeResult } from '../services/observability';

export async function runObservabilityPurge(env: Env): Promise<PurgeResult> {
  if (!env.OBSERVABILITY_DATABASE) {
    return { deletedByAge: 0, deletedByCount: 0 };
  }

  const result = await purgeExpiredErrors(env.OBSERVABILITY_DATABASE, env);
  // Self-host local analytics sink: age and row-cap bound. No call at all on Cloudflare, where
  // nothing is installed. Isolated so an analytics purge failure cannot hide the error purge.
  const local = activeLocalAnalyticsSink(env);
  if (local) {
    try {
      await local.purge(env);
    } catch (err) {
      log.error('analytics.local_purge_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
