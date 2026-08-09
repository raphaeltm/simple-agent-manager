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

export interface PromptDeliveryRunnerHooks {
  projectId: string | null;
  recalculateAlarm: () => Promise<void>;
  broadcastEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void;
}

export async function runPromptDeliveryClaim(
  sql: SqlStorage,
  env: Env,
  config: DurableExecutionConfig,
  claim: PromptDeliveryClaim,
  adapter: VmPromptDeliveryAdapter,
  hooks: PromptDeliveryRunnerHooks,
): Promise<PromptDeliveryResult> {
  const startedAt = Date.now();
  recordDurableExecutionMetric({
    metric: 'prompt_delivery_attempt',
    projectId: hooks.projectId,
    sessionId: claim.message.targetSessionId,
    deliveryId: claim.message.id,
    attemptCount: claim.message.deliveryAttempts,
  }, env as unknown as import('../../env').Env);

  let result: PromptDeliveryResult;
  try {
    const input = {
      projectId: hooks.projectId ?? '',
      claim,
      allowLegacyVm: config.legacyVmCompatEnabled,
      requestTimeoutMs: config.backgroundTimeoutMs,
    };
    result = claim.mode === 'submit'
      ? await adapter.submit(input)
      : await adapter.reconcile(input);
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
      result.promptEpoch,
    );
  }

  const metric = result.kind === 'accepted'
    ? 'prompt_delivery_accepted'
    : result.kind === 'retry'
      ? 'prompt_delivery_retry'
      : result.kind === 'failed'
        ? 'prompt_delivery_failed'
        : 'prompt_delivery_ambiguous';
  recordDurableExecutionMetric({
    metric,
    projectId: hooks.projectId,
    sessionId: claim.message.targetSessionId,
    deliveryId: claim.message.id,
    attemptCount: claim.message.deliveryAttempts,
    durationMs: Date.now() - startedAt,
    reason: 'reason' in result ? result.reason : null,
  }, env as unknown as import('../../env').Env);

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
      }),
    );
    hooks.broadcastEvent('mailbox.delivery_updated', {
      messageId: claim.message.id,
      deliveryState: result.kind === 'accepted'
        ? claim.message.ackRequired ? 'delivered' : 'acked'
        : result.kind === 'retry'
          ? 'retry_wait'
          : result.kind === 'failed'
            ? 'failed'
            : 'ambiguous',
    }, claim.message.targetSessionId);
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
