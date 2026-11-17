import type {
  CheckpointEpisodeTransitionInput,
  CreateCheckpointEpisodeInput,
} from '@simple-agent-manager/shared';
import { createModuleLogger, serializeError } from '@simple-agent-manager/worker-core';

import * as activityEvents from './activity';
import * as attention from './attention';
import * as checkpoints from './checkpoint-episodes';
import { resolveDurableExecutionConfig } from './durable-execution-config';
import * as idleCleanup from './idle-cleanup';
import * as mailbox from './mailbox';
import { projectDataPorts } from './ports';
import * as delivery from './prompt-delivery';
import { runPromptDeliveryClaim } from './prompt-delivery-runner';
import {
  applyProviderLimitDeliveryHold,
  isProviderLimitHoldExpiry,
} from './provider-limit-delivery-hold';
import { releaseQuestionHold } from './reconciliation-candidate-state';
import { resetReconciliationEpisode } from './reconciliation-episode';
import { promptDeliveryToolMetadata } from './sam-notice-metadata';
import * as sessionState from './session-state';
import type { ActivityReportOutcome } from './session-work-clock';
import type { Env } from './types';
import { raiseSessionWakeFailure } from './wake-failure';

const log = createModuleLogger('project_data.durability_foundation');

export interface DurabilityFoundationHooks {
  getProjectId(): string | null;
  transactionSync<T>(callback: () => T): T;
  waitUntil(promise: Promise<unknown>): void;
  recalculateAlarm(): Promise<void>;
  scheduleSummarySync(): void;
  broadcastEvent(type: string, payload: Record<string, unknown>, sessionId?: string): void;
  /** Re-arm the idle timer for a chat session whose turn just ended. */
  armIdleCleanup(chatSessionId: string): void;
  /** Release durable messages queued behind the (now ended) turn. */
  nudgeDeliveries(chatSessionId: string): number;
  /** A person's message answers the chat's open questions in D1 `asks` (`question-asks.ts`). */
  closeQuestionAsks?(
    sessionId: string,
    messageId: string,
    messageCreatedAt: number
  ): Promise<unknown>;
}

export async function acceptPromptDelivery(
  sql: SqlStorage,
  env: Env,
  hooks: DurabilityFoundationHooks,
  input: delivery.AcceptPromptDeliveryInput
): Promise<delivery.AcceptedPromptDelivery> {
  const accepted = hooks.transactionSync(() =>
    delivery.acceptPromptDeliveryInTransaction(sql, env, input)
  );
  const projectId = hooks.getProjectId();
  if (input.senderType === 'human' && projectId) {
    // Only a lane's head is claimed, so a message queued behind a delivery already parked for a
    // provider-limit hold would never learn of the hold and would expire on its ordinary TTL.
    // Apply the hold now. Registered before the fallible finalizer, and for an idempotent retry of
    // the same delivery too, so a failed first attempt cannot skip it. Off the send path; a
    // sleeping chat costs one D1 read, an awake one none.
    hooks.waitUntil(holdAcceptedPromptDelivery(sql, env, hooks, projectId, input.targetSessionId));
  }
  await finalizeAcceptedPromptDelivery(sql, env, hooks, input, accepted);
  return accepted;
}

async function holdAcceptedPromptDelivery(
  sql: SqlStorage,
  env: Env,
  hooks: DurabilityFoundationHooks,
  projectId: string,
  sessionId: string
): Promise<void> {
  try {
    const held = await applyProviderLimitDeliveryHold(sql, env.DATABASE, {
      projectId,
      sessionId,
      ttlMs: resolveDurableExecutionConfig(env).ttlMs,
    });
    if (!held) return;
    if (held.closedWakeAsks > 0) hooks.scheduleSummarySync();
    if (held.rowsChanged > 0) await hooks.recalculateAlarm();
  } catch (error) {
    log.error('prompt_delivery.accept_provider_limit_hold_failed', {
      sessionId,
      ...serializeError(error),
    });
  }
}

export async function finalizeAcceptedPromptDelivery(
  sql: SqlStorage,
  _env: Env,
  hooks: DurabilityFoundationHooks,
  input: delivery.AcceptPromptDeliveryInput,
  accepted: delivery.AcceptedPromptDelivery
): Promise<void> {
  let hookError: unknown = null;
  let alarmError: unknown = null;
  try {
    runAcceptedPromptDeliveryHooks(sql, _env, hooks, input, accepted);
  } catch (error) {
    hookError = error;
  } finally {
    try {
      await hooks.recalculateAlarm();
    } catch (error) {
      alarmError = error;
    }
  }
  if (hookError) {
    if (alarmError) {
      log.error('prompt_delivery.finalizer_alarm_recalculate_failed', serializeError(alarmError));
    }
    throw hookError;
  }
  if (alarmError) throw alarmError;
  // A person's prompt answers the chat's open questions in D1 `asks`, after the broadcast and the
  // alarm so the D1 round trip delays neither (`question-asks.ts`, never throws).
  if (accepted.transcriptInserted && input.senderType === 'human') {
    await hooks.closeQuestionAsks?.(
      input.targetSessionId,
      accepted.transcriptMessageId,
      accepted.transcriptCreatedAt
    );
  }
}

function runAcceptedPromptDeliveryHooks(
  sql: SqlStorage,
  env: Env,
  hooks: DurabilityFoundationHooks,
  input: delivery.AcceptPromptDeliveryInput,
  accepted: delivery.AcceptedPromptDelivery
): void {
  // The answer or archive of a question held in D1 `asks` reaches the agent here (`inbox_ask`,
  // `apps/api/src/services/inbox/ask-notice.ts`); the chat list clears its question live, as it
  // did when a question marker resolved.
  const questionAskId = input.sourceKind === 'inbox_ask' ? input.metadata?.questionAskId : null;
  if (typeof questionAskId === 'string' && questionAskId) {
    releaseQuestionHold(sql, input.targetSessionId);
    hooks.broadcastEvent(
      'attention.resolved',
      {
        sessionId: input.targetSessionId,
        markerId: questionAskId,
        reason: typeof input.metadata?.outcome === 'string' ? input.metadata.outcome : null,
      },
      input.targetSessionId
    );
  }
  if (accepted.transcriptInserted) {
    idleCleanup.resetIdleCleanup(sql, env, input.targetSessionId);
    if (input.senderType === 'human') {
      resetReconciliationEpisode(sql, input.targetSessionId);
      attention.resolveAttentionMarkers(
        sql,
        input.targetSessionId,
        accepted.transcriptMessageId,
        'human',
        'human_message'
      );
    }
    if (accepted.workspaceId) {
      activityEvents.updateMessageActivity(sql, accepted.workspaceId, input.targetSessionId);
    }
    hooks.scheduleSummarySync();
    hooks.broadcastEvent(
      'message.new',
      {
        sessionId: input.targetSessionId,
        messageId: accepted.transcriptMessageId,
        role: 'user',
        content: input.displayContent.trim(),
        // The same builder as the persisted row, so a live client sees the steer state and
        // the notice exactly as a reload would.
        toolMetadata: promptDeliveryToolMetadata(
          input,
          accepted.message.id,
          accepted.message.deliveryIntent
        ),
        createdAt: accepted.transcriptCreatedAt,
        sequence: accepted.transcriptSequence,
        origin: null,
      },
      input.targetSessionId
    );
  }
  hooks.broadcastEvent(
    'mailbox.enqueued',
    {
      messageId: accepted.message.id,
      messageClass: accepted.message.messageClass,
      targetSessionId: accepted.message.targetSessionId,
      sourceKind: accepted.message.sourceKind,
    },
    input.targetSessionId
  );
}

export async function reportActivity(
  sql: SqlStorage,
  hooks: DurabilityFoundationHooks,
  sessionId: string,
  currentActivity: string,
  extra?: {
    observedAt?: number | null;
    promptStartedAt?: number | null;
    agentType?: string | null;
    restartCount?: number | null;
    statusError?: string | null;
    runtimeWorkState?: 'inactive' | 'active' | 'settling';
    runtimeWorkCount?: number;
    runtimeWorkSource?: string;
    runtimeWorkProgressAt?: number | null;
    steeringSupported?: boolean;
  }
): Promise<ActivityReportOutcome> {
  const applied = sessionState.upsertActivityState(sql, sessionId, {
    activity: currentActivity,
    observedAt: extra?.observedAt,
    promptStartedAt: extra?.promptStartedAt,
    agentType: extra?.agentType,
    restartCount: extra?.restartCount,
    statusError: extra?.statusError,
    runtimeWorkState: extra?.runtimeWorkState,
    runtimeWorkCount: extra?.runtimeWorkCount,
    runtimeWorkSource: extra?.runtimeWorkSource,
    runtimeWorkProgressAt: extra?.runtimeWorkProgressAt,
    steeringSupported: extra?.steeringSupported,
  });
  if (!applied) {
    log.info('activity_report_stale_rejected', {
      sessionId,
      activity: currentActivity,
      observedAt: extra?.observedAt ?? null,
    });
    return false;
  }
  const acpRow = sql
    .exec('SELECT chat_session_id FROM acp_sessions WHERE id = ?', sessionId)
    .toArray()[0];
  const chatSessionId =
    typeof acpRow?.chat_session_id === 'string' ? acpRow.chat_session_id : sessionId;
  const persistedState = sessionState.getSessionState(sql, sessionId);
  hooks.broadcastEvent(
    'session.activity',
    {
      sessionId: chatSessionId,
      activity: currentActivity,
      promptStartedAt: extra?.promptStartedAt ?? persistedState?.promptStartedAt ?? null,
      steeringSupported: persistedState?.steeringSupported ?? null,
    },
    chatSessionId
  );
  if (
    currentActivity === 'idle' &&
    delivery.nudgePromptDeliveriesForTarget(sql, chatSessionId) > 0
  ) {
    await hooks.recalculateAlarm();
  }
  return applied;
}

export function createCheckpointEpisode(
  sql: SqlStorage,
  env: Env,
  hooks: DurabilityFoundationHooks,
  input: CreateCheckpointEpisodeInput
) {
  const result = hooks.transactionSync(() => checkpoints.createCheckpointEpisode(sql, input));
  if (!result.created) return result;
  projectDataPorts().observability.recordDurableExecutionMetric(env, {
    metric: 'checkpoint_episode_transition',
    projectId: hooks.getProjectId(),
    sessionId: input.sessionId,
    checkpointEpisodeId: result.episode.id,
    attemptCount: result.episode.attemptCount,
    reason: 'planned',
  });
  activityEvents.recordActivityEventInternal(
    sql,
    'checkpoint_episode.planned',
    'system',
    null,
    input.workspaceId ?? null,
    input.sessionId,
    input.taskId ?? null,
    JSON.stringify({
      episodeId: result.episode.id,
      acpSessionId: input.acpSessionId,
      promptEpoch: input.promptEpoch,
      reason: input.reason,
    })
  );
  hooks.broadcastEvent(
    'checkpoint_episode.created',
    {
      episodeId: result.episode.id,
      sessionId: input.sessionId,
      state: result.episode.state,
    },
    input.sessionId
  );
  return result;
}

export function transitionCheckpointEpisode(
  sql: SqlStorage,
  env: Env,
  hooks: DurabilityFoundationHooks,
  episodeId: string,
  input: CheckpointEpisodeTransitionInput
) {
  const before = checkpoints.getCheckpointEpisode(sql, episodeId);
  const episode = hooks.transactionSync(() =>
    checkpoints.transitionCheckpointEpisode(sql, episodeId, input)
  );
  if (!episode || !before || episode.state === before.state) return episode;
  projectDataPorts().observability.recordDurableExecutionMetric(env, {
    metric: 'checkpoint_episode_transition',
    projectId: hooks.getProjectId(),
    sessionId: episode.sessionId,
    checkpointEpisodeId: episode.id,
    attemptCount: episode.attemptCount,
    reason: `${before.state}->${episode.state}`,
  });
  activityEvents.recordActivityEventInternal(
    sql,
    `checkpoint_episode.${episode.state}`,
    'system',
    null,
    episode.workspaceId,
    episode.sessionId,
    episode.taskId,
    JSON.stringify({
      episodeId,
      fromState: before.state,
      toState: episode.state,
      attemptCount: episode.attemptCount,
      hasError: episode.lastError !== null,
    })
  );
  hooks.broadcastEvent(
    'checkpoint_episode.updated',
    {
      episodeId,
      sessionId: episode.sessionId,
      fromState: before.state,
      toState: episode.state,
    },
    episode.sessionId
  );
  return episode;
}

export function getDurableExecutionSnapshot(sql: SqlStorage, env: Env, sessionId: string) {
  const acpRow = sql
    .exec(
      `SELECT id FROM acp_sessions
     WHERE chat_session_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
      sessionId
    )
    .toArray()[0];
  const acpSessionId = typeof acpRow?.id === 'string' ? acpRow.id : sessionId;
  const deliveryResult = mailbox.listMessages(sql, { targetSessionId: sessionId, limit: 50 });
  return {
    featureConfig: resolveDurableExecutionConfig(env),
    sessionState: sessionState.getSessionState(sql, acpSessionId),
    promptEpoch: sessionState.getPromptEpoch(sql, acpSessionId),
    checkpointEpisodes: checkpoints.listCheckpointEpisodes(sql, sessionId, 50),
    deliveries: deliveryResult.messages,
    deliveryTotal: deliveryResult.total,
  };
}

export function processPromptDeliveryAlarm(
  sql: SqlStorage,
  env: Env,
  hooks: DurabilityFoundationHooks
): void {
  try {
    const config = resolveDurableExecutionConfig(env);
    if (!config.deliveryEnabled) return;
    const expired = hooks.transactionSync(() => delivery.expireDuePromptDeliveries(sql, config));
    if (expired.expiredWakeFailures.length > 0) {
      // Filing the inbox item is a D1 write, so it runs after this synchronous alarm step.
      hooks.waitUntil(
        (async () => {
          // One raise per chat: several deliveries expiring together are one visible failure,
          // and each costs several D1 round trips. Each chat is isolated, so one throw cannot
          // cost the others their signal (these deliveries are already expired; nothing retries).
          const seen = new Set<string>();
          for (const wakeFailure of expired.expiredWakeFailures) {
            if (seen.has(wakeFailure.targetSessionId)) continue;
            try {
              // A chat held by a provider usage limit cannot wake until the hold ends. A delivery
              // that is not a person's message expires there on its own deadline (an event batch,
              // a schedule, a parent wake): that is the hold, which the chat already shows, not a
              // failed wake. A person's message is kept for the hold
              // (`provider-limit-delivery-hold.ts`), so one that expires anyway is really lost
              // (its hold lookup failed, or the hold outlived the saved snapshot) and is always
              // reported. A failed lookup reports too.
              if (
                wakeFailure.senderType !== 'human' &&
                (await isProviderLimitHoldExpiry(
                  env.DATABASE,
                  hooks.getProjectId(),
                  wakeFailure.targetSessionId
                ))
              ) {
                log.info('alarm.wake_failure_suppressed_provider_limit_hold', {
                  sessionId: wakeFailure.targetSessionId,
                  deliveryId: wakeFailure.deliveryId,
                  reason: wakeFailure.terminalReason,
                });
                continue;
              }
              seen.add(wakeFailure.targetSessionId);
              await raiseSessionWakeFailure(
                sql,
                env,
                hooks.getProjectId(),
                {
                  sessionId: wakeFailure.targetSessionId,
                  taskId: wakeFailure.sourceTaskId,
                  deliveryId: wakeFailure.deliveryId,
                  reason: wakeFailure.terminalReason,
                  detail:
                    wakeFailure.lastError ??
                    'SAM retried the wake until the delivery expired, but the session did not wake.',
                },
                hooks.broadcastEvent
              );
            } catch (error) {
              log.error('alarm.wake_failure_failed', {
                sessionId: wakeFailure.targetSessionId,
                deliveryId: wakeFailure.deliveryId,
                ...serializeError(error),
              });
            }
          }
          hooks.scheduleSummarySync();
        })().catch((error) => {
          log.error('alarm.wake_failure_failed', serializeError(error));
        })
      );
    }
    const claims = hooks.transactionSync(() => delivery.claimDuePromptDeliveries(sql, config));
    const adapter = projectDataPorts().runtime.createPromptDeliveryAdapter(env);
    for (const claim of claims) {
      hooks.waitUntil(
        runPromptDeliveryClaim(sql, env, config, claim, adapter, {
          projectId: hooks.getProjectId(),
          recalculateAlarm: hooks.recalculateAlarm,
          broadcastEvent: hooks.broadcastEvent,
          armIdleCleanup: hooks.armIdleCleanup,
          nudgeDeliveries: hooks.nudgeDeliveries,
          scheduleSummarySync: hooks.scheduleSummarySync,
        }).catch((error) => {
          log.error('alarm.prompt_delivery_claim_failed', {
            messageId: claim.message.id,
            attemptId: claim.attemptId,
            ...serializeError(error),
          });
        })
      );
    }
  } catch (error) {
    log.error('alarm.prompt_delivery_failed_closed', serializeError(error));
  }
}

export const checkpointEpisodeReads = {
  get: checkpoints.getCheckpointEpisode,
  getByPrompt: checkpoints.getCheckpointEpisodeByPrompt,
  list: checkpoints.listCheckpointEpisodes,
};
