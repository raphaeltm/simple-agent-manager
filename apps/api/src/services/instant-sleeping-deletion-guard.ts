/**
 * A sleeping Instant (cf-container) workspace is its chat's wake target, not leftover compute.
 *
 * Instant sleeps in place: the container Durable Object sleeps, and a follow-up wakes that same
 * container from its snapshot (`resolveSleepingContainerTarget` in
 * `vm-prompt-delivery-target.ts`, then `ensureAwake`). A slept container bills nothing, so the
 * sleep writer never queues it for deletion (`scheduleSleepingWorkspaceDeletion` returns early
 * for cf-container), and its teardown belongs to the snapshot purge once retention ends
 * (`scheduled/session-snapshot-purge.ts`). Only a deliberate deletion may destroy it earlier: an
 * explicit delete or archive (queue entries in `explicit` mode), or the end of an anonymous trial
 * (`scheduled/trial-expire.ts`, which claims directly and never goes through the guarded paths).
 *
 * A sleeping VM is different: its VM must be released, and the snapshot carries the wake to a
 * replacement. That is why the guard is runtime-specific rather than a change to the
 * deletion-eligible status set, which still includes `sleeping` for VMs.
 *
 * On staging (2026-11-03 to 11-08), the stale-workspace safety net queued these rows. Every
 * attempt failed, the automatic claim left the workspace `stopping`, and the next follow-up was
 * refused with "The sleeping container runtime is gone".
 */
import { WORKSPACE_DELETION_DIAGNOSTIC_PREFIX } from './workspace-deletion';

/**
 * True when the workspace row aliased `workspaceAlias` still has a wakeable sleeping Instant
 * runtime: a `cf-container` node that is `sleeping` with no termination proof, no confirmed
 * runtime deletion, and this chat's snapshot marked `sleeping`. It mirrors the resumer's
 * precondition rather than a status label (`.claude/rules/58`). Self-contained, so it is never
 * NULL under a LEFT JOIN.
 */
export function wakeableSleepingInstantSql(workspaceAlias: string): string {
  const w = workspaceAlias;
  return `EXISTS (
    SELECT 1 FROM nodes wake_node
    JOIN session_snapshots wake_snapshot
      ON wake_snapshot.workspace_id = ${w}.id
     AND wake_snapshot.node_id = wake_node.id
    WHERE wake_node.id = ${w}.node_id
      AND wake_node.user_id = ${w}.user_id
      AND wake_node.runtime = 'cf-container'
      AND wake_node.status = 'sleeping'
      AND wake_node.runtime_termination_confirmed_at IS NULL
      AND ${w}.runtime_deletion_confirmed_at IS NULL
      AND wake_snapshot.user_id = ${w}.user_id
      AND wake_snapshot.chat_session_id = ${w}.chat_session_id
      AND wake_snapshot.runtime = 'cf-container'
      AND wake_snapshot.sleep_status = 'sleeping'
  )`;
}

/**
 * A `stopping` row that a deletion claim put there: the claim and every failed attempt write
 * the deletion diagnostic, and none of them touched the node (still `sleeping`, which
 * `wakeableSleepingInstantSql` requires).
 */
const STOPPED_BY_DELETION_CLAIM_SQL = `substr(COALESCE(error_message, ''), 1, length(?)) = ?`;

/** The wake target as observed, so a repair can compare-and-set on exactly this row state. */
export interface WakeableSleepingInstant {
  status: 'sleeping' | 'stopping';
  errorMessage: string | null;
  updatedAt: string | null;
}

/** The wake target, or null when the workspace is not a wakeable sleeping Instant. */
export async function findWakeableSleepingInstant(
  database: D1Database,
  workspaceId: string
): Promise<WakeableSleepingInstant | null> {
  const row = await database
    .prepare(
      `SELECT status, error_message AS errorMessage, updated_at AS updatedAt FROM workspaces
        WHERE id = ?
          AND (status = 'sleeping' OR (status = 'stopping' AND ${STOPPED_BY_DELETION_CLAIM_SQL}))
          AND ${wakeableSleepingInstantSql('workspaces')}
        LIMIT 1`
    )
    .bind(workspaceId, WORKSPACE_DELETION_DIAGNOSTIC_PREFIX, WORKSPACE_DELETION_DIAGNOSTIC_PREFIX)
    .first<WakeableSleepingInstant>();
  return row ?? null;
}

/**
 * Return a wake target that a failed automatic deletion left `stopping` to `sleeping`, so the
 * next follow-up wakes it in place. It compares-and-sets on the row exactly as `observed`:
 * any claim that started since (explicit or automatic) rewrites `error_message` and
 * `updated_at` before its first external call, so it is never reverted. The wake predicate
 * runs inside the UPDATE too, so a destroy claim, a confirmed deletion or a wake in between
 * also leaves the row alone.
 */
export async function restoreWakeableSleepingInstant(
  database: D1Database,
  workspaceId: string,
  observed: WakeableSleepingInstant,
  nowIso: string
): Promise<boolean> {
  if (observed.status !== 'stopping') return false;
  const result = await database
    .prepare(
      `UPDATE workspaces
          SET status = 'sleeping', error_message = NULL, updated_at = ?
        WHERE id = ?
          AND status = 'stopping'
          AND error_message IS ?
          AND updated_at IS ?
          AND ${STOPPED_BY_DELETION_CLAIM_SQL}
          AND ${wakeableSleepingInstantSql('workspaces')}`
    )
    .bind(
      nowIso,
      workspaceId,
      observed.errorMessage,
      observed.updatedAt,
      WORKSPACE_DELETION_DIAGNOSTIC_PREFIX,
      WORKSPACE_DELETION_DIAGNOSTIC_PREFIX
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}
