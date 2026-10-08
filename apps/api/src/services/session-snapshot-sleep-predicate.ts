import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  sessionRecoveryBudgetAvailableSql,
  sessionRecoveryDecayCutoffIso,
  sessionRecoveryMaxAttempts,
} from './session-snapshot-recovery-budget';
import { sessionSleepMaxAttempts } from './sleep-preserved-task-status';

export const DEFAULT_SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS = 30 * 60 * 1000;
export const MAX_SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type SleepPredicateEnv = Pick<
  Env,
  | 'SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS'
  | 'SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS'
  | 'SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS'
  | 'SESSION_SLEEP_MAX_ATTEMPTS'
>;

export interface SleepLifecyclePredicateResult {
  expires_at: string | null;
  sleep_status: string | null;
  sleep_claimed_at: string | null;
  sleep_stopping_since: string | null;
  sleep_after: string | null;
  updated_at: string | null;
  created_at: string | null;
}

export interface SleepLifecyclePredicateInput {
  projectId: string;
  chatSessionId: string;
  workspaceId?: string | null;
  now?: Date;
}

export function sessionSleepInFlightMaxAgeMs(env: SleepPredicateEnv): number {
  return Math.min(
    parsePositiveInt(
      env.SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS,
      DEFAULT_SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS
    ),
    MAX_SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS
  );
}

/**
 * Restorable sleeping snapshot, or a sleep still in flight. A clean failed wake
 * may be temporarily rate-limited; preserve it through cooldown until expiry.
 * The resumer's attempt budget decays, so cooldown is not loss of recoverability. A `failed` sleep is in
 * flight while the sweep will act on it: inside a bounded sleep-failure episode every
 * failure keeps a due retry (`sleep_after`) until the sweep retries it, falls back to a
 * transcript-and-Git sleep, or ends the episode blocked (`session-sleep-episode.ts`).
 * A degraded or in-flight capture is no longer in flight on its own. Legacy rows that
 * were exhausted without a retry stay in flight below the attempt budget, mirroring the
 * sweep's re-arm clause.
 */
export function restorableOrInFlightSleepSnapshotPredicateSql(alias = 'snapshot'): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error('Invalid SQL alias for sleep snapshot predicate');
  }
  const s = alias;
  return `(
    (
      ${s}.sleeping_at IS NOT NULL
      AND ${s}.sleep_status = 'sleeping'
      AND ${s}.expires_at > ? AND julianday(${s}.expires_at) IS NOT NULL
      AND (${sessionRecoveryBudgetAvailableSql(s)}
        OR (${s}.recovery_status = 'failed' AND julianday(${s}.recovery_failed_at) IS NOT NULL))
      AND (
        (${s}.status = 'available' AND ${s}.degradation = 'none')
        OR (${s}.status = 'degraded' AND ${s}.degradation IS NOT NULL AND ${s}.degradation != 'none')
      )
    )
    OR (
      ${s}.sleeping_at IS NULL
      AND ${s}.sleep_status IN ('scheduled', 'preparing', 'stopping', 'failed')
      AND (
        (
          ${s}.sleep_status = 'stopping'
          AND COALESCE(${s}.sleep_stopping_since, ${s}.sleep_claimed_at, ${s}.sleep_after, ${s}.updated_at, ${s}.created_at) > ?
        )
        OR (
          ${s}.sleep_status != 'stopping'
          AND COALESCE(${s}.sleep_claimed_at, ${s}.sleep_after, ${s}.updated_at, ${s}.created_at) > ?
        )
      )
      AND (
        ${s}.sleep_status IN ('scheduled', 'preparing', 'stopping')
        OR (
          ${s}.sleep_status = 'failed'
          AND (${s}.sleep_after IS NOT NULL OR ${s}.sleep_attempts < ?)
        )
      )
    )
  )`;
}

export function sleepLifecyclePredicateBindings(
  env: SleepPredicateEnv,
  now: Date
): [string, number, string, string, string, number] {
  const inFlightCeiling = new Date(now.getTime() - sessionSleepInFlightMaxAgeMs(env)).toISOString();
  return [
    now.toISOString(),
    sessionRecoveryMaxAttempts(env),
    sessionRecoveryDecayCutoffIso(env, now.getTime()),
    inFlightCeiling,
    inFlightCeiling,
    // A failed sleep is still in flight while the sweep will retry it: the sleep
    // budget, not the wake budget (`runSessionSleepSweep`, `.claude/rules/58`).
    sessionSleepMaxAttempts(env),
  ];
}

export async function findRestorableOrInFlightSleepSnapshot(
  database: D1Database,
  env: SleepPredicateEnv,
  input: SleepLifecyclePredicateInput
): Promise<SleepLifecyclePredicateResult | null> {
  const now = input.now ?? new Date();
  const workspaceClause = input.workspaceId
    ? 'AND (workspace_id = ? OR recovery_workspace_id = ?)'
    : '';
  const bindings: unknown[] = [input.chatSessionId, input.projectId];
  if (input.workspaceId) bindings.push(input.workspaceId, input.workspaceId);
  bindings.push(...sleepLifecyclePredicateBindings(env, now));

  const row = await database
    .prepare(
      `SELECT expires_at, sleep_status, sleep_claimed_at, sleep_stopping_since, sleep_after, updated_at, created_at
         FROM session_snapshots
        WHERE chat_session_id = ?
          AND project_id = ?
          ${workspaceClause}
          AND ${restorableOrInFlightSleepSnapshotPredicateSql('session_snapshots')}
        ORDER BY COALESCE(expires_at, sleep_after, sleep_claimed_at, updated_at, created_at) ASC
        LIMIT 1`
    )
    .bind(...bindings)
    .first<SleepLifecyclePredicateResult>();
  return row ?? null;
}
