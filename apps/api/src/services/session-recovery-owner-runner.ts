import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { providerLimitRecoveryApprovalD1Fence } from './provider-limit-recovery-approval';
import { assertReplacementDeletionConfirmed } from './replacement-deletion-fence';
import { reactivateSleepingTask, resolveRecoveryPlacement } from './session-recovery';
import { loadRecoveryContext } from './session-recovery-context';
import { type SessionRecoveryResult } from './session-recovery-refusal-report';
import { startRecoveryTask } from './session-recovery-task';
import { type SessionRecoverySourceTaskGuard } from './session-snapshots';
import { nudgeTaskRunnerDO } from './task-runner-do';

/** Rebuild a missing runner without changing the durable claim or task identity.
 * Caller has positively observed absent DO state; reactivate itself converges
 * safely if another caller initializes this same attempt during placement I/O. */
export async function startMissingSessionRecoveryRunner(
  env: Env,
  projectId: string,
  chatSessionId: string,
  guard: SessionRecoverySourceTaskGuard,
  recoveryAttemptId: string
): Promise<SessionRecoveryResult> {
  const unavailable = {
    status: 'unavailable' as const,
    reason: 'missing_runner_recovery_not_current',
  };
  if (!guard.providerLimitApproval) return unavailable;
  const db = drizzle(env.DATABASE, { schema });
  const context = await loadRecoveryContext(db, projectId, chatSessionId);
  if (
    !context ||
    context.snapshot.runtime !== 'vm' ||
    context.snapshot.recoveryStatus !== 'waking' ||
    context.snapshot.recoveryTaskId !== guard.taskId ||
    context.snapshot.recoveryAttemptId !== recoveryAttemptId ||
    context.sourceTask?.id !== guard.taskId ||
    !['sleeping', 'queued', 'delegated'].includes(context.sourceTask.status) ||
    (context.sourceTask.workspaceId !== null &&
      (context.sourceTask.status !== 'sleeping' ||
        context.sourceTask.workspaceId !== context.snapshot.workspaceId))
  )
    return unavailable;
  await assertReplacementDeletionConfirmed(env, {
    sourceTaskId: guard.taskId,
    projectId,
    userId: context.snapshot.userId,
  });
  const placement = await resolveRecoveryPlacement(db, env, context, guard.taskId);
  if ('error' in placement) return unavailable;
  const approvalFence = providerLimitRecoveryApprovalD1Fence('tasks', guard.providerLimitApproval);
  const current = await env.DATABASE.prepare(
    `SELECT 1 AS valid FROM tasks
     WHERE id=? AND project_id=? AND chat_session_id=?
       AND ((status IN ('queued','delegated') AND workspace_id IS NULL)
         OR (status='sleeping' AND (workspace_id IS NULL OR workspace_id=?)))
       ${approvalFence.sql}
       AND EXISTS (SELECT 1 FROM session_snapshots snapshot WHERE snapshot.id=?
         AND snapshot.project_id=tasks.project_id AND snapshot.chat_session_id=tasks.chat_session_id
         AND snapshot.user_id=tasks.user_id AND snapshot.updated_at=?
         AND snapshot.recovery_status='waking' AND snapshot.recovery_task_id=tasks.id AND snapshot.recovery_attempt_id=?
         AND snapshot.runtime='vm' AND snapshot.sleep_status='sleeping' AND snapshot.sleeping_at IS NOT NULL
         AND snapshot.expires_at>? AND julianday(snapshot.expires_at) IS NOT NULL
         AND ((snapshot.status='available' AND snapshot.degradation='none') OR
           (snapshot.status='degraded' AND snapshot.degradation IS NOT NULL AND snapshot.degradation!='none')))`
  )
    .bind(
      guard.taskId,
      projectId,
      chatSessionId,
      context.snapshot.workspaceId,
      ...approvalFence.params,
      context.snapshot.id,
      context.snapshot.updatedAt,
      recoveryAttemptId,
      new Date().toISOString()
    )
    .first();
  if (current?.valid !== 1) return unavailable;
  const recoveryTask =
    context.sourceTask.status === 'sleeping'
      ? await reactivateSleepingTask(
          env.DATABASE,
          db,
          context,
          chatSessionId,
          guard.taskId,
          placement,
          recoveryAttemptId,
          guard,
          { workspaceId: context.sourceTask.workspaceId }
        )
      : context.sourceTask;
  await startRecoveryTask(
    env,
    context,
    recoveryTask,
    chatSessionId,
    placement,
    guard,
    {},
    recoveryAttemptId
  );
  // A concurrent same-attempt initialize may have kept older in-memory consent.
  // Install this exact approval on the current state before acknowledging it.
  if (
    !(await nudgeTaskRunnerDO(
      env,
      guard.taskId,
      'Initialize missing owner-approved recovery runner',
      guard.providerLimitApproval
    ))
  )
    return unavailable;
  return { status: 'waking', taskId: guard.taskId };
}

/** A false nudge is not absence. Only proven same-scope older recovery state
 * may be replaced; malformed, foreign, equal-attempt and ordinary runs defer. */
export function canRepairSessionRecoveryRunner(
  status: unknown,
  expected: {
    taskId: string;
    projectId: string;
    userId: string;
    chatSessionId: string;
    recoveryAttemptId: string;
  }
): boolean {
  if (!expected.recoveryAttemptId) return false;
  if (status === null) return true;
  if (typeof status !== 'object' || !status) return false;
  const state = status as Record<string, unknown>;
  if (typeof state.config !== 'object' || !state.config) return false;
  const config = state.config as Record<string, unknown>;
  return (
    state.taskId === expected.taskId &&
    state.projectId === expected.projectId &&
    state.userId === expected.userId &&
    typeof state.completed === 'boolean' &&
    typeof state.currentStep === 'string' &&
    config.resumeSnapshotChatSessionId === expected.chatSessionId &&
    typeof config.recoveryAttemptId === 'string' &&
    config.recoveryAttemptId.length > 0 &&
    config.recoveryAttemptId !== expected.recoveryAttemptId
  );
}
