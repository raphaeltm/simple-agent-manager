import type {
  CheckpointEpisodeTransitionInput,
  CreateCheckpointEpisodeInput,
} from '@simple-agent-manager/shared';

import { createModuleLogger, serializeError } from '../../lib/logger';
import { recordDurableExecutionMetric } from '../../services/telemetry';
import { DefaultVmPromptDeliveryAdapter } from '../../services/vm-prompt-delivery-adapter';
import * as activityEvents from './activity';
import * as attention from './attention';
import * as checkpoints from './checkpoint-episodes';
import { resolveDurableExecutionConfig } from './durable-execution-config';
import * as idleCleanup from './idle-cleanup';
import * as mailbox from './mailbox';
import * as delivery from './prompt-delivery';
import { runPromptDeliveryClaim } from './prompt-delivery-runner';
import * as sessionState from './session-state';
import type { Env } from './types';

const log = createModuleLogger('project_data.durability_foundation');

export interface DurabilityFoundationHooks {
  getProjectId(): string | null;
  transactionSync<T>(callback: () => T): T;
  waitUntil(promise: Promise<unknown>): void;
  recalculateAlarm(): Promise<void>;
  scheduleSummarySync(): void;
  broadcastEvent(type: string, payload: Record<string, unknown>, sessionId?: string): void;
}

export async function acceptPromptDelivery(
  sql: SqlStorage,
  env: Env,
  hooks: DurabilityFoundationHooks,
  input: delivery.AcceptPromptDeliveryInput,
): Promise<delivery.AcceptedPromptDelivery> {
  const accepted = hooks.transactionSync(() => delivery.acceptPromptDelivery(sql, env, input));
  if (accepted.transcriptInserted) {
    idleCleanup.resetIdleCleanup(sql, env, input.targetSessionId);
    if (input.senderType === 'human') {
      attention.resolveAttentionMarkers(
        sql,
        input.targetSessionId,
        accepted.transcriptMessageId,
        'human',
        'human_message',
      );
    }
    if (accepted.workspaceId) {
      activityEvents.updateMessageActivity(sql, accepted.workspaceId, input.targetSessionId);
    }
    hooks.scheduleSummarySync();
    hooks.broadcastEvent('message.new', {
      sessionId: input.targetSessionId,
      messageId: accepted.transcriptMessageId,
      role: 'user',
      content: input.displayContent.trim(),
      toolMetadata: {
        ...(input.metadata ?? {}),
        source: input.sourceKind,
        kind: 'durable_prompt_delivery',
        deliveryId: accepted.message.id,
      },
      createdAt: accepted.transcriptCreatedAt,
      sequence: accepted.transcriptSequence,
      origin: null,
    }, input.targetSessionId);
  }
  hooks.broadcastEvent('mailbox.enqueued', {
    messageId: accepted.message.id,
    messageClass: accepted.message.messageClass,
    targetSessionId: accepted.message.targetSessionId,
    sourceKind: accepted.message.sourceKind,
  }, input.targetSessionId);
  await hooks.recalculateAlarm();
  return accepted;
}

export async function reportActivity(
  sql: SqlStorage,
  hooks: DurabilityFoundationHooks,
  sessionId: string,
  currentActivity: string,
  extra?: {
    promptStartedAt?: number | null;
    agentType?: string | null;
    restartCount?: number | null;
    statusError?: string | null;
    runtimeWorkState?: 'inactive' | 'active' | 'settling';
    runtimeWorkCount?: number;
    runtimeWorkSource?: string;
    runtimeWorkProgressAt?: number | null;
  },
): Promise<void> {
  sessionState.upsertActivityState(sql, sessionId, {
    activity: currentActivity,
    promptStartedAt: extra?.promptStartedAt,
    agentType: extra?.agentType,
    restartCount: extra?.restartCount,
    statusError: extra?.statusError,
    runtimeWorkState: extra?.runtimeWorkState,
    runtimeWorkCount: extra?.runtimeWorkCount,
    runtimeWorkSource: extra?.runtimeWorkSource,
    runtimeWorkProgressAt: extra?.runtimeWorkProgressAt,
  });
  const acpRow = sql.exec(
    'SELECT chat_session_id FROM acp_sessions WHERE id = ?',
    sessionId,
  ).toArray()[0];
  const chatSessionId = typeof acpRow?.chat_session_id === 'string'
    ? acpRow.chat_session_id
    : sessionId;
  const persistedState = sessionState.getSessionState(sql, sessionId);
  hooks.broadcastEvent('session.activity', {
    sessionId: chatSessionId,
    activity: currentActivity,
    promptStartedAt: extra?.promptStartedAt ?? persistedState?.promptStartedAt ?? null,
  }, chatSessionId);
  if (currentActivity === 'idle' && delivery.nudgePromptDeliveriesForTarget(sql, chatSessionId) > 0) {
    await hooks.recalculateAlarm();
  }
}

export function createCheckpointEpisode(
  sql: SqlStorage,
  env: Env,
  hooks: DurabilityFoundationHooks,
  input: CreateCheckpointEpisodeInput,
) {
  const result = hooks.transactionSync(() => checkpoints.createCheckpointEpisode(sql, input));
  if (!result.created) return result;
  recordDurableExecutionMetric({
    metric: 'checkpoint_episode_transition',
    projectId: hooks.getProjectId(),
    sessionId: input.sessionId,
    checkpointEpisodeId: result.episode.id,
    attemptCount: result.episode.attemptCount,
    reason: 'planned',
  }, env as unknown as import('../../env').Env);
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
    }),
  );
  hooks.broadcastEvent('checkpoint_episode.created', {
    episodeId: result.episode.id,
    sessionId: input.sessionId,
    state: result.episode.state,
  }, input.sessionId);
  return result;
}

export function transitionCheckpointEpisode(
  sql: SqlStorage,
  env: Env,
  hooks: DurabilityFoundationHooks,
  episodeId: string,
  input: CheckpointEpisodeTransitionInput,
) {
  const before = checkpoints.getCheckpointEpisode(sql, episodeId);
  const episode = hooks.transactionSync(() =>
    checkpoints.transitionCheckpointEpisode(sql, episodeId, input));
  if (!episode || !before || episode.state === before.state) return episode;
  recordDurableExecutionMetric({
    metric: 'checkpoint_episode_transition',
    projectId: hooks.getProjectId(),
    sessionId: episode.sessionId,
    checkpointEpisodeId: episode.id,
    attemptCount: episode.attemptCount,
    reason: `${before.state}->${episode.state}`,
  }, env as unknown as import('../../env').Env);
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
    }),
  );
  hooks.broadcastEvent('checkpoint_episode.updated', {
    episodeId,
    sessionId: episode.sessionId,
    fromState: before.state,
    toState: episode.state,
  }, episode.sessionId);
  return episode;
}

export function getDurableExecutionSnapshot(sql: SqlStorage, env: Env, sessionId: string) {
  const acpRow = sql.exec(
    `SELECT id FROM acp_sessions
     WHERE chat_session_id = ?
     ORDER BY created_at DESC
     LIMIT 1`,
    sessionId,
  ).toArray()[0];
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
  hooks: DurabilityFoundationHooks,
): void {
  try {
    const config = resolveDurableExecutionConfig(env);
    if (!config.deliveryEnabled) return;
    const claims = hooks.transactionSync(() => delivery.claimDuePromptDeliveries(sql, config));
    const adapter = new DefaultVmPromptDeliveryAdapter(
      env as unknown as import('../../env').Env,
    );
    for (const claim of claims) {
      hooks.waitUntil(runPromptDeliveryClaim(sql, env, config, claim, adapter, {
        projectId: hooks.getProjectId(),
        recalculateAlarm: hooks.recalculateAlarm,
        broadcastEvent: hooks.broadcastEvent,
      }).catch((error) => {
        log.error('alarm.prompt_delivery_claim_failed', {
          messageId: claim.message.id,
          attemptId: claim.attemptId,
          ...serializeError(error),
        });
      }));
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
