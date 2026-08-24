import {
  MAX_ORCHESTRATOR_WAIT_CHILDREN,
  TASK_TERMINAL_STATUSES,
} from '@simple-agent-manager/shared';

import { createModuleLogger } from '../../lib/logger';
import { recordDurableExecutionMetric } from '../../services/telemetry';
import type { VmPromptDeliveryAdapter } from '../../services/vm-prompt-delivery-adapter';
import * as activity from './activity';
import type { DurableExecutionConfig } from './durable-execution-config';
import {
  applyPromptDeliveryResult,
  type PromptDeliveryClaim,
  type PromptDeliveryResult,
} from './prompt-delivery';
import * as sessionState from './session-state';
import type { Env } from './types';

const log = createModuleLogger('project_data.prompt_delivery_runner');
const MAX_TASK_ID_LENGTH = 128;

export interface PromptDeliveryRunnerHooks {
  projectId: string | null;
  recalculateAlarm: () => Promise<void>;
  broadcastEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void;
}

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

async function invalidParentWakeTargetResult(
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
    `SELECT id, status, chat_session_id,
            recovery_source_task_id, triggered_by
     FROM tasks
     WHERE project_id = ?
       AND (
         id IN (${placeholders})
         OR (
           recovery_source_task_id = ?
           AND chat_session_id = ?
           AND triggered_by = 'session-recovery'
         )
       )`
  )
    .bind(projectId, ...taskIds, claim.message.sourceTaskId, claim.message.targetSessionId)
    .all<{
      id: string;
      status: string;
      chat_session_id: string | null;
      recovery_source_task_id: string | null;
      triggered_by: string;
    }>();
  const tasks = new Map((response.results ?? []).map((task) => [task.id, task]));
  const parent = tasks.get(claim.message.sourceTaskId);
  const liveRecoveryOwner = (response.results ?? []).find(
    (task) =>
      task.recovery_source_task_id === claim.message.sourceTaskId &&
      task.chat_session_id === claim.message.targetSessionId &&
      task.triggered_by === 'session-recovery' &&
      !(TASK_TERMINAL_STATUSES as readonly string[]).includes(task.status)
  );
  if (
    !parent ||
    (TASK_TERMINAL_STATUSES as readonly string[]).includes(parent.status) ||
    (parent.chat_session_id !== claim.message.targetSessionId && !liveRecoveryOwner)
  ) {
    return {
      kind: 'failed',
      reason: 'terminal_target',
      error: !parent
        ? 'Parent task no longer exists'
        : (TASK_TERMINAL_STATUSES as readonly string[]).includes(parent.status)
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

function parentWakeValidationReadFailure(
  claim: PromptDeliveryClaim,
  error: unknown
): PromptDeliveryResult {
  const message = error instanceof Error ? error.message : String(error);
  if (claim.mode === 'reconcile') {
    return {
      kind: 'ambiguous',
      reason: 'receipt_unavailable',
      error: `Parent wake target validation failed during receipt reconciliation: ${message}`,
      runtimeIdentity: claim.message.runtimeIdentity,
      capabilities: null,
      receipt: null,
    };
  }
  return {
    kind: 'retry',
    reason: 'not_ready',
    error: `Parent wake target validation temporarily failed: ${message}`,
    runtimeIdentity: claim.message.runtimeIdentity,
    capabilities: null,
  };
}

export async function runPromptDeliveryClaim(
  sql: SqlStorage,
  env: Env,
  config: DurableExecutionConfig,
  claim: PromptDeliveryClaim,
  adapter: VmPromptDeliveryAdapter,
  hooks: PromptDeliveryRunnerHooks
): Promise<PromptDeliveryResult> {
  const startedAt = Date.now();
  recordDurableExecutionMetric(
    {
      metric: 'prompt_delivery_attempt',
      projectId: hooks.projectId,
      sessionId: claim.message.targetSessionId,
      deliveryId: claim.message.id,
      attemptCount: claim.message.deliveryAttempts,
    },
    env as unknown as import('../../env').Env
  );

  let result: PromptDeliveryResult;
  try {
    const validateParentWakeTarget = async (): Promise<PromptDeliveryResult | null> => {
      try {
        return await invalidParentWakeTargetResult(env, hooks.projectId, claim);
      } catch (error) {
        return parentWakeValidationReadFailure(claim, error);
      }
    };
    const input = {
      projectId: hooks.projectId ?? '',
      claim,
      allowLegacyVm: config.legacyVmCompatEnabled,
      requestTimeoutMs: config.backgroundTimeoutMs,
      beforeSideEffect: validateParentWakeTarget,
      sourceTaskGuard:
        claim.message.sourceKind === 'parent_wakeup' && claim.message.sourceTaskId
          ? {
              taskId: claim.message.sourceTaskId,
              projectId: hooks.projectId ?? '',
              chatSessionId: claim.message.targetSessionId,
            }
          : undefined,
    };
    result =
      (await validateParentWakeTarget()) ??
      (claim.mode === 'submit' ? await adapter.submit(input) : await adapter.reconcile(input));
  } catch (error) {
    result = {
      kind: 'ambiguous',
      reason: 'lost_response',
      error: error instanceof Error ? error.message : String(error),
      runtimeIdentity: claim.message.runtimeIdentity,
      capabilities: null,
      receipt: null,
    };
  }

  const applied = applyPromptDeliveryResult(sql, claim, result, config);
  if (applied && result.kind === 'accepted') {
    sessionState.markPromptAccepted(
      sql,
      result.acpSessionId,
      result.promptEpoch,
      result.promptEpoch
    );
  }

  const metric =
    result.kind === 'accepted'
      ? 'prompt_delivery_accepted'
      : result.kind === 'retry'
        ? 'prompt_delivery_retry'
        : result.kind === 'failed'
          ? 'prompt_delivery_failed'
          : 'prompt_delivery_ambiguous';
  recordDurableExecutionMetric(
    {
      metric,
      projectId: hooks.projectId,
      sessionId: claim.message.targetSessionId,
      deliveryId: claim.message.id,
      attemptCount: claim.message.deliveryAttempts,
      durationMs: Date.now() - startedAt,
      reason: 'reason' in result ? result.reason : null,
    },
    env as unknown as import('../../env').Env
  );

  if (applied) {
    activity.recordActivityEventInternal(
      sql,
      `prompt_delivery.${result.kind}`,
      'system',
      null,
      null,
      claim.message.targetSessionId,
      claim.message.sourceTaskId,
      JSON.stringify({
        deliveryId: claim.message.id,
        attemptId: claim.attemptId,
        attemptCount: claim.message.deliveryAttempts,
        mode: claim.mode,
        result: result.kind,
        reason: 'reason' in result ? result.reason : null,
        runtimeIdentity: result.runtimeIdentity,
      })
    );
    hooks.broadcastEvent(
      'mailbox.delivery_updated',
      {
        messageId: claim.message.id,
        deliveryState:
          result.kind === 'accepted'
            ? claim.message.ackRequired
              ? 'delivered'
              : 'acked'
            : result.kind === 'retry'
              ? 'retry_wait'
              : result.kind === 'failed'
                ? 'failed'
                : 'ambiguous',
      },
      claim.message.targetSessionId
    );
  } else {
    log.info('prompt_delivery.stale_result_ignored', {
      messageId: claim.message.id,
      attemptId: claim.attemptId,
      result: result.kind,
    });
  }

  await hooks.recalculateAlarm();
  return result;
}
