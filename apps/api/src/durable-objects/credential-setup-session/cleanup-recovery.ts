/** Pending SDK work has a watchdog, not a failed-network-attempt budget. */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  DEFAULT_SETUP_SESSION_MAX_CLEANUP_RECOVERY_ATTEMPTS,
  getSetupSessionCleanupRecoveryConfig,
} from '../../services/credential-setup-config';
import { persistError } from '../../services/observability-errors';
import { getSandboxConfig } from '../../services/sandbox';
import type { SetupSessionRow } from './schema';

/** Snapshot prevents later setting changes from reviving a quarantined episode. */
export function cleanupAttemptLimit(row: SetupSessionRow): number {
  return row.cleanup_recovery_max_attempts ?? DEFAULT_SETUP_SESSION_MAX_CLEANUP_RECOVERY_ATTEMPTS;
}

export function readCleanupRow(sql: SqlStorage, sessionId: string): SetupSessionRow | undefined {
  return sql
    .exec<SetupSessionRow>('SELECT * FROM setup_session WHERE id = ?', sessionId)
    .toArray()[0];
}

/** Resolve once per episode; already-started legacy recovery keeps its old policy. */
export async function snapshotCleanupPolicy(
  env: Env,
  sql: SqlStorage,
  row: SetupSessionRow
): Promise<SetupSessionRow> {
  if (row.cleanup_recovery_max_attempts != null) return row;
  const policy = await getSetupSessionCleanupRecoveryConfig(env);
  sql.exec(
    `UPDATE setup_session SET cleanup_recovery_max_attempts = ? WHERE id = ? AND cleanup_recovery_max_attempts IS NULL`,
    (row.cleanup_attempts ?? 0) > 0
      ? DEFAULT_SETUP_SESSION_MAX_CLEANUP_RECOVERY_ATTEMPTS
      : policy.maxAttempts,
    row.id
  );
  return readCleanupRow(sql, row.id) ?? row;
}

function pendingDeadline(env: Env, row: SetupSessionRow): number | null {
  const timeout = getSandboxConfig(env).execTimeoutMs;
  const completedAt = row.completed_at;
  if (typeof completedAt !== 'number') return null;
  const clocks = [row.expires_at, completedAt, timeout, row.capture_poll_ms];
  if (!clocks.every((value) => typeof value === 'number' && Number.isFinite(value) && value > 0))
    return null;
  const deadline = Math.max(row.expires_at, completedAt + timeout + row.capture_poll_ms);
  return Number.isFinite(new Date(deadline).getTime()) ? deadline : null;
}

async function deleteRecoveryAlarm(ctx: DurableObjectState): Promise<void> {
  try {
    await ctx.storage.deleteAlarm();
  } catch {
    /* Already disarmed. */
  }
}

export async function quarantineCleanup(
  ctx: DurableObjectState,
  env: Env,
  sql: SqlStorage,
  row: SetupSessionRow,
  reason = 'attempts_exhausted'
): Promise<void> {
  if ((row.cleanup_attempts ?? 0) > cleanupAttemptLimit(row)) {
    await deleteRecoveryAlarm(ctx);
    return;
  }
  const attempts = cleanupAttemptLimit(row) + 1;
  sql.exec(`UPDATE setup_session SET cleanup_attempts = ? WHERE id = ?`, attempts, row.id);
  const context = {
    status: row.status,
    cleanupFromStatus: row.cleanup_from_status,
    attempts: row.cleanup_attempts,
    reason,
  };
  log.error('credential_setup.cleanup_abandoned', { sessionId: row.id, ...context });
  await deleteRecoveryAlarm(ctx);
  if (env.OBSERVABILITY_DATABASE) {
    ctx.waitUntil(
      persistError(
        env.OBSERVABILITY_DATABASE,
        {
          source: 'api',
          level: 'error',
          message: 'credential_setup.cleanup_abandoned',
          sessionId: row.id,
          context,
        },
        env
      ).catch(() => log.error('credential_setup.cleanup_alert_failed', { sessionId: row.id }))
    );
  }
}

/** Read after awaits; setAlarm is issued before yielding so a later settlement wins. */
export async function deferPendingCleanup(
  ctx: DurableObjectState,
  env: Env,
  sql: SqlStorage,
  row: SetupSessionRow
): Promise<boolean> {
  row = readCleanupRow(sql, row.id) ?? row;
  if (row.cleanup_pending !== 1) return true;
  if ((row.cleanup_attempts ?? 0) > cleanupAttemptLimit(row)) {
    await deleteRecoveryAlarm(ctx);
    return true;
  }
  if ((row.cleanup_sandbox_io_pending ?? 0) <= 0 && row.cleanup_scrub_state !== 1) return false;
  if (row.cleanup_from_status === 'provisioning')
    log.info('credential_setup.scrub_skipped', {
      sessionId: row.id,
      reason: 'provisioning_still_in_flight',
    });
  const deadline = pendingDeadline(env, row);
  if (deadline === null || Date.now() >= deadline) {
    await quarantineCleanup(ctx, env, sql, row, 'sdk_uncertainty_watchdog');
    return true;
  }
  try {
    await ctx.storage.setAlarm(deadline);
  } catch {
    log.error('credential_setup.cleanup_alarm_failed', { sessionId: row.id });
  }
  return true;
}

/** Count work only after terminal D1 repair and pending-flight deferral. */
export async function claimCleanupAttempt(
  ctx: DurableObjectState,
  env: Env,
  sql: SqlStorage,
  row: SetupSessionRow
): Promise<boolean> {
  row = readCleanupRow(sql, row.id) ?? row;
  // Quarantine is final even if an original SDK promise succeeds afterwards.
  if ((row.cleanup_attempts ?? 0) > cleanupAttemptLimit(row)) return false;
  if (row.cleanup_settlement_credit === 1) {
    sql.exec('UPDATE setup_session SET cleanup_settlement_credit = 0 WHERE id = ?', row.id);
    return true;
  }
  const attempts = (row.cleanup_attempts ?? 0) + 1;
  if (attempts > cleanupAttemptLimit(row)) {
    await quarantineCleanup(ctx, env, sql, row);
    return false;
  }
  sql.exec(`UPDATE setup_session SET cleanup_attempts = ? WHERE id = ?`, attempts, row.id);
  log.warn('credential_setup.cleanup_resumed', {
    sessionId: row.id,
    status: row.status,
    cleanupFromStatus: row.cleanup_from_status,
    attempt: attempts,
  });
  return true;
}

/** An alarm must not acknowledge unresolved cleanup without a durable next wake.
 * Cloudflare retries uncaught alarm failures (including isolate termination).
 * https://developers.cloudflare.com/durable-objects/api/alarms/
 */
export async function ensureCleanupWake(
  ctx: DurableObjectState,
  sql: SqlStorage,
  row: SetupSessionRow
): Promise<void> {
  const needsWake = (current: SetupSessionRow | undefined) =>
    current?.cleanup_pending === 1 &&
    (current.cleanup_attempts ?? 0) <= cleanupAttemptLimit(current);
  if (!needsWake(readCleanupRow(sql, row.id))) return;
  let alarm: number | null = null;
  try {
    alarm = await ctx.storage.getAlarm();
  } catch {
    // An unknown wake cannot acknowledge the alarm delivery as complete.
  }
  if (alarm !== null && Number.isFinite(alarm)) return;
  if (needsWake(readCleanupRow(sql, row.id)))
    throw new Error('Credential setup cleanup has no durable recovery alarm');
}
