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
 * A hold is never inferred away from journal states or timestamps. Only a migration run that
 * completes after a successful write to the held object clears it, fenced so that a failure
 * recorded after that run started survives. A hold that no probe refreshes expires after
 * `PROJECT_DATA_ARCHIVE_CAPACITY_HOLD_MAX_MS`, so an object whose failed migrations were all
 * abandoned cannot stay closed forever. `.claude/rules/74`: the gate keys on the full object.
 */
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';

export const PROJECT_DATA_ARCHIVE_ROOT_FULL_ERROR_CODE = 'storage_full';
export const PROJECT_DATA_ARCHIVE_TARGET_FULL_ERROR_CODE = 'storage_full_target';
/** A hold no probe has refreshed for this long stops gating admission. */
export const PROJECT_DATA_ARCHIVE_DEFAULT_CAPACITY_HOLD_MAX_MS = 6 * 60 * 60 * 1000;

/** The object an archive call ran on: the project's root, or the session's target shard. */
export type ArchiveObjectRole = 'root' | 'target';

/**
 * Calls that write to their object. Their success is the evidence that clears a hold; reads
 * (inspect, export) and the usually-no-op `ensureProjectId` prove nothing about free space.
 */
export const ARCHIVE_WRITE_METHODS: Readonly<Record<ArchiveObjectRole, ReadonlySet<string>>> = {
  root: new Set([
    'archiveSourcePrepareIntent',
    'archiveSourceMarkTargetSealed',
    'archiveSourceMarkRecoveryManifestPersisted',
    'archiveSourceFinalizeDelete',
  ]),
  target: new Set(['archiveTargetPrepare', 'archiveTargetCommitChunk', 'archiveTargetSeal']),
};

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

/** Open, or refresh, the hold on the object that refused a write. Meant for `markFailed`'s batch. */
export function recordCapacityHoldStatement(
  env: Env,
  input: {
    role: ArchiveObjectRole;
    ownerName: string;
    projectId: string;
    migrationId: string;
    failedAt: number;
    activeFloor: number;
  }
): D1PreparedStatement {
  return env.DATABASE.prepare(
    `INSERT INTO project_data_archive_capacity_holds
       (object_kind, owner_name, project_id, opened_at, last_failure_at, last_failure_migration_id,
        failure_count)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(object_kind, owner_name) DO UPDATE SET
       opened_at = CASE
         WHEN project_data_archive_capacity_holds.last_failure_at <= ? THEN excluded.opened_at
         ELSE project_data_archive_capacity_holds.opened_at
       END,
       last_failure_at = MAX(project_data_archive_capacity_holds.last_failure_at, excluded.last_failure_at),
       last_failure_migration_id = excluded.last_failure_migration_id,
       failure_count = project_data_archive_capacity_holds.failure_count + 1`
  ).bind(
    input.role,
    input.ownerName,
    input.projectId,
    input.failedAt,
    input.failedAt,
    input.migrationId,
    input.activeFloor
  );
}

/**
 * Clear the holds a completed migration run disproved: only for objects it wrote to, and only if
 * no failure was recorded after the run started. Returns how many holds were cleared.
 */
export async function clearDisprovedCapacityHolds(
  env: Env,
  input: {
    rootOwnerName: string;
    targetOwnerName: string;
    wrote: Readonly<Record<ArchiveObjectRole, boolean>>;
    runStartedAt: number;
  }
): Promise<number> {
  const scopes: Array<[ArchiveObjectRole, string]> = [];
  if (input.wrote.root) scopes.push(['root', input.rootOwnerName]);
  if (input.wrote.target) scopes.push(['target', input.targetOwnerName]);
  if (scopes.length === 0) return 0;
  const result = await env.DATABASE.prepare(
    `DELETE FROM project_data_archive_capacity_holds
     WHERE (${scopes.map(() => '(object_kind = ? AND owner_name = ?)').join(' OR ')})
       AND last_failure_at < ?`
  )
    .bind(...scopes.flat(), input.runStartedAt)
    .run();
  return result.meta.changes ?? 0;
}
