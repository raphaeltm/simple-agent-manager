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
