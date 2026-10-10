/**
 * Per-source checks the prompt-delivery runner applies to a claim before any side effect:
 * parent wakes and project event wakes must still have live source authority, and the
 * source kinds that may wake a sleeping chat carry the guard that wake must honor.
 * Split out of `prompt-delivery-runner.ts` (`.claude/rules/18-file-size-limits.md`).
 */
import {
  MAX_ORCHESTRATOR_WAIT_CHILDREN,
  TASK_TERMINAL_STATUSES,
} from '@simple-agent-manager/shared';

import {
  isSessionRecoverySourceTaskGuardValid,
  type SessionRecoverySourceTaskGuard,
} from '../../services/session-recovery-authority';
import type { PromptDeliveryClaim, PromptDeliveryResult } from './prompt-delivery';
import type { Env } from './types';

const MAX_TASK_ID_LENGTH = 128;

function parentWakeChildTaskIds(claim: PromptDeliveryClaim): string[] | null {
  const value = claim.message.metadata?.childTaskIds;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_ORCHESTRATOR_WAIT_CHILDREN ||
    value.some(
      (taskId) => typeof taskId !== 'string' || !taskId || taskId.length > MAX_TASK_ID_LENGTH
    )
  ) {
    return null;
  }
  const taskIds = value as string[];
  return new Set(taskIds).size === taskIds.length ? taskIds : null;
}

export async function invalidParentWakeTargetResult(
  env: Env,
  projectId: string | null,
  claim: PromptDeliveryClaim
): Promise<PromptDeliveryResult | null> {
  if (claim.message.sourceKind !== 'parent_wakeup' || !claim.message.sourceTaskId) return null;
  if (!projectId) {
    return {
      kind: 'failed',
      reason: 'terminal_target',
      error: 'Parent wake has no project identity',
      runtimeIdentity: null,
      capabilities: null,
    };
  }
  const childTaskIds = parentWakeChildTaskIds(claim);
  if (!childTaskIds) {
    return {
      kind: 'failed',
      reason: 'terminal_target',
      error: 'Parent wake has no valid child task identity',
      runtimeIdentity: claim.message.runtimeIdentity,
      capabilities: null,
    };
  }
  const taskIds = [claim.message.sourceTaskId, ...childTaskIds];
  const placeholders = taskIds.map(() => '?').join(', ');
  const response = await env.DATABASE.prepare(
    `SELECT id, status, chat_session_id, superseded_by_task_id,
            recovery_source_task_id, triggered_by
     FROM tasks
     WHERE project_id = ?
       AND (
         id IN (${placeholders})
         OR id = (
           SELECT superseded_by_task_id
             FROM tasks
            WHERE project_id = ?
              AND id = ?
              AND superseded_by_task_id IS NOT NULL
         )
         OR (
           recovery_source_task_id = ?
           AND chat_session_id = ?
           AND triggered_by = 'session-recovery'
         )
       )`
  )
    .bind(
      projectId,
      ...taskIds,
      projectId,
      claim.message.sourceTaskId,
      claim.message.sourceTaskId,
      claim.message.targetSessionId
    )
    .all<{
      id: string;
      status: string;
      chat_session_id: string | null;
      superseded_by_task_id: string | null;
      recovery_source_task_id: string | null;
      triggered_by: string;
    }>();
  const tasks = new Map((response.results ?? []).map((task) => [task.id, task]));
  const parent = tasks.get(claim.message.sourceTaskId);
  const liveRecoveryOwner = (response.results ?? []).find(
    (task) =>
      (task.recovery_source_task_id === claim.message.sourceTaskId ||
        task.id === parent?.superseded_by_task_id) &&
      task.chat_session_id === claim.message.targetSessionId &&
      task.triggered_by === 'session-recovery' &&
      !(TASK_TERMINAL_STATUSES as readonly string[]).includes(task.status)
  );
  const parentIsTerminal = parent
    ? (TASK_TERMINAL_STATUSES as readonly string[]).includes(parent.status)
    : false;
  const parentIsWakeable =
    parent && (!parentIsTerminal || (parent.status === 'cancelled' && Boolean(liveRecoveryOwner)));
  if (
    !parent ||
    !parentIsWakeable ||
    (parent.chat_session_id !== claim.message.targetSessionId && !liveRecoveryOwner)
  ) {
    return {
      kind: 'failed',
      reason: 'terminal_target',
      error: !parent
        ? 'Parent task no longer exists'
        : parentIsTerminal
          ? `Parent task is ${parent.status}`
          : 'Parent task session binding changed',
      runtimeIdentity: claim.message.runtimeIdentity,
      capabilities: null,
    };
  }
  const invalidChildId = childTaskIds.find((childTaskId) => !tasks.has(childTaskId));
  if (invalidChildId) {
    return {
      kind: 'failed',
      reason: 'terminal_target',
      error: `Child task is no longer in this project before parent wake (${invalidChildId})`,
      runtimeIdentity: claim.message.runtimeIdentity,
      capabilities: null,
    };
  }
  return null;
}

/**
 * A source check that could not read its authority has learned nothing: a submit retries, and
 * a receipt reconciliation stays ambiguous. `check` names the check in the error.
 */
export function sourceValidationReadFailure(
  claim: PromptDeliveryClaim,
  error: unknown,
  check: string
): PromptDeliveryResult {
  const message = error instanceof Error ? error.message : String(error);
  if (claim.mode === 'reconcile') {
    return {
      kind: 'ambiguous',
      reason: 'receipt_unavailable',
      error: `${check} failed during receipt reconciliation: ${message}`,
      runtimeIdentity: claim.message.runtimeIdentity,
      capabilities: null,
      receipt: null,
    };
  }
  return {
    kind: 'retry',
    reason: 'not_ready',
    error: `${check} temporarily failed: ${message}`,
    runtimeIdentity: claim.message.runtimeIdentity,
    capabilities: null,
  };
}

export function sourceTaskGuardForClaim(
  claim: PromptDeliveryClaim,
  projectId: string | null
): SessionRecoverySourceTaskGuard | undefined {
  if (
    claim.message.sourceKind !== 'parent_wakeup' &&
    claim.message.sourceKind !== 'project_event_wake' &&
    claim.message.sourceKind !== 'scheduled_action' &&
    // A continuation re-wakes the chat only while its own task is live: unguarded, the
    // recovery claim would reactivate even a terminal task.
    claim.message.sourceKind !== 'checkpoint_continuation'
  ) {
    return undefined;
  }
  if (!claim.message.sourceTaskId || !projectId) return undefined;
  const metadata = claim.message.metadata ?? {};
  const projectEventWake =
    claim.message.sourceKind === 'project_event_wake' &&
    typeof metadata.batchId === 'string' &&
    typeof metadata.subscriptionId === 'string'
      ? { batchId: metadata.batchId, subscriptionId: metadata.subscriptionId }
      : null;
  return {
    taskId: claim.message.sourceTaskId,
    projectId,
    chatSessionId: claim.message.targetSessionId,
    ...(projectEventWake ? { projectEventWake } : {}),
    ...(claim.message.sourceKind === 'scheduled_action' &&
    typeof metadata.creatorUserId === 'string'
      ? { requiredProjectMemberId: metadata.creatorUserId }
      : {}),
  };
}

export async function invalidProjectEventWakeSourceTaskResult(
  env: Env,
  projectId: string | null,
  claim: PromptDeliveryClaim
): Promise<PromptDeliveryResult | null> {
  if (claim.message.sourceKind !== 'project_event_wake') return null;
  if (!claim.message.sourceTaskId || !projectId) {
    return {
      kind: 'failed',
      reason: 'terminal_target',
      error: !projectId
        ? 'Project event wake has no project identity'
        : 'Project event wake has no source task authority',
      runtimeIdentity: claim.message.runtimeIdentity,
      capabilities: null,
    };
  }
  const valid = await isSessionRecoverySourceTaskGuardValid(env.DATABASE, {
    requireSourceProjectMember: true,
    taskId: claim.message.sourceTaskId,
    projectId,
    chatSessionId: claim.message.targetSessionId,
  });
  if (valid) return null;
  return {
    kind: 'failed',
    reason: 'terminal_target',
    error: 'Project event wake source task authority was revoked',
    runtimeIdentity: claim.message.runtimeIdentity,
    capabilities: null,
  };
}
