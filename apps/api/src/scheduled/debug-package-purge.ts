/**
 * Daily retention purge for Operations debug packages (`/debug-packages/` in the Operations
 * project library). Runs from the `0 3 * * *` cron; storage cleanup is at most daily (policy
 * b0950dd6). Retention is the admin setting `operations.debugPackageRetentionDays`.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { purgeExpiredDebugPackages } from '../services/fleet-ops/debug-packages';
import { resolveFleetOpsSettings } from '../services/fleet-ops/settings';

export async function runDebugPackagePurge(env: Env, cron: string): Promise<void> {
  try {
    const result = await purgeExpiredDebugPackages(env, await resolveFleetOpsSettings(env));
    log.info('cron.completed', {
      cron,
      type: 'debug-package-purge',
      debugPackagePurgeSkipped: 'skipped' in result ? result.skipped : undefined,
      debugPackageRetentionDays: 'retentionDays' in result ? result.retentionDays : undefined,
      debugPackagesDeleted: result.deleted,
      debugPackagesFailed: result.failed,
      debugPackagePurgeBatchFull: 'batchFull' in result ? result.batchFull : undefined,
    });
  } catch (err) {
    log.error('cron.debug_package_purge_failed', { cron, error: String(err) });
  }
}
