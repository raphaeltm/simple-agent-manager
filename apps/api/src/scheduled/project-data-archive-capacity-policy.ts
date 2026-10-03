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
 * So a capacity failure is recorded against the object that refused the write: the root
 * (`storage_full`, project-wide) or one target archive shard (`storage_full_target`). Until a
 * later attempt in that scope gets past the write that failed:
 * - admission fences no new session that would write to the full object, and
 * - reclaim retries only the oldest capacity-failed journal of that scope: one probe, paced
 *   by the failed-retry delay.
 * A probe that succeeds is the recovery signal. From then on the scope admits again, and its
 * other capacity-failed journals retry at the normal pace. `.claude/rules/74`: the gate keys
 * on the full object, not on the project as a whole or on how many sessions failed.
 */

export const PROJECT_DATA_ARCHIVE_ROOT_FULL_ERROR_CODE = 'storage_full';
export const PROJECT_DATA_ARCHIVE_TARGET_FULL_ERROR_CODE = 'storage_full_target';

/** Journal states whose next write usually lands on the target archive shard (prepare, copy, seal). */
const TARGET_WRITE_STATES: ReadonlySet<string> = new Set([
  'intent_prepared',
  'target_prepared',
  'copying',
]);

/** The object an archive call ran on: the project's root, or the session's target shard. */
export type ArchiveObjectRole = 'root' | 'target';

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
      // A frozen error keeps no tag; `archiveCapacityErrorCode` falls back to the journal state.
    }
  }
  return error;
}

/**
 * Which object refused a capacity failure: the object the failing call ran on. The journal state
 * cannot say this on its own, because a resumed journal (`intent_prepared`, `target_prepared`,
 * `copying`) re-prepares the source on the root before it touches the target again; it is only
 * the fallback for an untagged error.
 */
export function archiveCapacityErrorCode(error: unknown, journalState: string): string {
  const role =
    error !== null && typeof error === 'object'
      ? (error as { [FAILED_OBJECT]?: unknown })[FAILED_OBJECT]
      : undefined;
  if (role === 'root') return PROJECT_DATA_ARCHIVE_ROOT_FULL_ERROR_CODE;
  if (role === 'target') return PROJECT_DATA_ARCHIVE_TARGET_FULL_ERROR_CODE;
  return TARGET_WRITE_STATES.has(journalState)
    ? PROJECT_DATA_ARCHIVE_TARGET_FULL_ERROR_CODE
    : PROJECT_DATA_ARCHIVE_ROOT_FULL_ERROR_CODE;
}

const ROOT = PROJECT_DATA_ARCHIVE_ROOT_FULL_ERROR_CODE;
const TARGET = PROJECT_DATA_ARCHIVE_TARGET_FULL_ERROR_CODE;

/**
 * States a journal reaches only after the write a capacity failure refused succeeded in the
 * same run: past the source prepare for the root (a run always re-prepares the source before
 * the target), past the seal for a target shard.
 */
const ROOT_RECOVERED_STATES = `('target_prepared', 'copying', 'target_sealed', 'recovery_manifest_persisted', 'source_deleted', 'published')`;
const TARGET_RECOVERED_STATES = `('target_sealed', 'recovery_manifest_persisted', 'source_deleted', 'published')`;

/**
 * Correlated predicate: journal `alias` is a capacity failure that no later attempt in its
 * scope has recovered from. `error_code` survives later transitions, so a probe that moved on
 * still carries the code that names its scope. No binds.
 */
function currentCapacityFailureSql(alias: string): string {
  return `${alias}.state = 'failed'
    AND ${alias}.error_code IN ('${ROOT}', '${TARGET}')
    AND NOT EXISTS (
      SELECT 1
      FROM project_data_archive_migrations recovered
      WHERE recovered.project_id = ${alias}.project_id
        AND recovered.error_code = ${alias}.error_code
        AND recovered.updated_at >= ${alias}.updated_at
        AND (
          (${alias}.error_code = '${ROOT}' AND recovered.state IN ${ROOT_RECOVERED_STATES})
          OR (
            ${alias}.error_code = '${TARGET}'
            AND recovered.target_owner_name = ${alias}.target_owner_name
            AND recovered.state IN ${TARGET_RECOVERED_STATES}
          )
        )
    )`;
}

/**
 * True while the project's root object accepts archive writes. `projectId` is a SQL
 * expression: `'?'` binds one parameter, or an outer column such as `ss.project_id`.
 */
export function projectRootAcceptingArchiveWritesSql(projectId: string): string {
  return `NOT EXISTS (
    SELECT 1
    FROM project_data_archive_migrations cap
    WHERE cap.project_id = ${projectId}
      AND cap.error_code = '${ROOT}'
      AND ${currentCapacityFailureSql('cap')}
  )`;
}

/** True while one target archive shard accepts writes. Binds: project id, target owner name. */
export const TARGET_SHARD_ACCEPTING_ARCHIVE_WRITES_SQL = `NOT EXISTS (
    SELECT 1
    FROM project_data_archive_migrations cap
    WHERE cap.project_id = ?
      AND cap.target_owner_name = ?
      AND cap.error_code = '${TARGET}'
      AND ${currentCapacityFailureSql('cap')}
  )`;

/**
 * Reclaim filter over the outer journal alias `m`: a current capacity failure is retried only
 * when it is the oldest one in its scope, so a full object costs the sweep at most one slot.
 * Each failed probe restamps its row, so the scope's failures take turns. No binds.
 */
export const ONE_CAPACITY_PROBE_PER_SCOPE_SQL = `AND NOT (
    ${currentCapacityFailureSql('m')}
    AND EXISTS (
      SELECT 1
      FROM project_data_archive_migrations older
      WHERE older.project_id = m.project_id
        AND older.error_code = m.error_code
        AND (m.error_code = '${ROOT}' OR older.target_owner_name = m.target_owner_name)
        AND ${currentCapacityFailureSql('older')}
        AND (
          older.updated_at < m.updated_at
          OR (older.updated_at = m.updated_at AND older.migration_id < m.migration_id)
        )
    )
  )`;
