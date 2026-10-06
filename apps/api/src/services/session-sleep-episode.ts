/**
 * The bounded sleep-failure episode.
 *
 * Sleep is a convenience. A session whose final snapshot keeps failing must not pin its
 * compute forever, but it also must not lose work without an honest, durable recovery
 * point. An episode starts when a sleep first claims the session
 * (`claimSessionSnapshotSleep`) and ends when the session sleeps, wakes, or a human sends
 * a follow-up (`cancelScheduledSessionSleep`). Inside it:
 *
 * - `full`: ordinary full-snapshot sleep attempts, while fewer than
 *   `SESSION_SLEEP_FAILURE_MAX_ATTEMPTS` attempts failed and less than
 *   `SESSION_SLEEP_FAILURE_MAX_ELAPSED_MS` passed since the episode began.
 * - `fallback`: the sweep releases an idle VM session's compute while keeping its
 *   transcript and a restorable Git recovery point (`session-sleep-fallback.ts`). A
 *   transient failure to establish that minimum counts as another failed attempt.
 * - `blocked`: the minimum cannot be established, or failures reached the absolute ceiling
 *   (`SESSION_SLEEP_MAX_ATTEMPTS`). Automatic sleep stops retrying and says so in the chat;
 *   the runtime is left running.
 *
 * Both counters live on `session_snapshots` (migration 0179), so the budget survives
 * Worker restarts and duplicate sweeps. Neither a capture generation (prepare, complete,
 * or a degraded completion) nor a deferral touches them.
 */
import * as v from 'valibot';

import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { sessionSleepMaxAttempts } from './sleep-preserved-task-status';

/** Failed full-snapshot sleep attempts in one episode before the fallback is tried. */
export const DEFAULT_SESSION_SLEEP_FAILURE_MAX_ATTEMPTS = 3;
/**
 * Time since the episode began before the fallback is tried, whatever the attempt count.
 * With the 5-minute sweep and retry delay this is roughly three attempts.
 */
export const DEFAULT_SESSION_SLEEP_FAILURE_MAX_ELAPSED_MS = 15 * 60 * 1000;

export interface SessionSleepEpisodeConfig {
  /** Failed full attempts before the fallback phase. */
  failureMaxAttempts: number;
  /** Elapsed time since the episode began before the fallback phase. */
  failureMaxElapsedMs: number;
  /** Failed attempts (full and fallback) at which the episode ends blocked. */
  ceilingFailures: number;
}

type EpisodeEnv = Pick<
  Env,
  | 'SESSION_SLEEP_FAILURE_MAX_ATTEMPTS'
  | 'SESSION_SLEEP_FAILURE_MAX_ELAPSED_MS'
  | 'SESSION_SLEEP_MAX_ATTEMPTS'
>;

export function sessionSleepEpisodeConfig(env: EpisodeEnv): SessionSleepEpisodeConfig {
  const failureMaxAttempts = parsePositiveInt(
    env.SESSION_SLEEP_FAILURE_MAX_ATTEMPTS,
    DEFAULT_SESSION_SLEEP_FAILURE_MAX_ATTEMPTS
  );
  return {
    failureMaxAttempts,
    failureMaxElapsedMs: parsePositiveInt(
      env.SESSION_SLEEP_FAILURE_MAX_ELAPSED_MS,
      DEFAULT_SESSION_SLEEP_FAILURE_MAX_ELAPSED_MS
    ),
    // The absolute ceiling also bounds fallback retries. It is clamped above the full
    // budget so a misconfigured pair still gives the fallback at least one attempt.
    ceilingFailures: Math.max(sessionSleepMaxAttempts(env), failureMaxAttempts + 1),
  };
}

export type SessionSleepEpisodePhase = 'full' | 'fallback' | 'blocked';

export interface SessionSleepEpisodeState {
  sleepEpisodeStartedAt: string | null;
  sleepEpisodeFailures: number | null;
}

/** Why the full-snapshot phase ended, for the fallback record and logs. */
export type SessionSleepFallbackTrigger = 'attempt_budget' | 'elapsed_budget' | 'retry_ceiling';

export function sessionSleepEpisodePhase(
  row: SessionSleepEpisodeState,
  now: Date,
  config: SessionSleepEpisodeConfig
): SessionSleepEpisodePhase {
  return sessionSleepEpisodeTrigger(row, now, config) === null
    ? 'full'
    : (row.sleepEpisodeFailures ?? 0) >= config.ceilingFailures
      ? 'blocked'
      : 'fallback';
}

/**
 * Which budget ended the full phase, or null while full attempts remain. The elapsed
 * budget needs at least one failed attempt, so a session that has only ever been
 * deferred (not idle) never reaches the fallback on time alone. An unparseable episode
 * start cannot prove elapsed time; the attempt budget still bounds that row.
 */
export function sessionSleepEpisodeTrigger(
  row: SessionSleepEpisodeState,
  now: Date,
  config: SessionSleepEpisodeConfig
): SessionSleepFallbackTrigger | null {
  // NULL-safe: a row written before migration 0179's default reads as no failures.
  const failures = row.sleepEpisodeFailures ?? 0;
  if (failures >= config.ceilingFailures) return 'retry_ceiling';
  if (failures >= config.failureMaxAttempts) return 'attempt_budget';
  if (failures <= 0 || !row.sleepEpisodeStartedAt) return null;
  const startedAt = Date.parse(row.sleepEpisodeStartedAt);
  if (!Number.isFinite(startedAt)) return null;
  return now.getTime() - startedAt >= config.failureMaxElapsedMs ? 'elapsed_budget' : null;
}

/** Why a bounded episode could not release compute through the fallback. */
export type SessionSleepBlockedReason =
  /** No completed snapshot generation holds a Git commit. */
  | 'no_git_baseline'
  /** A commit is recorded but its objects were not retained (local-only hash). */
  | 'commit_objects_unavailable'
  /** The recovery point's snapshot expired. */
  | 'recovery_point_expired'
  /** The runtime cannot release compute through a Git-baseline wake (Instant). */
  | 'unsupported_runtime'
  /** Fallback attempts kept failing until the absolute ceiling. */
  | 'retry_ceiling';

const RecoveryPointSchema = v.object({
  generation: v.string(),
  commit: v.string(),
  branch: v.nullable(v.string()),
  detached: v.boolean(),
  upstream: v.nullable(v.string()),
  capturedAt: v.nullable(v.string()),
  snapshotStatus: v.string(),
  degradation: v.string(),
  workingTreeSaved: v.boolean(),
  homeSaved: v.boolean(),
});

const FallbackRecordSchema = v.object({
  version: v.literal(1),
  outcome: v.picklist(['slept', 'blocked']),
  trigger: v.picklist(['attempt_budget', 'elapsed_budget', 'retry_ceiling']),
  blockedReason: v.nullable(
    v.picklist([
      'no_git_baseline',
      'commit_objects_unavailable',
      'recovery_point_expired',
      'unsupported_runtime',
      'retry_ceiling',
    ])
  ),
  decidedAt: v.string(),
  episodeStartedAt: v.nullable(v.string()),
  failedAttempts: v.number(),
  lastError: v.nullable(v.string()),
  recoveryPoint: v.nullable(RecoveryPointSchema),
});

export type SessionSleepRecoveryPoint = v.InferOutput<typeof RecoveryPointSchema>;
export type SessionSleepFallbackRecord = v.InferOutput<typeof FallbackRecordSchema>;

/**
 * Read a stored fallback record. A malformed value is treated as absent rather than
 * thrown: it is diagnostic metadata, and a wake or a purge must not fail on it.
 */
export function parseSessionSleepFallbackRecord(
  value: string | null | undefined
): SessionSleepFallbackRecord | null {
  if (!value) return null;
  try {
    const parsed = v.safeParse(FallbackRecordSchema, JSON.parse(value) as unknown);
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

export function serializeSessionSleepFallbackRecord(record: SessionSleepFallbackRecord): string {
  return JSON.stringify(v.parse(FallbackRecordSchema, record));
}

/**
 * The record of a session that slept through the fallback on the generation it still
 * holds, or null. Its agent context is older than its conversation, so a wake must start
 * the agent fresh from the transcript. The wake prompt (`session-recovery.ts`) and the
 * restore response (`session-snapshot-restore-response.ts`) both key on this, so the wake
 * that is told to rebuild from the transcript is the one that does not load the old agent
 * session.
 */
export function sleptFallbackRecord(snapshot: {
  sleepFallbackJson: string | null;
  snapshotGeneration: string | null;
}): SessionSleepFallbackRecord | null {
  const record = parseSessionSleepFallbackRecord(snapshot.sleepFallbackJson);
  if (record?.outcome !== 'slept' || !record.recoveryPoint) return null;
  return record.recoveryPoint.generation === snapshot.snapshotGeneration ? record : null;
}

/** SQL predicate: the row's sleep episode ended blocked (`sleep_status='terminal_failed'`). */
export function blockedSleepEpisodeSql(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error('Invalid SQL alias for blocked sleep episode predicate');
  }
  return `(${alias}.sleep_status = 'terminal_failed'
    AND json_valid(${alias}.sleep_fallback_json)
    AND json_extract(${alias}.sleep_fallback_json, '$.outcome') = 'blocked')`;
}
