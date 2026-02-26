/**
 * Cron handler for observability error retention purge.
 *
 * Runs as part of the 5-minute cron sweep to:
 * 1. Delete errors older than OBSERVABILITY_ERROR_RETENTION_DAYS (default 30)
 * 2. Delete oldest excess rows when count exceeds OBSERVABILITY_ERROR_MAX_ROWS (default 100,000)
 *
 * See: specs/023-admin-observability/tasks.md (T023-T024)
 */
import type { Env } from '../index';
import { purgeExpiredErrors, type PurgeResult } from '../services/observability';

export async function runObservabilityPurge(env: Env): Promise<PurgeResult> {
  if (!env.OBSERVABILITY_DATABASE) {
    return { deletedByAge: 0, deletedByCount: 0 };
  }

  return purgeExpiredErrors(env.OBSERVABILITY_DATABASE, env);
}
