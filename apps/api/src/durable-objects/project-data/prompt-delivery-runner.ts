import {
  isUrgentMessageClass,
  type VmPromptDeliveryCapabilities,
} from '@simple-agent-manager/shared';

import { createModuleLogger } from '../../lib/logger';
import { recordDurableExecutionMetric } from '../../services/telemetry';
import type {
  VmPromptDeliveryAdapter,
  VmPromptDeliveryAdapterInput,
  VmPromptDeliveryTarget,
} from '../../services/vm-prompt-delivery-adapter';
import * as activity from './activity';
import { invalidCheckpointContinuationTarget } from './checkpoint-continuation-delivery';
import type { DurableExecutionConfig } from './durable-execution-config';
import { providerLimitEventDeliveryGuard } from './project-event-provider-limit-delivery';
import {
  invalidScheduledDeliveryTarget,
  releaseAcceptedProviderLimitSchedule,
} from './project-event-schedules-delivery';
import {
  advanceProjectEventPromptAttemptCheckpoint,
  invalidProjectEventWakeDeliveryTargetResult,
} from './project-events-wake-delivery';
import {
  applyPromptDeliveryResult,
  markPromptDeliverySubmitting,
  type PromptDeliveryClaim,
  type PromptDeliveryResult,
} from './prompt-delivery';
import {
  stopBusyTurnForUrgentDelivery,
  type UrgentBusyTurnStopOutcome,
} from './prompt-delivery-interrupt';
import {
  invalidParentWakeTargetResult,
  invalidProjectEventWakeSourceTaskResult,
  invalidSessionWriterSenderResult,
  sourceTaskGuardForClaim,
  sourceValidationReadFailure,
} from './prompt-delivery-source-guards';
import { labelSteerOutcomeOnTranscript } from './prompt-delivery-steer';
import * as sessionState from './session-state';
import type { Env } from './types';
import { raiseSessionWakeFailure } from './wake-failure';

const log = createModuleLogger('project_data.prompt_delivery_runner');

export interface PromptDeliveryRunnerHooks {
  projectId: string | null;
  recalculateAlarm: () => Promise<void>;
  broadcastEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void;
  /** Re-arm the idle timer for a chat session whose turn just ended. */
  armIdleCleanup: (chatSessionId: string) => void;
  /** Release durable messages queued behind the (now ended) turn. */
  nudgeDeliveries: (chatSessionId: string) => number;
  /** Refresh D1 session summaries after marker/message changes. */
  scheduleSummarySync: () => void;
}

async function dispatchClaim(
  adapter: VmPromptDeliveryAdapter,
  claim: PromptDeliveryClaim,
  input: VmPromptDeliveryAdapterInput
): Promise<PromptDeliveryResult> {
  if (claim.message.deliveryIntent !== 'steer') {
    return claim.mode === 'submit' ? adapter.submit(input) : adapter.reconcile(input);
  }
  const steer = claim.mode === 'submit' ? adapter.steer : adapter.reconcileSteer;
  if (!steer) {
    // Nothing was sent: an adapter without live steering hands the message to the queue.
    return {
      kind: 'steer_fallback',
      reason: 'runtime_steering_unsupported',
      error: 'This delivery adapter does not support live steering',
      runtimeIdentity: null,
      capabilities: null,
    };
  }
  return steer.call(adapter, input);
}

/**
 * The `mailbox.delivery_updated` payload the web app renders delivery state from.
 * `promptMessageId` names the transcript row; the steer fields say what the
 * runtime did with a steer. A pending steer changes nothing visible.
 */
export function deliveryUpdateForResult(
  claim: PromptDeliveryClaim,
  result: PromptDeliveryResult
): Record<string, unknown> | null {
  const base = {
    messageId: claim.message.id,
    promptMessageId: claim.message.promptMessageId,
    deliveryIntent: claim.message.deliveryIntent,
  };
  switch (result.kind) {
    case 'steer_pending':
      return null;
    case 'steered':
      return {
        ...base,
        deliveryState: claim.message.ackRequired ? 'delivered' : 'acked',
        steerOutcome: 'steered',
      };
    case 'steer_fallback':
      return {
        ...base,
        deliveryIntent: 'queue',
        deliveryState: 'queued',
        steerOutcome: 'queued_fallback',
        steerReason: result.reason,
      };
    case 'accepted':
      return { ...base, deliveryState: claim.message.ackRequired ? 'delivered' : 'acked' };
    case 'retry':
      return { ...base, deliveryState: 'retry_wait' };
    case 'failed':
      return { ...base, deliveryState: 'failed' };
    case 'ambiguous':
      return { ...base, deliveryState: 'ambiguous' };
  }
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
  // Stop-and-deliver outcome captured by the onBusyTurn hook below; read after
  // the retry result is applied so a stopped turn's parked delivery can be
  // re-nudged due immediately (see the comment at the nudge site).
  let urgentStopOutcome: UrgentBusyTurnStopOutcome | null = null;
  try {
    const sourceTaskGuard = sourceTaskGuardForClaim(claim, hooks.projectId);
    const validateParentWakeTarget = async (): Promise<PromptDeliveryResult | null> => {
      try {
        return await invalidParentWakeTargetResult(env, hooks.projectId, claim);
      } catch (error) {
        return sourceValidationReadFailure(claim, error, 'Parent wake target validation');
      }
    };
    const validateProjectEventWakeTarget = async (): Promise<PromptDeliveryResult | null> => {
      const localInvalid = invalidProjectEventWakeDeliveryTargetResult(
        sql,
        env,
        hooks.projectId,
        claim
      );
      if (localInvalid) return localInvalid;
      try {
        const sourceInvalid = await invalidProjectEventWakeSourceTaskResult(
          env,
          hooks.projectId,
          claim
        );
        if (sourceInvalid) return sourceInvalid;
        const providerHold = await providerLimitEventDeliveryGuard(
          sql,
          env,
          hooks.projectId,
          claim
        );
        if (providerHold) return providerHold;
        return invalidProjectEventWakeDeliveryTargetResult(sql, env, hooks.projectId, claim);
      } catch (error) {
        return sourceValidationReadFailure(
          claim,
          error,
          'Project event wake source authority validation'
        );
      }
    };
    const validateDeliveryTarget = async (): Promise<PromptDeliveryResult | null> =>
      invalidSessionWriterSenderResult(sql, claim) ??
      (await validateParentWakeTarget()) ??
      (await validateProjectEventWakeTarget()) ??
      (await invalidScheduledDeliveryTarget(sql, env, hooks.projectId, claim)) ??
      (await invalidCheckpointContinuationTarget(sql, env, hooks.projectId, claim));
    // Stop-and-deliver: an urgent class rejected because the target is
    // mid-turn may cancel that turn so this delivery becomes the next
    // prompt. Informational classes never stop anything — for them the
    // busy retry path below is byte-for-byte the pre-existing behaviour.
    const input = {
      projectId: hooks.projectId ?? '',
      claim,
      allowLegacyVm: config.legacyVmCompatEnabled,
      requestTimeoutMs: config.backgroundTimeoutMs,
      beforeSideEffect: validateDeliveryTarget,
      beforeSubmit: (capabilities: VmPromptDeliveryCapabilities) =>
        markPromptDeliverySubmitting(sql, claim, capabilities),
      sourceTaskGuard,
      // A steer is never urgent (`canSteerMessageClass`); it must not stop a turn.
      ...(isUrgentMessageClass(claim.message.messageClass) &&
      claim.message.deliveryIntent !== 'steer'
        ? {
            onBusyTurn: async (target: VmPromptDeliveryTarget) => {
              urgentStopOutcome = await stopBusyTurnForUrgentDelivery(
                sql,
                env,
                hooks,
                claim,
                target,
                { requestTimeoutMs: config.backgroundTimeoutMs }
              );
            },
          }
        : {}),
    };
    result = (await validateDeliveryTarget()) ?? (await dispatchClaim(adapter, claim, input));
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

  if (result.kind === 'accepted') {
    try {
      await releaseAcceptedProviderLimitSchedule(sql, env, hooks.projectId, claim, result);
    } catch {
      result = {
        kind: 'ambiguous',
        reason: 'receipt_unavailable',
        error: 'Provider continuation acceptance checkpoint unavailable',
        runtimeIdentity: result.runtimeIdentity,
        capabilities: result.capabilities,
        receipt: result.receipt,
      };
      // Keep the submitted claim leased so the existing reconcile mode reads
      // the receipt; terminal ambiguity would strand this accepted continuation.
      log.warn('provider_continuation.checkpoint_retry', {
        messageId: claim.message.id,
        attemptId: claim.attemptId,
      });
      await hooks.recalculateAlarm();
      return result;
    }
  }
  const applied = applyPromptDeliveryResult(sql, claim, result, config);
  // A message sent as a steer keeps a truthful label to the end, including after it
  // fell back to the queue (its inbox intent is then `queue`; the row still says steer,
  // which the label's own predicate checks).
  if (applied && result.kind === 'ambiguous') {
    labelSteerOutcomeOnTranscript(sql, claim, 'unconfirmed', result.reason);
  }
  if (applied && result.kind === 'failed') {
    labelSteerOutcomeOnTranscript(sql, claim, 'failed', result.reason);
  }
  if (applied) {
    advanceProjectEventPromptAttemptCheckpoint(sql, hooks.projectId, claim, result);
  }
  if (applied && result.kind === 'retry' && urgentStopOutcome && urgentStopOutcome !== 'skipped') {
    // The stop reached the VM (or the busy turn had already ended), but this
    // delivery was still `delivering` when the turn-end fan-out nudged the
    // queue, so its own release never happened — it just parked with ordinary
    // backoff. Pull it due immediately: the claim engine orders by message
    // class, so the urgent delivery now outranks any sibling the turn-end nudge
    // released and becomes the target's next prompt instead of being jumped.
    // A skipped stop (transport failure) keeps the backoff so a broken node
    // cannot be hot-looped.
    hooks.nudgeDeliveries(claim.message.targetSessionId);
  }
  if (applied && result.kind === 'accepted') {
    sessionState.markPromptAccepted(
      sql,
      result.acpSessionId,
      result.promptEpoch,
      result.promptEpoch
    );
  }
  if (applied && result.kind === 'failed' && result.reason === 'wake_refused') {
    raiseSessionWakeFailure(
      sql,
      {
        sessionId: claim.message.targetSessionId,
        taskId: claim.message.sourceTaskId,
        deliveryId: claim.message.id,
        reason: result.reason,
        detail: result.error,
      },
      hooks.broadcastEvent
    );
    hooks.scheduleSummarySync();
  }

  const metric = (
    {
      accepted: 'prompt_delivery_accepted',
      retry: 'prompt_delivery_retry',
      failed: 'prompt_delivery_failed',
      ambiguous: 'prompt_delivery_ambiguous',
      steered: 'prompt_delivery_steered',
      steer_fallback: 'prompt_delivery_steer_fallback',
      steer_pending: 'prompt_delivery_steer_pending',
    } as const
  )[result.kind];
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
        userMessageAt: claim.message.createdAt,
        preparationStartedAt: startedAt,
        resultAppliedAt: Date.now(),
        runtimeAcceptedAt: result.kind === 'accepted' ? result.promptEpoch : null,
        wakeReadyAt:
          sql
            .exec(
              'SELECT ready_at FROM session_wake_readiness WHERE session_id = ?',
              claim.message.targetSessionId
            )
            .toArray()[0]?.ready_at ?? null,
      })
    );
    const update = deliveryUpdateForResult(claim, result);
    if (update) {
      hooks.broadcastEvent('mailbox.delivery_updated', update, claim.message.targetSessionId);
    }
    if (result.kind === 'steer_fallback') {
      // The message is now an ordinary queued prompt; deliver it as soon as the
      // queue lane allows (behind a busy turn, it waits like any other).
      hooks.nudgeDeliveries(claim.message.targetSessionId);
    }
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
