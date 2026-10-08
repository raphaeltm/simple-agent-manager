import {
  isSessionRecoveryAttemptCurrent,
  restoreSessionRecoveryHandoff,
} from '../../services/session-recovery-authority';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export async function ownsRecoveryAttempt(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<boolean> {
  const persisted = await rc.ctx.storage.get?.<TaskRunnerState>('state');
  if (
    persisted &&
    (persisted.config.recoveryAttemptId ?? null) !== (state.config.recoveryAttemptId ?? null)
  )
    return false;
  return (
    !state.config.recoveryAttemptId ||
    isSessionRecoveryAttemptCurrent(rc.env.DATABASE, {
      taskId: state.taskId,
      projectId: state.projectId,
      chatSessionId: state.config.resumeSnapshotChatSessionId ?? state.config.chatSessionId ?? '',
      recoveryAttemptId: state.config.recoveryAttemptId,
    })
  );
}

async function resleepRecoverySession(
  state: TaskRunnerState,
  recoverySessionId: string,
  rc: TaskRunnerContext
): Promise<boolean> {
  const { sleepSession, getSession } = await import('../../services/project-data');
  const session = await getSession(rc.env, state.projectId, recoverySessionId);
  if (!(await ownsRecoveryAttempt(state, rc))) return false;
  if (session?.status !== 'sleeping') {
    const slept = await sleepSession(rc.env, state.projectId, recoverySessionId, {
      failedOnly: session?.status === 'failed',
      ...(state.config.recoveryAttemptId
        ? {
            guard: {
              taskId: state.taskId,
              workspaceId: typeof session?.workspaceId === 'string' ? session.workspaceId : null,
            },
          }
        : {}),
    });
    if (!slept) throw new Error('Recovery failure could not return the conversation to sleeping');
  }
  return true;
}

export async function failRecoveryLifecycle(
  state: TaskRunnerState,
  errorMessage: string,
  rc: TaskRunnerContext,
  options: { preserveSession?: boolean; beforeRelease?: () => Promise<void> } = {}
): Promise<void> {
  const recoverySessionId = state.config.resumeSnapshotChatSessionId;
  if (!recoverySessionId || !(await ownsRecoveryAttempt(state, rc))) return;

  // Ownership restoration is a correctness boundary, not best-effort cleanup:
  // if D1 is temporarily unavailable, let the DO alarm retry instead of
  // completing with a terminal replacement still owning the durable chat.
  if (!state.config.recoveryAttemptId) {
    await restoreSessionRecoveryHandoff(rc.env.DATABASE, state.taskId, recoverySessionId);
  }
  const { failSession } = await import('../../services/project-data');
  const { findRestorableOrInFlightSleepSnapshot } =
    await import('../../services/session-snapshot-sleep-predicate');
  const preserve =
    options.preserveSession ||
    (await findRestorableOrInFlightSleepSnapshot(rc.env.DATABASE, rc.env, {
      projectId: state.projectId,
      chatSessionId: recoverySessionId,
    }));
  if (preserve) {
    if (!(await resleepRecoverySession(state, recoverySessionId, rc))) return;
  } else {
    await failSession(rc.env, state.projectId, recoverySessionId, errorMessage);
  }

  // Keep recovery_status=waking until both the session and replacement cleanup
  // converge. Releasing this claim earlier admits a new wake during old cleanup.
  await options.beforeRelease?.();
  if (!(await ownsRecoveryAttempt(state, rc))) return;
  if (preserve && state.config.recoveryAttemptId && state.stepResults.workspaceId) {
    // A failed replacement must relinquish the unique workspace/chat binding
    // before another wake can allocate its successor. Deleted rows also retain
    // that unique binding; only the still-owned attempt may release it.
    await rc.env.DATABASE.prepare(
      `UPDATE workspaces SET chat_session_id = NULL, updated_at = ?
       WHERE id = ? AND project_id = ? AND user_id = ? AND chat_session_id = ?
         AND EXISTS (
           SELECT 1 FROM session_snapshots snapshot JOIN tasks task
             ON task.id = snapshot.recovery_task_id
            WHERE snapshot.project_id = workspaces.project_id
              AND snapshot.user_id = workspaces.user_id
              AND snapshot.chat_session_id = workspaces.chat_session_id
              AND snapshot.recovery_workspace_id = workspaces.id
              AND snapshot.recovery_task_id = ? AND snapshot.recovery_attempt_id = ?
              AND snapshot.recovery_status = 'waking'
              AND task.project_id = workspaces.project_id AND task.user_id = workspaces.user_id
              AND task.chat_session_id = workspaces.chat_session_id AND task.status = 'sleeping'
         )`
    )
      .bind(
        new Date().toISOString(),
        state.stepResults.workspaceId,
        state.projectId,
        state.userId,
        recoverySessionId,
        state.taskId,
        state.config.recoveryAttemptId
      )
      .run();
  }
  const { drizzle } = await import('drizzle-orm/d1');
  const schema = await import('../../db/schema');
  const { failSessionSnapshotRecovery } = await import('../../services/session-snapshots');
  await failSessionSnapshotRecovery(
    drizzle(rc.env.DATABASE, { schema }),
    rc.env,
    recoverySessionId,
    state.taskId,
    errorMessage,
    state.config.recoveryAttemptId ?? undefined
  );
}
