/**
 * Recovery authority checks for the TaskRunner DO. Extracted from `index.ts`
 * (`.claude/rules/18-file-size-limits.md`); the DO methods delegate here.
 *
 * A wake runner may act only while the session snapshot claim still names its
 * exact task and wake attempt, and, for a guarded orchestration wake, while the
 * source task and any project-event wake still authorize it. Every refusal names
 * the check that failed and logs it with the snapshot claim (`recovery-revocation.ts`).
 */
import type { Env } from '../../env';
import { assertReplacementDeletionConfirmed } from '../../services/replacement-deletion-fence';
import {
  findSessionRecoveryTaskAndEventAuthorityFailure,
  isSessionRecoveryAttemptCurrent,
  type SessionRecoveryAuthorityCheck,
} from '../../services/session-recovery-authority';
import { evictionRecoveryFenceMatches } from '../../services/session-recovery-eviction';
import { assertTaskRunnerStartGuard } from '../../services/task-runner-start-guard';
import { revokeRecoveryAuthority } from './recovery-revocation';
import { assertTaskExecutionAuthority } from './task-execution-authority';
import type { StartTaskInput, TaskRunnerState } from './types';

type RecoveryAttemptFailure = Extract<
  SessionRecoveryAuthorityCheck,
  'runner_attempt_superseded' | 'recovery_chat_session_missing' | 'recovery_attempt_not_current'
>;

/**
 * A stable task ID cannot distinguish an old alarm from the current wake claim.
 * `ctx` is read only for persisted runner state, so start-time checks need no storage.
 */
async function findRecoveryAttemptFailure(
  env: Env,
  ctx: DurableObjectState,
  input: StartTaskInput | TaskRunnerState
): Promise<RecoveryAttemptFailure | null> {
  if ('stepResults' in input) {
    const persisted = await ctx.storage.get<TaskRunnerState>('state');
    if (
      persisted &&
      (persisted.config.recoveryAttemptId ?? null) !== (input.config.recoveryAttemptId ?? null)
    )
      return 'runner_attempt_superseded';
  }
  const recoveryAttemptId = input.config.recoveryAttemptId;
  if (!recoveryAttemptId) return null; // Runners persisted before stable wake identities.
  const chatSessionId = input.config.resumeSnapshotChatSessionId ?? input.config.chatSessionId;
  if (!chatSessionId) return 'recovery_chat_session_missing';
  const current = await isSessionRecoveryAttemptCurrent(env.DATABASE, {
    taskId: input.taskId,
    projectId: input.projectId,
    chatSessionId,
    recoveryAttemptId,
  });
  return current ? null : 'recovery_attempt_not_current';
}

export async function isCurrentRecoveryAttempt(
  env: Env,
  ctx: DurableObjectState,
  input: StartTaskInput | TaskRunnerState
): Promise<boolean> {
  return (await findRecoveryAttemptFailure(env, ctx, input)) === null;
}

/** Throw a logged refusal unless this runner still owns the current wake attempt. */
export async function assertCurrentRecoveryAttempt(
  env: Env,
  ctx: DurableObjectState,
  state: TaskRunnerState,
  site: string
): Promise<void> {
  const failure = await findRecoveryAttemptFailure(env, ctx, state);
  if (failure) throw await revokeRecoveryAuthority(env.DATABASE, state, failure, site);
}

/** Name the check that refuses this runner, or null when it may act. */
export async function findRecoveryAuthorityFailure(
  env: Env,
  ctx: DurableObjectState,
  input: StartTaskInput | TaskRunnerState
): Promise<SessionRecoveryAuthorityCheck | null> {
  const attemptFailure = await findRecoveryAttemptFailure(env, ctx, input);
  if (attemptFailure) return attemptFailure;
  const sourceTaskId = input.config.recoverySourceTaskId ?? null;
  const chatSessionId = input.config.resumeSnapshotChatSessionId ?? null;
  // A human follow-up may recover a completed conversation without a live
  // parent guard. Only runners created for a guarded orchestration wake carry
  // recoverySourceTaskId and require revocable authorization.
  if (!sourceTaskId) return null;
  if (!chatSessionId) return 'recovery_chat_session_missing';
  const eventGuard = input.config.projectEventWakeGuard ?? null;
  const projectDataService = eventGuard ? await import('../../services/project-data') : null;
  return findSessionRecoveryTaskAndEventAuthorityFailure(
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
  const failure = await findRecoveryAuthorityFailure(env, ctx, input);
  if (failure) {
    throw await revokeRecoveryAuthority(
      env.DATABASE,
      input,
      failure,
      'task_runner.assert_recovery_authority'
    );
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
