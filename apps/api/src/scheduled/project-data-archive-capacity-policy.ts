/**
 * Capacity backpressure for ProjectData archive sharding.
 *
 * A full Durable Object is environmental. While a project's root object is at Cloudflare's
 * per-object cap, every archive attempt for that project fails at its first root write, and a
 * failed journal keeps its session fenced `migrating` (unreadable) until a retry succeeds.
 * Capacity failures therefore never poison (`isArchiveStorageFullFailure`). Admitting more
 * sessions into a full object would only fence more of them. Retrying every capacity-failed
 * journal on every tick would let one full object take the sweep's slots from healthy work
 * elsewhere.
 *
 * So a capacity failure records a durable HOLD on the object that refused the write: the
 * project's root, or one target archive shard (`project_data_archive_capacity_holds`). The call
 * that failed names the object, because every coordinator stub tags its failures
 * (`tagArchiveObjectFailure`); the journal state alone cannot, since a resumed journal
 * re-prepares the source on the root before it touches the target again. While a hold is active:
 * - admission fences no new session that would write to the held object, and
 * - reclaim retries only the oldest capacity-failed journal of that object: one probe, paced by
 *   the failed-retry delay.
 *
 * A hold is never inferred away from what a migration happened to write: replays and cached
 * results make that unreliable. Each sweep instead probes held objects (`probeCapacityHolds`):
 * one read of the object's own `databaseSize`. Headroom below the hard cap clears the hold,
 * fenced so that a failure recorded after the probe started survives; no headroom refreshes it.
 * A hold that nothing refreshes still lapses after `PROJECT_DATA_ARCHIVE_CAPACITY_HOLD_MAX_MS`,
 * so a probe that keeps failing cannot strand a project. `.claude/rules/74`: the gate keys on
 * the full object, measured.
 */
import type { Env } from '../env';
import { createModuleLogger, serializeError } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { DEFAULT_PROJECT_DATA_STORAGE_HARD_CAP_BYTES } from './project-data-storage-alerts';

const log = createModuleLogger('scheduled.project_data_archive_capacity_policy');

export const PROJECT_DATA_ARCHIVE_ROOT_FULL_ERROR_CODE = 'storage_full';
export const PROJECT_DATA_ARCHIVE_TARGET_FULL_ERROR_CODE = 'storage_full_target';
/** A hold nothing has refreshed for this long stops gating admission. */
export const PROJECT_DATA_ARCHIVE_DEFAULT_CAPACITY_HOLD_MAX_MS = 6 * 60 * 60 * 1000;
/** Room below the hard cap a held object must show before its hold clears. */
export const PROJECT_DATA_ARCHIVE_DEFAULT_CAPACITY_HOLD_CLEAR_HEADROOM_BYTES = 64 * 1024 * 1024;
/** Held objects probed per sweep; the rest wait for the next sweep. */
export const PROJECT_DATA_ARCHIVE_DEFAULT_CAPACITY_PROBES_PER_TICK = 10;

/** The object an archive call ran on: the project's root, or the session's target shard. */
export type ArchiveObjectRole = 'root' | 'target';

/** Journal states whose next write usually lands on the target archive shard. */
const TARGET_WRITE_STATES: ReadonlySet<string> = new Set([
  'intent_prepared',
  'target_prepared',
  'copying',
]);

const FAILED_OBJECT = Symbol('archiveFailedObject');

/**
 * Record on a failed call's error which object it ran on. The coordinator's stubs do this for
 * every call (`ownerStub` in project-data-archive-sharding.ts), and the first tag wins.
 */
export function tagArchiveObjectFailure(error: unknown, role: ArchiveObjectRole): unknown {
  if (error !== null && typeof error === 'object' && !(FAILED_OBJECT in error)) {
    try {
      Object.defineProperty(error, FAILED_OBJECT, { value: role });
    } catch {
      // A frozen error keeps no tag; `archiveCapacityRole` falls back to the journal state.
    }
  }
  return error;
}

/**
 * The object behind a capacity failure: the one the failing call ran on. The journal state is
 * only the fallback for an untagged error.
 */
export function archiveCapacityRole(error: unknown, journalState: string): ArchiveObjectRole {
  const role =
    error !== null && typeof error === 'object'
      ? (error as { [FAILED_OBJECT]?: unknown })[FAILED_OBJECT]
      : undefined;
  if (role === 'root' || role === 'target') return role;
  return TARGET_WRITE_STATES.has(journalState) ? 'target' : 'root';
}

export function archiveCapacityErrorCode(role: ArchiveObjectRole): string {
  return role === 'target'
    ? PROJECT_DATA_ARCHIVE_TARGET_FULL_ERROR_CODE
    : PROJECT_DATA_ARCHIVE_ROOT_FULL_ERROR_CODE;
}

/**
 * At least two failed-retry delays, so the probe (paced by that delay) refreshes an active hold
 * before it can expire while its object is still full.
 */
export function resolveCapacityHoldMaxMs(
  env: Pick<Env, 'PROJECT_DATA_ARCHIVE_CAPACITY_HOLD_MAX_MS'>,
  failedRetryDelayMs: number
): number {
  const configured = parsePositiveInt(
    env.PROJECT_DATA_ARCHIVE_CAPACITY_HOLD_MAX_MS,
    PROJECT_DATA_ARCHIVE_DEFAULT_CAPACITY_HOLD_MAX_MS
  );
  return Math.max(configured, failedRetryDelayMs * 2);
}

/**
 * True while the object is NOT under an active hold. `ownerName` is a SQL expression: `'?'` binds
 * one parameter, or an outer column such as `ss.project_id` (a root's owner name is its project
 * id). Then binds the active floor (`now - holdMaxMs`).
 */
export function capacityHoldClearSql(role: ArchiveObjectRole, ownerName: string): string {
  return `NOT EXISTS (
    SELECT 1
    FROM project_data_archive_capacity_holds hold
    WHERE hold.object_kind = '${role}'
      AND hold.owner_name = ${ownerName}
      AND hold.last_failure_at > ?
  )`;
}

const ROOT = PROJECT_DATA_ARCHIVE_ROOT_FULL_ERROR_CODE;
const TARGET = PROJECT_DATA_ARCHIVE_TARGET_FULL_ERROR_CODE;

/**
 * Reclaim filter over the outer journal alias `m`: while its object is held, a capacity-failed
 * journal is retried only when it is the oldest one for that object, so a full object costs the
 * sweep at most one slot. Each failed probe restamps its row, so they take turns. Binds the
 * active floor once.
 */
export const ONE_CAPACITY_PROBE_PER_HELD_OBJECT_SQL = `AND NOT (
    m.state = 'failed'
    AND m.error_code IN ('${ROOT}', '${TARGET}')
    AND EXISTS (
      SELECT 1
      FROM project_data_archive_capacity_holds hold
      WHERE hold.object_kind = CASE m.error_code WHEN '${ROOT}' THEN 'root' ELSE 'target' END
        AND hold.owner_name = CASE m.error_code
          WHEN '${ROOT}' THEN m.source_owner_name
          ELSE m.target_owner_name
        END
        AND hold.last_failure_at > ?
    )
    AND EXISTS (
      SELECT 1
      FROM project_data_archive_migrations older
      WHERE older.project_id = m.project_id
        AND older.state = 'failed'
        AND older.error_code = m.error_code
        AND (m.error_code = '${ROOT}' OR older.target_owner_name = m.target_owner_name)
        AND (
          older.updated_at < m.updated_at
          OR (older.updated_at = m.updated_at AND older.migration_id < m.migration_id)
        )
    )
  )`;

/**
 * Open, or refresh, the hold on the object that refused a write. Meant to follow `markFailed`'s
 * journal UPDATE in the same batch, and conditioned on it: only a journal this handler actually
 * moved to `failed` with this capacity code (and this tick's `journalUpdatedAt`) counts, so a
 * stale handler whose fenced UPDATE changed nothing cannot hold an object a successor proved fine.
 */
export function recordCapacityHoldStatement(
  env: Env,
  input: {
    role: ArchiveObjectRole;
    ownerName: string;
    projectId: string;
    migrationId: string;
    errorCode: string;
    journalUpdatedAt: number;
    failedAt: number;
    activeFloor: number;
  }
): D1PreparedStatement {
  return env.DATABASE.prepare(
    `INSERT INTO project_data_archive_capacity_holds
       (object_kind, owner_name, project_id, opened_at, last_failure_at, last_failure_migration_id,
        failure_count)
     SELECT ?, ?, ?, ?, ?, ?, 1
     WHERE EXISTS (
       SELECT 1 FROM project_data_archive_migrations
       WHERE migration_id = ? AND state = 'failed' AND error_code = ? AND updated_at = ?
     )
     ON CONFLICT(object_kind, owner_name) DO UPDATE SET
       opened_at = CASE
         WHEN project_data_archive_capacity_holds.last_failure_at <= ? THEN excluded.opened_at
         ELSE project_data_archive_capacity_holds.opened_at
       END,
       last_failure_at = MAX(project_data_archive_capacity_holds.last_failure_at, excluded.last_failure_at),
       last_failure_migration_id = CASE
         WHEN excluded.last_failure_at >= project_data_archive_capacity_holds.last_failure_at
           THEN excluded.last_failure_migration_id
         ELSE project_data_archive_capacity_holds.last_failure_migration_id
       END,
       failure_count = project_data_archive_capacity_holds.failure_count + 1`
  ).bind(
    input.role,
    input.ownerName,
    input.projectId,
    input.failedAt,
    input.failedAt,
    input.migrationId,
    input.migrationId,
    input.errorCode,
    input.journalUpdatedAt,
    input.activeFloor
  );
}

export interface CapacityProbeConfig {
  hardCapBytes: number;
  clearHeadroomBytes: number;
  probesPerTick: number;
}

export function resolveCapacityProbeConfig(
  env: Pick<
    Env,
    | 'PROJECT_DATA_STORAGE_HARD_CAP_BYTES'
    | 'PROJECT_DATA_ARCHIVE_CAPACITY_HOLD_CLEAR_HEADROOM_BYTES'
    | 'PROJECT_DATA_ARCHIVE_CAPACITY_PROBES_PER_TICK'
  >
): CapacityProbeConfig {
  return {
    hardCapBytes: parsePositiveInt(
      env.PROJECT_DATA_STORAGE_HARD_CAP_BYTES,
      DEFAULT_PROJECT_DATA_STORAGE_HARD_CAP_BYTES
    ),
    clearHeadroomBytes: parsePositiveInt(
      env.PROJECT_DATA_ARCHIVE_CAPACITY_HOLD_CLEAR_HEADROOM_BYTES,
      PROJECT_DATA_ARCHIVE_DEFAULT_CAPACITY_HOLD_CLEAR_HEADROOM_BYTES
    ),
    probesPerTick: parsePositiveInt(
      env.PROJECT_DATA_ARCHIVE_CAPACITY_PROBES_PER_TICK,
      PROJECT_DATA_ARCHIVE_DEFAULT_CAPACITY_PROBES_PER_TICK
    ),
  };
}

export interface CapacityProbeStats {
  probed: number;
  cleared: number;
  stillFull: number;
  failed: number;
}

/**
 * Measure each active hold's object and act on the measurement: headroom below the hard cap
 * clears the hold, unless a failure was recorded after the probe started; no headroom refreshes
 * it, so a full object stays held for as long as it is full. A probe that throws changes nothing
 * and is retried next sweep. Oldest refresh first, so every hold is probed in turn.
 */
export async function probeCapacityHolds(
  env: Env,
  input: {
    now: number;
    holdMaxMs: number;
    config: CapacityProbeConfig;
    measure: (ownerName: string, projectId: string) => Promise<number>;
  }
): Promise<CapacityProbeStats> {
  const stats: CapacityProbeStats = { probed: 0, cleared: 0, stillFull: 0, failed: 0 };
  const holds = await env.DATABASE.prepare(
    `SELECT object_kind, owner_name, project_id
     FROM project_data_archive_capacity_holds
     WHERE last_failure_at > ?
     ORDER BY last_failure_at ASC, object_kind ASC, owner_name ASC
     LIMIT ?`
  )
    .bind(input.now - input.holdMaxMs, input.config.probesPerTick)
    .all<{ object_kind: ArchiveObjectRole; owner_name: string; project_id: string }>();
  const ceiling = input.config.hardCapBytes - input.config.clearHeadroomBytes;
  for (const hold of holds.results ?? []) {
    stats.probed++;
    // Wall clock: a failure recorded after this instant must survive the clear.
    const probeStartedAt = Date.now();
    let databaseSizeBytes: number;
    try {
      databaseSizeBytes = await input.measure(hold.owner_name, hold.project_id);
    } catch (error) {
      stats.failed++;
      log.warn('project_data_archive_capacity_probe_failed', {
        objectKind: hold.object_kind,
        ownerName: hold.owner_name,
        projectId: hold.project_id,
        ...serializeError(error),
      });
      continue;
    }
    if (databaseSizeBytes <= ceiling) {
      const cleared = await env.DATABASE.prepare(
        `DELETE FROM project_data_archive_capacity_holds
         WHERE object_kind = ? AND owner_name = ? AND last_failure_at < ?`
      )
        .bind(hold.object_kind, hold.owner_name, probeStartedAt)
        .run();
      if ((cleared.meta.changes ?? 0) > 0) {
        stats.cleared++;
        log.info('project_data_archive_capacity_hold_cleared', {
          objectKind: hold.object_kind,
          ownerName: hold.owner_name,
          projectId: hold.project_id,
          databaseSizeBytes,
          ceilingBytes: ceiling,
        });
      }
      continue;
    }
    stats.stillFull++;
    await env.DATABASE.prepare(
      `UPDATE project_data_archive_capacity_holds
       SET last_failure_at = MAX(last_failure_at, ?)
       WHERE object_kind = ? AND owner_name = ?`
    )
      .bind(probeStartedAt, hold.object_kind, hold.owner_name)
      .run();
  }
  return stats;
}
