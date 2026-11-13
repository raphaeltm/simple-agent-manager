/**
 * Recovery authority checks for the TaskRunner DO. Extracted from `index.ts`
 * (`.claude/rules/18-file-size-limits.md`); the DO methods delegate here.
 *
 * A wake runner may act only while the session snapshot claim still names its
 * exact task and wake attempt, and, for a guarded orchestration wake, while the
 * source task and any project-event wake still authorize it. Every refusal names
 * the check that failed and logs it with the snapshot claim (`recovery-revocation.ts`).
 */
import { parseProviderLimitWait } from '@simple-agent-manager/scheduler-core';

import type { Env } from '../../env';
import {
  loadProviderLimitRecoveryApproval,
  providerLimitRecoveryApprovalIsCurrent,
} from '../../services/provider-limit-recovery-approval';
import { assertReplacementDeletionConfirmed } from '../../services/replacement-deletion-fence';
import {
  findSessionRecoveryTaskAndEventAuthorityFailure,
  isSessionRecoveryAttemptCurrent,
  type SessionRecoveryAuthorityCheck,
} from '../../services/session-recovery-authority';
import {
  evictionRecoveryFenceMatches,
  evictionRecoveryRestoredByRunner,
} from '../../services/session-recovery-eviction';
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
  input: StartTaskInput | TaskRunnerState,
  persistedState?: TaskRunnerState | null
): Promise<RecoveryAttemptFailure | null> {
  if ('stepResults' in input) {
    const persisted =
      persistedState === undefined
        ? await ctx.storage.get<TaskRunnerState>('state')
        : persistedState;
    if (
      persisted &&
      (persisted.taskId !== input.taskId ||
        persisted.projectId !== input.projectId ||
        persisted.userId !== input.userId ||
        (persisted.config.recoveryAttemptId ?? null) !== (input.config.recoveryAttemptId ?? null))
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
  const persisted = 'stepResults' in input ? await ctx.storage.get<TaskRunnerState>('state') : null;
  const attemptFailure = await findRecoveryAttemptFailure(env, ctx, input, persisted ?? null);
  if (attemptFailure) return attemptFailure;
  // A nudge can install consent while this step is awaiting an external call.
  // The captured input must not erase or bypass the same-attempt stored guard.
  const approval =
    persisted?.config.providerLimitRecoveryApproval ?? input.config.providerLimitRecoveryApproval;
  if (
    approval &&
    !(await providerLimitRecoveryApprovalIsCurrent(
      env,
      input.taskId,
      input.projectId,
      approval,
      true
    ))
  )
    return 'recovery_task_authority';
  // Owner force-resume can approve a previously unguarded human-message wake.
  // Keep its existing claim, while making that approval revocable at every
  // external runner boundary rather than only when the owner clicked.
  const ownerApproval = await env.DATABASE.prepare(
    `SELECT t.provider_limit_wait_json,
      EXISTS (SELECT 1 FROM project_members m JOIN users u ON u.id=m.user_id
        WHERE m.project_id=t.project_id AND m.user_id=t.user_id AND m.status='active'
        AND m.role IN ('owner','admin','maintainer') AND u.status='active') AS member_active
     FROM tasks t WHERE t.id=? AND t.project_id=? AND t.user_id=?
       AND json_valid(t.provider_limit_wait_json)
       AND json_type(t.provider_limit_wait_json,'$.ownerOverride.expiresAt')='integer'`
  )
    .bind(input.taskId, input.projectId, input.userId)
    .first<{ provider_limit_wait_json: string; member_active: number }>();
  if (
    ownerApproval &&
    !ownerApproval.member_active &&
    parseProviderLimitWait(ownerApproval.provider_limit_wait_json)?.ownerOverride
  )
    return 'recovery_task_authority';
  // The same live state is used by bootstrap and its legacy skill fallback.
  if (approval) input.config.providerLimitRecoveryApproval = approval;
  // The owner CAS may commit before the nudge reaches this runner. Reconstruct
  // that live scoped guard rather than treating an old unguarded state as consent.
  if (!approval && ownerApproval) {
    const wait = parseProviderLimitWait(ownerApproval.provider_limit_wait_json);
    if (wait?.ownerOverride?.ownerUserId && wait.ownerOverride.snapshotId) {
      const liveApproval = await loadProviderLimitRecoveryApproval(
        env,
        input.taskId,
        ownerApproval.provider_limit_wait_json
      );
      if (
        !liveApproval ||
        !(await providerLimitRecoveryApprovalIsCurrent(
          env,
          input.taskId,
          input.projectId,
          liveApproval,
          true
        ))
      )
        return 'recovery_task_authority';
      input.config.providerLimitRecoveryApproval = liveApproval;
    }
  }
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
            // The woken agent reading or acking its own event must not revoke its wake.
            acceptConsumedByTarget: true,
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
  const restoredWorkspaceId = 'stepResults' in input ? input.stepResults.workspaceId : null;
  if (
    evictionFence &&
    !(await evictionRecoveryFenceMatches(env, evictionFence)) &&
    !(
      restoredWorkspaceId &&
      (await evictionRecoveryRestoredByRunner(
        env,
        {
          taskId: input.taskId,
          workspaceId: restoredWorkspaceId,
          recoveryAttemptId: input.config.recoveryAttemptId ?? null,
        },
        evictionFence
      ))
    )
  ) {
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
