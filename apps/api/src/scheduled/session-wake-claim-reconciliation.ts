/**
 * End VM wake claims whose wake has died.
 *
 * A wake holds `session_snapshots.recovery_status = 'waking'`. Only the TaskRunner that
 * owns the attempt ends that claim (`failRecoveryLifecycle` → `failSessionSnapshotRecovery`,
 * or `markSessionSnapshotRestored`). When that runner stops partway, or another actor
 * terminalizes its task, the claim outlives its attempt: the chat shows a wake banner
 * forever, and with no `recovery_failed_at` the attempt budget never decays
 * (`session-snapshot-recovery-budget.ts`). Production held such claims for weeks (idea
 * 01M6M7AN6G8WTHRYACB9ZS0BGV, task file 2026-11-08-stalled-session-wakes-sweep.md).
 *
 * The verdict reads the record the resumer reads (rule 58). `claimSessionSnapshotRecovery`
 * renews a stale claim only while its recovery task is in `LIVE_WAKE_TASK_STATUSES`, and
 * otherwise re-claims it on the next wake attempt. This sweep ends exactly those claims,
 * with one extra condition: the task must also have been unchanged for a full claim lease.
 * The resumer can re-claim at once because it starts a new wake. The sweep only records
 * that the old one is over, and must not release the claim while the owning runner may
 * still be inside its failure cleanup ("Keep recovery_status=waking until both the session
 * and replacement cleanup converge" in `recovery-failure-cleanup.ts`).
 *
 * Every release is a compare-and-set on the exact claim that was selected (task,
 * `recovery_attempt_id`, stale claim time) plus the live-task predicate, evaluated again
 * inside the write, so a live or newly claimed wake can never lose to the sweep.
 *
 * I/O per tick: one cached settings read, one bounded SELECT, at most one D1 batch of N
 * compare-and-sets, and N best-effort ProjectData pushes in `waitUntil`
 * (N ≤ `operations.deadWakeReconcileBatchSize`).
 */
import { notifyWakeSettled } from '../durable-objects/task-runner/wake-progress-notifier';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveAdminSettingDetailsMany } from '../services/admin-settings';
import { sessionLifecycleError } from '../services/session-snapshot-artifacts';
import {
  LIVE_WAKE_TASK_STATUS_SQL,
  sessionRecoveryClaimLeaseMs,
} from '../services/session-snapshot-recovery-conditions';

/** Shown in the wake banner and recorded on the snapshot. */
export const DEAD_WAKE_CLAIM_ERROR =
  'The last wake attempt stopped without finishing. Send a message to wake this chat again.';

interface DeadWakeCandidate {
  id: string;
  projectId: string;
  chatSessionId: string;
  recoveryTaskId: string | null;
  recoveryAttemptId: string | null;
  recoveryClaimedAt: string | null;
  taskStatus: string | null;
  taskUpdatedAt: string | null;
}

export interface DeadWakeReconciliationResult {
  selected: number;
  released: number;
}

/**
 * A claim is stale when it is older than the lease, and its task is missing, or is not
 * live and has not changed for a full lease. `snapshot` and `task` are the SQL aliases.
 */
const DEAD_WAKE_CLAIM_SQL = `
  snapshot.recovery_status = 'waking' AND snapshot.runtime = 'vm'
  AND (snapshot.recovery_claimed_at IS NULL
    OR julianday(snapshot.recovery_claimed_at) <= julianday(?))
  AND NOT EXISTS (
    SELECT 1 FROM tasks task WHERE task.id = snapshot.recovery_task_id
      AND (task.status IN (${LIVE_WAKE_TASK_STATUS_SQL})
        OR julianday(task.updated_at) IS NULL
        OR julianday(task.updated_at) > julianday(?))
  )`;

export async function runDeadWakeClaimReconciliation(
  env: Env,
  waitUntil: (promise: Promise<unknown>) => void,
  now = new Date()
): Promise<DeadWakeReconciliationResult> {
  const [batchSetting] = await resolveAdminSettingDetailsMany(env, [
    'operations.deadWakeReconcileBatchSize',
  ]);
  if (!batchSetting) throw new Error('Dead wake reconciliation settings are unavailable');
  const batchSize = Number(batchSetting.value);
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - sessionRecoveryClaimLeaseMs(env)).toISOString();

  const rows = await env.DATABASE.prepare(
    `SELECT snapshot.id AS id, snapshot.project_id AS projectId,
            snapshot.chat_session_id AS chatSessionId,
            snapshot.recovery_task_id AS recoveryTaskId,
            snapshot.recovery_attempt_id AS recoveryAttemptId,
            snapshot.recovery_claimed_at AS recoveryClaimedAt,
            recovery.status AS taskStatus, recovery.updated_at AS taskUpdatedAt
       FROM session_snapshots snapshot
       LEFT JOIN tasks recovery ON recovery.id = snapshot.recovery_task_id
      WHERE ${DEAD_WAKE_CLAIM_SQL}
      ORDER BY COALESCE(snapshot.recovery_claimed_at, snapshot.updated_at) ASC, snapshot.id ASC
      LIMIT ?`
  )
    .bind(staleBefore, staleBefore, batchSize)
    .all<DeadWakeCandidate>();
  const candidates = rows.results ?? [];
  if (candidates.length === 0) return { selected: 0, released: 0 };

  const error = sessionLifecycleError(env, DEAD_WAKE_CLAIM_ERROR);
  const results = await env.DATABASE.batch(
    candidates.map((row) =>
      env.DATABASE.prepare(
        `UPDATE session_snapshots AS snapshot
            SET recovery_status = 'failed', recovery_error = ?, recovery_claimed_at = NULL,
                recovery_failed_at = COALESCE(recovery_failed_at, ?), updated_at = ?
          WHERE snapshot.id = ?
            AND snapshot.recovery_task_id IS ? AND snapshot.recovery_attempt_id IS ?
            AND snapshot.recovery_claimed_at IS ?
            AND ${DEAD_WAKE_CLAIM_SQL}`
      ).bind(
        error,
        // The attempt ended when its task left the live statuses: a reported end, so the
        // budget may decay from it (rule 61). A missing task has no time; use now.
        normalizedIso(row.taskUpdatedAt) ?? nowIso,
        nowIso,
        row.id,
        row.recoveryTaskId,
        row.recoveryAttemptId,
        row.recoveryClaimedAt,
        staleBefore,
        staleBefore
      )
    )
  );

  const released = candidates.filter((_, index) => (results[index]?.meta.changes ?? 0) > 0);
  for (const row of released) {
    log.warn('session_recovery.dead_wake_claim_released', {
      snapshotId: row.id,
      projectId: row.projectId,
      chatSessionId: row.chatSessionId,
      recoveryTaskId: row.recoveryTaskId,
      recoveryAttemptId: row.recoveryAttemptId,
      recoveryClaimedAt: row.recoveryClaimedAt,
      taskStatus: row.taskStatus,
      taskUpdatedAt: row.taskUpdatedAt,
    });
  }
  if (released.length > 0) {
    waitUntil(
      Promise.all(
        released.map((row) =>
          notifyWakeSettled({
            env,
            projectId: row.projectId,
            chatSessionId: row.chatSessionId,
            status: 'failed',
          })
        )
      )
    );
  }
  return { selected: candidates.length, released: released.length };
}

function normalizedIso(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
