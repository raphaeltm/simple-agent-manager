import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS } from './session-snapshot-artifacts';

/**
 * How long a burst of failed wake attempts keeps the budget spent.
 *
 * The cap exists to stop a hot wake loop, not to ration a session's lifetime.
 * Wakes are triggered by prompt delivery (`vm-prompt-delivery-adapter.ts`), so a
 * decayed budget bounds retries to `maxAttempts` per window rather than
 * `maxAttempts` ever; `session_snapshots.expires_at` remains the absolute
 * escape path (`.claude/rules/47`).
 */
export const DEFAULT_SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS = 15 * 60 * 1000;

type RecoveryBudgetEnv = Pick<
  Env,
  'SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS' | 'SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS'
>;

export function sessionRecoveryMaxAttempts(env: RecoveryBudgetEnv): number {
  return parsePositiveInt(
    env.SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS,
    DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS
  );
}

export function sessionRecoveryAttemptDecayMs(env: RecoveryBudgetEnv): number {
  return parsePositiveInt(
    env.SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS,
    DEFAULT_SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS
  );
}

/** The instant at or before which a recorded failure no longer holds the budget. */
export function sessionRecoveryDecayCutoffIso(env: RecoveryBudgetEnv, nowMs: number): string {
  return new Date(nowMs - sessionRecoveryAttemptDecayMs(env)).toISOString();
}

/**
 * Whether a wake may still be authorized for this snapshot's attempt budget.
 *
 * A spent budget is released only by a CLEAN failure report older than the decay
 * window. `recovery_failed_at IS NULL` means no attempt reported back — a crashed
 * or still-leased attempt — and deliberately does NOT release the budget, so a
 * claim that never returns cannot be laundered into a fresh one. The stale-claim
 * lease in `claimSessionSnapshotRecovery` remains the path for that case.
 *
 * This is the single definition shared by the resumer and by every consumer that
 * mirrors it, so the destroyer cannot disagree with the resumer about whether a
 * session is still restorable (`.claude/rules/58`).
 */
export function sessionRecoveryBudgetAvailable(input: {
  recoveryAttempts: number;
  /** ms epoch of the last clean failure report; null when absent or unparseable. */
  recoveryFailedAtMs: number | null;
  maxAttempts: number;
  decayMs: number;
  nowMs: number;
}): boolean {
  if (input.recoveryAttempts < input.maxAttempts) return true;
  // Absent, NaN, or (from an untyped caller) undefined all mean "no clean
  // failure report", which must fail closed rather than release the budget.
  if (!Number.isFinite(input.recoveryFailedAtMs)) return false;
  return (input.recoveryFailedAtMs as number) <= input.nowMs - input.decayMs;
}

/**
 * The SQL half of {@link sessionRecoveryBudgetAvailable}, byte-for-byte the same
 * rule. Binds, in order: `maxAttempts`, then the decay cutoff ISO string from
 * {@link sessionRecoveryDecayCutoffIso}.
 */
export function sessionRecoveryBudgetAvailableSql(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error('Invalid SQL alias for session recovery budget predicate');
  }
  return `(
    ${alias}.recovery_attempts < ?
    OR (${alias}.recovery_failed_at IS NOT NULL AND ${alias}.recovery_failed_at <= ?)
  )`;
}
