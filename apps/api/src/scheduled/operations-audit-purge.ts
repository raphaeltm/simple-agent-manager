/**
 * Daily retention purge for the Operations debugger tool audit log (migration 0217).
 * Runs from the `0 3 * * *` cron; storage cleanup is at most daily (policy b0950dd6).
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { purgeExpiredOperationsAudit } from '../services/operations-access';

export async function runOperationsAuditPurge(env: Env, cron: string): Promise<void> {
  try {
    const result = await purgeExpiredOperationsAudit(env);
    log.info('cron.completed', {
      cron,
      type: 'operations-audit-purge',
      operationsAuditRetentionDays: result.retentionDays,
      operationsAuditDeleted: result.deleted,
    });
  } catch (err) {
    log.error('cron.operations_audit_purge_failed', { cron, error: String(err) });
  }
}
