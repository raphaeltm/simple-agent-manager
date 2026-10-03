/**
 * Circuit-breaker policy for ProjectData archive sharding.
 *
 * A poisoned migration quarantines its own session: the location becomes `frozen`, which
 * candidate selection (`location_state = 'root'`) and reclaim (`ACTIVE_RECLAIMABLE_STATES`)
 * already exclude. A project breaker that opened on that one poison therefore stopped only the
 * project's OTHER sessions; on 2026-09-27 one `CompactArchiveTimeoutError` did that for five
 * days and the SAM root ProjectData object reached Cloudflare's hard 10 GiB cap. The breaker
 * exists for systemic failure, so it opens only when several distinct sessions are poisoned
 * inside a window (`.claude/rules/74`: key the gate on its condition).
 *
 * Manual controls stay authoritative: an operator `frozen` breaker is never overwritten.
 */
import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { isDurableObjectStorageFullError } from '../services/durable-object-retry';
import { PROJECT_DATA_STORAGE_FULL } from '../services/project-data-storage-errors';

const log = createModuleLogger('scheduled.project_data_archive_breaker_policy');

/** Distinct sessions poisoned inside the window before the PROJECT breaker opens. */
export const PROJECT_DATA_ARCHIVE_DEFAULT_BREAKER_POISON_THRESHOLD = 3;
const PROJECT_DATA_ARCHIVE_MAX_BREAKER_POISON_THRESHOLD = 100;
export const PROJECT_DATA_ARCHIVE_DEFAULT_BREAKER_POISON_WINDOW_MS = 24 * 60 * 60 * 1000;
const PROJECT_DATA_ARCHIVE_MIN_BREAKER_POISON_WINDOW_MS = 60 * 1000;
const PROJECT_DATA_ARCHIVE_MAX_BREAKER_POISON_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface BreakerPoisonPolicy {
  breakerPoisonThreshold: number;
  breakerPoisonWindowMs: number;
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = parsePositiveInt(raw, fallback);
  return parsed < min ? fallback : Math.min(parsed, max);
}

export function resolveBreakerPoisonPolicy(
  env: Pick<
    Env,
    'PROJECT_DATA_ARCHIVE_BREAKER_POISON_THRESHOLD' | 'PROJECT_DATA_ARCHIVE_BREAKER_POISON_WINDOW_MS'
  >
): BreakerPoisonPolicy {
  return {
    breakerPoisonThreshold: boundedInt(
      env.PROJECT_DATA_ARCHIVE_BREAKER_POISON_THRESHOLD,
      PROJECT_DATA_ARCHIVE_DEFAULT_BREAKER_POISON_THRESHOLD,
      1,
      PROJECT_DATA_ARCHIVE_MAX_BREAKER_POISON_THRESHOLD
    ),
    breakerPoisonWindowMs: boundedInt(
      env.PROJECT_DATA_ARCHIVE_BREAKER_POISON_WINDOW_MS,
      PROJECT_DATA_ARCHIVE_DEFAULT_BREAKER_POISON_WINDOW_MS,
      PROJECT_DATA_ARCHIVE_MIN_BREAKER_POISON_WINDOW_MS,
      PROJECT_DATA_ARCHIVE_MAX_BREAKER_POISON_WINDOW_MS
    ),
  };
}

/**
 * A full Durable Object (root or target shard) is environmental, not a property of the
 * session: at the 10 GiB cap every journal write fails for every candidate. Counting those
 * failures toward poisoning let the full object poison the drain that is the only thing able
 * to empty it (2026-09-03 09:51Z), so capacity failures never poison and do not spend the
 * attempt budget. The DO surfaces the condition as its message; the API wrapper as
 * `PROJECT_DATA_STORAGE_FULL`.
 */
export function isArchiveStorageFullFailure(error: unknown): boolean {
  if (isDurableObjectStorageFullError(error)) return true;
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'ProjectDataStorageFullError' ||
    (error as { error?: unknown }).error === PROJECT_DATA_STORAGE_FULL
  );
}

/**
 * SQL predicate that is true while the project's breaker is closed (no row counts as closed).
 * Binds one parameter: the project id. Candidate admission uses it so a breaker that opens
 * mid-tick, or an operator freeze, cannot leave newly fenced sessions behind it.
 */
export const PROJECT_ARCHIVE_BREAKER_CLOSED_SQL = `COALESCE(
  (SELECT state FROM project_data_archive_circuit_breakers WHERE project_id = ?),
  'closed'
) = 'closed'`;

/**
 * Poison one migration and quarantine its session. The project breaker opens only when
 * `breakerPoisonThreshold` distinct sessions of the project were poisoned inside
 * `breakerPoisonWindowMs` and since the breaker was last closed. Poison time is the stable
 * `poisoned_at` event, so a poison that was later abandoned still counts inside the window.
 */
export async function poisonProjectDataArchiveMigration(
  env: Env,
  input: {
    migrationId: string;
    projectId: string;
    reason: string;
    message?: string;
    now?: number;
    breakerPolicy?: BreakerPoisonPolicy;
  }
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const policy = input.breakerPolicy ?? resolveBreakerPoisonPolicy(env);
  const result = await env.DATABASE.prepare(
    `UPDATE project_data_archive_migrations
     SET state = 'poisoned',
         error_code = ?,
         error_message = ?,
         lease_owner = NULL,
         lease_expires_at = NULL,
         poisoned_at = COALESCE(poisoned_at, ?),
         updated_at = ?
     WHERE migration_id = ?
       AND project_id = ?
       AND state NOT IN ('source_deleted', 'published', 'poisoned')`
  )
    .bind(input.reason, input.message ?? input.reason, now, now, input.migrationId, input.projectId)
    .run();
  // A zero-row poison (already poisoned, or terminal) must neither freeze a location nor
  // re-evaluate the breaker: it was counted when it was poisoned, and a replayed failure must
  // not re-open a breaker an operator has since closed.
  if ((result.meta.changes ?? 0) === 0) return false;

  await env.DATABASE.prepare(
    `UPDATE project_data_session_locations
     SET location_state = 'frozen',
         updated_at = ?
     WHERE migration_id = ?
       AND project_id = ?
       AND location_state = 'migrating'`
  )
    .bind(now, input.migrationId, input.projectId)
    .run();

  const breaker = await env.DATABASE.prepare(
    `SELECT state, updated_at FROM project_data_archive_circuit_breakers WHERE project_id = ?`
  )
    .bind(input.projectId)
    .first<{ state: string; updated_at: number }>();
  const lastClosedAt = breaker?.state === 'closed' ? breaker.updated_at : 0;
  const windowStart = Math.max(now - policy.breakerPoisonWindowMs, lastClosedAt);
  const poisoned = await env.DATABASE.prepare(
    `SELECT COUNT(DISTINCT session_id) AS sessions
     FROM project_data_archive_migrations
     WHERE project_id = ?
       AND poisoned_at IS NOT NULL
       AND poisoned_at >= ?`
  )
    .bind(input.projectId, windowStart)
    .first<{ sessions: number }>();
  const poisonedSessions = poisoned?.sessions ?? 0;
  const opensBreaker = poisonedSessions >= policy.breakerPoisonThreshold;
  log.warn('project_data_archive_migration_poisoned', {
    migrationId: input.migrationId,
    projectId: input.projectId,
    reason: input.reason,
    poisonedSessions,
    breakerPoisonThreshold: policy.breakerPoisonThreshold,
    breakerPoisonWindowMs: policy.breakerPoisonWindowMs,
    previousBreakerState: breaker?.state ?? 'none',
    action: opensBreaker ? 'quarantined_session_and_opened_breaker' : 'quarantined_session',
  });
  if (!opensBreaker) return true;

  const breakerReason = `poison_threshold:${poisonedSessions}/${policy.breakerPoisonThreshold}:${input.reason}`;
  await env.DATABASE.prepare(
    `INSERT INTO project_data_archive_circuit_breakers (project_id, state, reason, opened_at, updated_at)
     VALUES (?, 'open', ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       state = 'open',
       reason = excluded.reason,
       opened_at = COALESCE(project_data_archive_circuit_breakers.opened_at, excluded.opened_at),
       updated_at = excluded.updated_at
     WHERE project_data_archive_circuit_breakers.state != 'frozen'`
  )
    .bind(input.projectId, breakerReason, now, now)
    .run();
  if (breaker?.state !== 'open' && breaker?.state !== 'frozen') {
    log.error('project_data_archive_breaker_opened', {
      projectId: input.projectId,
      migrationId: input.migrationId,
      previousState: breaker?.state ?? 'none',
      reason: breakerReason,
      poisonedSessions,
      breakerPoisonThreshold: policy.breakerPoisonThreshold,
    });
  }
  return true;
}
