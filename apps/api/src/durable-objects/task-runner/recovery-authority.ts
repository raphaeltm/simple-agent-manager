/**
 * Recovery authority checks for the TaskRunner DO. Extracted from `index.ts`
 * (`.claude/rules/18-file-size-limits.md`); the DO methods delegate here.
 *
 * A wake runner may act only while the session snapshot claim still names its
 * exact task and wake attempt, and, for a guarded orchestration wake, while the
 * source task and any project-event wake still authorize it.
 */
import type { Env } from '../../env';
import { assertReplacementDeletionConfirmed } from '../../services/replacement-deletion-fence';
import {
  isSessionRecoveryAttemptCurrent,
  isSessionRecoveryTaskAndEventAuthorized,
  SessionRecoveryAuthorityRevokedError,
} from '../../services/session-recovery-authority';
import { evictionRecoveryFenceMatches } from '../../services/session-recovery-eviction';
import { assertTaskRunnerStartGuard } from '../../services/task-runner-start-guard';
import { assertTaskExecutionAuthority } from './task-execution-authority';
import type { StartTaskInput, TaskRunnerState } from './types';

/**
 * A stable task ID cannot distinguish an old alarm from the current wake claim.
 * `ctx` is read only for persisted runner state, so start-time checks need no storage.
 */
export async function isCurrentRecoveryAttempt(
  env: Env,
  ctx: DurableObjectState,
  input: StartTaskInput | TaskRunnerState
): Promise<boolean> {
  if ('stepResults' in input) {
    const persisted = await ctx.storage.get<TaskRunnerState>('state');
    if (
      persisted &&
      (persisted.config.recoveryAttemptId ?? null) !== (input.config.recoveryAttemptId ?? null)
    )
      return false;
  }
  const recoveryAttemptId = input.config.recoveryAttemptId;
  if (!recoveryAttemptId) return true; // Runners persisted before stable wake identities.
  const chatSessionId = input.config.resumeSnapshotChatSessionId ?? input.config.chatSessionId;
  if (!chatSessionId) return false;
  return isSessionRecoveryAttemptCurrent(env.DATABASE, {
    taskId: input.taskId,
    projectId: input.projectId,
    chatSessionId,
    recoveryAttemptId,
  });
}

export async function hasRecoveryAuthority(
  env: Env,
  ctx: DurableObjectState,
  input: StartTaskInput | TaskRunnerState
): Promise<boolean> {
  if (!(await isCurrentRecoveryAttempt(env, ctx, input))) return false;
  const sourceTaskId = input.config.recoverySourceTaskId ?? null;
  const chatSessionId = input.config.resumeSnapshotChatSessionId ?? null;
  // A human follow-up may recover a completed conversation without a live
  // parent guard. Only runners created for a guarded orchestration wake carry
  // recoverySourceTaskId and require revocable authorization.
  if (!sourceTaskId) return true;
  if (!chatSessionId) return false;
  const eventGuard = input.config.projectEventWakeGuard ?? null;
  const projectDataService = eventGuard ? await import('../../services/project-data') : null;
  return isSessionRecoveryTaskAndEventAuthorized(
    env.DATABASE,
    {
      recoveryTaskId: input.taskId,
      recoveryAttemptId: input.config.recoveryAttemptId,
      sourceTaskId,
      projectId: input.projectId,
      chatSessionId,
      projectEventWake: eventGuard,
      requiredProjectMemberId: input.config.recoveryRequiredProjectMemberId ?? null,
    },
    projectDataService
      ? (eventInput) =>
          projectDataService.validateProjectEventWakeRecoveryAuthority(env, eventInput.projectId, {
            chatSessionId: eventInput.chatSessionId,
            sourceTaskId: eventInput.sourceTaskId,
            batchId: eventInput.batchId,
            subscriptionId: eventInput.subscriptionId,
          })
      : undefined
  );
}

export async function assertRecoveryAuthority(
  env: Env,
  ctx: DurableObjectState,
  input: StartTaskInput | TaskRunnerState,
  options: { requireStartGuardQueued?: boolean } = {}
): Promise<void> {
  const evictionFence = input.config.evictionFence ?? null;
  if (evictionFence && !(await evictionRecoveryFenceMatches(env, evictionFence))) {
    throw Object.assign(new Error('Eviction generation changed before replacement allocation'), {
      permanent: true,
    });
  }
  const deletionSourceTaskId =
    input.config.retrySourceTaskId ?? input.config.recoverySourceTaskId ?? null;
  if (deletionSourceTaskId && deletionSourceTaskId !== input.taskId) {
    await assertReplacementDeletionConfirmed(env, {
      sourceTaskId: deletionSourceTaskId,
      projectId: input.projectId,
      userId: input.userId,
    });
  }
  if (!(await hasRecoveryAuthority(env, ctx, input))) {
    throw new SessionRecoveryAuthorityRevokedError();
  }
  await assertTaskRunnerStartGuard(env, input.config.startGuard, {
    requireQueuedTask: options.requireStartGuardQueued === true,
    expectedRunner: {
      taskId: input.taskId,
      projectId: input.projectId,
      userId: input.userId,
      chatSessionId:
        'stepResults' in input
          ? (input.stepResults.chatSessionId ?? input.config.chatSessionId)
          : input.config.chatSessionId,
    },
  });
  await assertTaskExecutionAuthority(env, input);
}
