import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS } from './session-snapshot-artifacts';

export const DEFAULT_SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS = 30 * 60 * 1000;
export const MAX_SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type SleepPredicateEnv = Pick<
  Env,
  'SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS' | 'SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS'
>;

export interface SleepLifecyclePredicateResult {
  expires_at: string | null;
  sleep_status: string | null;
  sleep_claimed_at: string | null;
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

export function snapshotRecoveryMaxAttempts(env: SleepPredicateEnv): number {
  return parsePositiveInt(
    env.SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS,
    DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS
  );
}

export function restorableOrInFlightSleepSnapshotPredicateSql(alias = 'snapshot'): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error('Invalid SQL alias for sleep snapshot predicate');
  }
  const s = alias;
  return `(
    (
      ${s}.sleeping_at IS NOT NULL
      AND ${s}.sleep_status = 'sleeping'
      AND ${s}.expires_at > ?
      AND ${s}.recovery_attempts < ?
      AND (
        (${s}.status = 'available' AND ${s}.degradation = 'none')
        OR (${s}.status = 'degraded' AND ${s}.degradation IS NOT NULL AND ${s}.degradation != 'none')
      )
    )
    OR (
      ${s}.sleeping_at IS NULL
      AND ${s}.sleep_status IN ('scheduled', 'preparing', 'stopping', 'failed')
      AND COALESCE(${s}.sleep_claimed_at, ${s}.sleep_after, ${s}.updated_at, ${s}.created_at) > ?
      AND (
        ${s}.sleep_status IN ('scheduled', 'preparing', 'stopping')
        OR (
          ${s}.sleep_status = 'failed'
          AND (
            ${s}.sleep_attempts < ?
            OR ${s}.status = 'degraded'
            OR ${s}.capture_generation IS NOT NULL
          )
        )
      )
    )
  )`;
}

export function sleepLifecyclePredicateBindings(
  env: SleepPredicateEnv,
  now: Date
): [string, number, string, number] {
  const maxAttempts = snapshotRecoveryMaxAttempts(env);
  const inFlightCeiling = new Date(now.getTime() - sessionSleepInFlightMaxAgeMs(env)).toISOString();
  return [now.toISOString(), maxAttempts, inFlightCeiling, maxAttempts];
}

export async function findRestorableOrInFlightSleepSnapshot(
  database: D1Database,
  env: SleepPredicateEnv,
  input: SleepLifecyclePredicateInput
): Promise<SleepLifecyclePredicateResult | null> {
  const now = input.now ?? new Date();
  const workspaceClause = input.workspaceId ? 'AND workspace_id = ?' : '';
  const bindings: unknown[] = [input.chatSessionId, input.projectId];
  if (input.workspaceId) bindings.push(input.workspaceId);
  bindings.push(...sleepLifecyclePredicateBindings(env, now));

  const row = await database
    .prepare(
      `SELECT expires_at, sleep_status, sleep_claimed_at, sleep_after, updated_at, created_at
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
