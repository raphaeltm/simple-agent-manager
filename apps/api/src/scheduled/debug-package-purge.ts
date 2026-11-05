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
      debugPackageRetentionDays: result.retentionDays,
      debugPackagesDeleted: result.deleted,
      debugPackagesFailed: result.failed,
      debugPackagePurgeBatches: result.batches,
      debugPackagePurgeComplete: result.complete,
    });
  } catch (err) {
    log.error('cron.debug_package_purge_failed', { cron, error: String(err) });
  }
}
