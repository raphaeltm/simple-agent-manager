/** Receipt and exact-attempt acknowledgement shared by owner and scheduled repair. */
import type { Env } from '../env';
import {
  loadProviderLimitRecoveryApproval,
  type ProviderLimitRecoveryApproval,
  providerLimitRecoveryApprovalD1Fence,
} from './provider-limit-recovery-approval';
import { nudgeTaskRunnerDO } from './task-runner-do';

/** A waking claim is not a runner receipt. Confirm one exact attempt before ACK. */
export async function confirmProviderLimitRecoveryRunner(
  env: Env,
  taskId: string,
  projectId: string,
  chatSessionId: string,
  approval: ProviderLimitRecoveryApproval
): Promise<string | null> {
  const claim = await env.DATABASE.prepare(
    `SELECT recovery_attempt_id FROM session_snapshots
     WHERE id=? AND project_id=? AND chat_session_id=? AND user_id=?
       AND recovery_task_id=? AND recovery_status IN ('waking','restored')`
  )
    .bind(approval.snapshotId, projectId, chatSessionId, approval.ownerUserId, taskId)
    .first();
  const attempt = claim?.recovery_attempt_id;
  if (typeof attempt !== 'string' || !attempt) return null;
  return (await nudgeTaskRunnerDO(env, taskId, 'Confirm owner-approved recovery runner', approval))
    ? attempt
    : null;
}

/** Exact approval CAS: a newer rejection/approval must retain its own intent. */
export async function acknowledgeProviderLimitRecovery(
  env: Env,
  taskId: string,
  receipt: string,
  requireCommittedRun = false,
  expectedRecoveryAttemptId?: string | null
) {
  if (
    !requireCommittedRun &&
    (typeof expectedRecoveryAttemptId !== 'string' || !expectedRecoveryAttemptId)
  )
    return;
  const approval = await loadProviderLimitRecoveryApproval(env, taskId, receipt);
  if (!approval) return;
  const fence = providerLimitRecoveryApprovalD1Fence('tasks', approval, true, requireCommittedRun);
  // A claim can advance after the DO's authority read but before its ACK.
  // Clear only the attempt that this caller actually nudged.
  const claimFence =
    expectedRecoveryAttemptId === undefined
      ? { sql: '', params: [] }
      : {
          sql: `AND EXISTS (SELECT 1 FROM session_snapshots acknowledged_snapshot
      WHERE acknowledged_snapshot.id=? AND acknowledged_snapshot.project_id=tasks.project_id
        AND acknowledged_snapshot.chat_session_id=tasks.chat_session_id
        AND acknowledged_snapshot.user_id=tasks.user_id
        AND acknowledged_snapshot.recovery_task_id=tasks.id
        AND acknowledged_snapshot.recovery_status IN ('waking','restored')
        AND acknowledged_snapshot.recovery_attempt_id IS ?)`,
          params: [approval.snapshotId, expectedRecoveryAttemptId],
        };
  await env.DATABASE.prepare(
    `UPDATE tasks SET admission_state=NULL,admission_reason=NULL,admission_next_retry_at=NULL
     WHERE id=? AND admission_state='provider_limit_recovery_pending' ${fence.sql} ${claimFence.sql}`
  )
    .bind(taskId, ...fence.params, ...claimFence.params)
    .run();
}
