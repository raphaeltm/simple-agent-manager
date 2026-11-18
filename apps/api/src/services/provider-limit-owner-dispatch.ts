import type { ProviderLimitWait } from '@simple-agent-manager/scheduler-core';
import { DEFAULT_PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS } from '@simple-agent-manager/shared';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import type { parseProviderLimitSnapshotRow } from './provider-limit-approval-context';
import {
  acknowledgeProviderLimitRecovery,
  confirmProviderLimitRecoveryRunner,
} from './provider-limit-force-resume';
import {
  type ProviderLimitRecoveryApproval,
  providerLimitRecoveryApprovalIsCurrent,
} from './provider-limit-recovery-approval';
import {
  canRepairSessionRecoveryRunner,
  ensureSessionRecovery,
  startMissingSessionRecoveryRunner,
} from './session-recovery';
import { getTaskRunnerStatus, nudgeTaskRunnerDO } from './task-runner-do';
type SavedProviderLimitSnapshot = NonNullable<ReturnType<typeof parseProviderLimitSnapshotRow>>;

export function resolveProviderLimitRecoveryRpcTimeoutMs(env: Env): number {
  return parsePositiveInt(
    env.PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS,
    DEFAULT_PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS
  );
}

export async function dispatchOwnerApprovedRecovery(
  env: Env,
  task: schema.Task,
  wait: ProviderLimitWait,
  snapshot: SavedProviderLimitSnapshot,
  receipt: string,
  chatSessionId: string
): Promise<void> {
  const expiresAt = wait.ownerOverride?.expiresAt;
  if (expiresAt === undefined) return;
  const approval: ProviderLimitRecoveryApproval = {
    receipt,
    ownerUserId: task.userId,
    snapshotId: snapshot.id,
    expiresAt,
    sourceCredentialReference: snapshot.agent_credential_reference,
  };
  // The timeout bounds only this sweep's wait. The same durable approval guards
  // any late claim/start, while acknowledgement stays exclusively in this caller.
  const accepted = await withinRecoveryRpcBudget(env, async () => {
    if (snapshot.recovery_status === 'waking') {
      if (
        await nudgeTaskRunnerDO(
          env,
          task.id,
          'Retry owner-approved provider limit recovery',
          approval
        )
      )
        return snapshot.recovery_attempt_id;
      const status = await getTaskRunnerStatus(env, task.id);
      if (
        !snapshot.recovery_attempt_id ||
        !canRepairSessionRecoveryRunner(status, {
          taskId: task.id,
          projectId: task.projectId,
          userId: task.userId,
          chatSessionId,
          recoveryAttemptId: snapshot.recovery_attempt_id,
        })
      )
        return false;
      const result = await startMissingSessionRecoveryRunner(
        env,
        task.projectId,
        chatSessionId,
        {
          taskId: task.id,
          projectId: task.projectId,
          chatSessionId,
          requiredProjectMemberId: task.userId,
          providerLimitApproval: approval,
        },
        snapshot.recovery_attempt_id
      );
      return result.status === 'waking'
        ? confirmProviderLimitRecoveryRunner(env, task.id, task.projectId, chatSessionId, approval)
        : null;
    }
    const result = await ensureSessionRecovery(env, task.projectId, chatSessionId, {
      taskId: task.id,
      projectId: task.projectId,
      chatSessionId,
      requiredProjectMemberId: task.userId,
      providerLimitApproval: approval,
    });
    return result.status === 'waking'
      ? confirmProviderLimitRecoveryRunner(env, task.id, task.projectId, chatSessionId, approval)
      : null;
  });
  if (
    !accepted ||
    !(await providerLimitRecoveryApprovalIsCurrent(env, task.id, task.projectId, approval))
  )
    return;
  await acknowledgeProviderLimitRecovery(env, task.id, receipt, false, accepted);
}

/** Timing out neither releases a claim nor revokes the owner's durable consent. */
export async function withinRecoveryRpcBudget<T>(
  env: Env,
  operation: () => Promise<T>
): Promise<T | false> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), resolveProviderLimitRecoveryRpcTimeoutMs(env));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
