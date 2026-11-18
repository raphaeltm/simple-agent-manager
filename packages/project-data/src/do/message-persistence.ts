import { createModuleLogger } from '@simple-agent-manager/worker-core';

import * as activity from './activity';
import * as attention from './attention';
import * as idleCleanup from './idle-cleanup';
import type { MessageIngestMetrics } from './message-ingest-metrics';
import type { MessageIngestSource, MessageMergeConfig } from './message-stream-ingest';
import * as messages from './messages';
import { observeReconciliationMessage } from './reconciliation-episode';
import * as sessionState from './session-state';
import type { SessionIdentityGuard } from './sessions';
import { hydrateCanonicalTools } from './tool-call-hydration';
import type { Env } from './types';

const log = createModuleLogger('project_data.messages');

export type BatchMessageInput = {
  messageId: string;
  role: string;
  content: string;
  toolMetadata: string | null;
  timestamp: string;
  sequence?: number;
  origin?: string | null;
};

export type MessagePersistenceHooks = {
  isLegacyToolClient?: (sessionId: string) => boolean;
  recordMessageIngest?: (metrics: MessageIngestMetrics) => void;
  transactionSync?: <T>(fn: () => T) => T;
  recalculateAlarm: () => Promise<void>;
  scheduleSummarySync: () => void;
  broadcastEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void;
  /**
   * A person's chat message answers the chat's open questions in D1 `asks` (inbox slice G), as it
   * resolves its attention markers. Never throws (`question-asks.ts`).
   */
  closeQuestionAsks?: (
    sessionId: string,
    messageId: string,
    messageCreatedAt: number
  ) => Promise<unknown>;
};

export type MessageBatchPersistenceResult = {
  persisted: number;
  duplicates: number;
  limitReached: boolean;
  maxMessages: number;
  remainingCapacity: number;
};

export async function persistMessageWithSideEffects(
  sql: SqlStorage,
  env: Env,
  hooks: MessagePersistenceHooks,
  sessionId: string,
  role: string,
  content: string,
  toolMetadata: string | null,
  messageId?: string,
  guard?: SessionIdentityGuard | null
): Promise<string> {
  const result = messages.persistMessage(
    sql,
    env,
    sessionId,
    role,
    content,
    toolMetadata,
    messageId,
    guard
  );
  if (!result.inserted) return result.id;

  await runPersistedMessageSideEffects(sql, env, hooks, sessionId, role, content, result);
  return result.id;
}

export async function runPersistedMessageSideEffects(
  sql: SqlStorage,
  env: Env,
  hooks: MessagePersistenceHooks,
  sessionId: string,
  role: string,
  content: string,
  result: {
    id: string;
    now: number;
    sequence: number;
    workspaceId: string | null;
    toolMetadata: string | null;
  }
): Promise<void> {
  const attentionResolution = resolveAttentionForRoles(sql, hooks, sessionId, [
    { id: result.id, role },
  ]);
  observeReconciliationMessage(
    sql,
    env,
    sessionId,
    { id: result.id, role, content, toolMetadata: result.toolMetadata },
    hooks.broadcastEvent
  );
  await attentionResolution;
  const idleReset = idleCleanup.resetIdleCleanup(sql, env, sessionId);
  if (idleReset.cleanupAt > 0) await hooks.recalculateAlarm();

  // Extract plan state from plan-role messages
  if (role === 'plan' && content) {
    try {
      sessionState.updateCurrentPlan(sql, sessionId, content);
    } catch (err) {
      log.warn('project_data.plan_extraction_failed', { sessionId, error: String(err) });
    }
  }

  sessionState.refreshWorkingActivityForChatSession(sql, sessionId, result.now, result.now);

  if (result.workspaceId) activity.updateMessageActivity(sql, result.workspaceId, sessionId);
  hooks.scheduleSummarySync();
  hooks.broadcastEvent(
    'message.new',
    {
      sessionId,
      messageId: result.id,
      role,
      content,
      toolMetadata: parseToolMetadata(result.toolMetadata, sessionId),
      createdAt: result.now,
      sequence: result.sequence,
      // The single-message path only persists browser/RPC user messages, which
      // are never system-injected — origin is always null here. Emitting it
      // keeps the message.new payload shape aligned with messages.batch (which
      // carries origin) so live consumers see a stable contract.
      origin: null,
    },
    sessionId
  );
  await closeQuestionsForHumanMessage(hooks, sessionId, [
    { id: result.id, role, createdAt: result.now },
  ]);
}

export async function persistMessageBatchWithSideEffects(
  sql: SqlStorage,
  env: Env,
  hooks: MessagePersistenceHooks,
  sessionId: string,
  batchMessages: BatchMessageInput[],
  merge?: {
    source?: MessageIngestSource;
    config: MessageMergeConfig;
    metrics?: MessageIngestMetrics;
  }
): Promise<MessageBatchPersistenceResult> {
  if (merge && hooks.isLegacyToolClient?.(sessionId))
    merge.config = { ...merge.config, toolLegacyClient: true };
  const hydration =
    merge?.config.toolUpdatesEnabled && merge.source?.outboxIncarnation
      ? await hydrateCanonicalTools(sql, env, sessionId, merge.source, batchMessages, merge.config)
      : undefined;
  // Browser admission may interleave with R2 I/O; fence legacy caches at commit time.
  if (merge && hooks.isLegacyToolClient?.(sessionId))
    merge.config = { ...merge.config, toolLegacyClient: true };
  const persist = () =>
    messages.persistMessageBatch(
      sql,
      env,
      sessionId,
      batchMessages,
      merge ? { ...merge, hydration } : undefined
    );
  const result = hooks.transactionSync ? hooks.transactionSync(persist) : persist();
  if (merge?.metrics) merge.metrics.toolHydratedRows = hydration?.size ?? 0;
  // Publish only after the synchronous transaction commits; later effects may fail.
  if (merge?.metrics) hooks.recordMessageIngest?.(merge.metrics);
  if (result.persisted === 0) {
    return {
      persisted: result.persisted,
      duplicates: result.duplicates,
      limitReached: result.limitReached,
      maxMessages: result.maxMessages,
      remainingCapacity: result.remainingCapacity,
    };
  }

  const attentionResolution = resolveAttentionForRoles(
    sql,
    hooks,
    sessionId,
    result.persistedMessages
  );
  for (const message of result.persistedMessages) {
    observeReconciliationMessage(sql, env, sessionId, message, hooks.broadcastEvent);
  }
  const idleReset = idleCleanup.resetIdleCleanup(sql, env, sessionId);
  if (idleReset.cleanupAt > 0) await hooks.recalculateAlarm();

  // Extract latest plan message from the batch to update session state
  const lastPlanMsg = [...batchMessages].reverse().find((m) => m.role === 'plan' && m.content);
  if (lastPlanMsg) {
    try {
      sessionState.updateCurrentPlan(sql, sessionId, lastPlanMsg.content);
    } catch (err) {
      log.warn('project_data.batch_plan_extraction_failed', { sessionId, error: String(err) });
    }
  }

  const latestMessageAt = result.persistedMessages.reduce(
    (latest, message) => Math.max(latest, message.createdAt),
    0
  );
  if (latestMessageAt > 0) {
    sessionState.refreshWorkingActivityForChatSession(sql, sessionId, latestMessageAt);
  }

  await attentionResolution;

  if (result.workspaceId) activity.updateMessageActivity(sql, result.workspaceId, sessionId);
  hooks.scheduleSummarySync();
  hooks.broadcastEvent(
    'messages.batch',
    { sessionId, messages: result.broadcastMessages, count: result.persisted },
    sessionId
  );
  for (const append of result.appends)
    hooks.broadcastEvent('message.append', { ...append }, sessionId);
  await closeQuestionsForHumanMessage(hooks, sessionId, result.persistedMessages);
  return {
    persisted: result.persisted,
    duplicates: result.duplicates,
    limitReached: result.limitReached,
    maxMessages: result.maxMessages,
    remainingCapacity: result.remainingCapacity,
  };
}

async function resolveAttentionForRoles(
  sql: SqlStorage,
  hooks: MessagePersistenceHooks,
  sessionId: string,
  persistedMessages: Array<{ id: string; role: string; origin?: string | null }>
): Promise<void> {
  const firstUserMsg = persistedMessages.find((m) => m.role === 'user' && m.origin !== 'system');
  const firstAssistantMsg = persistedMessages.find((m) => m.role === 'assistant');
  let resolved = 0;
  let reason: string | null = null;

  if (firstUserMsg) {
    resolved = attention.resolveAttentionMarkers(
      sql,
      sessionId,
      firstUserMsg.id,
      'human',
      'human_message'
    );
    reason = 'human_message';
  } else if (firstAssistantMsg) {
    resolved = attention.resolveAttentionMarkersByKind(
      sql,
      sessionId,
      'reconciliation_checkin',
      firstAssistantMsg.id,
      'agent',
      'agent_message'
    );
    reason = 'agent_message';
  }

  if (resolved > 0 && reason) {
    await hooks.recalculateAlarm();
    hooks.broadcastEvent('attention.resolved', { sessionId, count: resolved, reason }, sessionId);
  }
}

/**
 * A person's message answers the chat's open questions in D1 `asks` (inbox slice G), as it
 * resolves the chat's markers above. Run after the live broadcast, so a D1 round trip never
 * delays it; never throws (`question-asks.ts`).
 */
async function closeQuestionsForHumanMessage(
  hooks: MessagePersistenceHooks,
  sessionId: string,
  persistedMessages: Array<{
    id: string;
    role: string;
    origin?: string | null;
    createdAt: number;
  }>
): Promise<void> {
  const firstUserMsg = persistedMessages.find((m) => m.role === 'user' && m.origin !== 'system');
  if (firstUserMsg) {
    await hooks.closeQuestionAsks?.(sessionId, firstUserMsg.id, firstUserMsg.createdAt);
  }
}

function parseToolMetadata(toolMetadata: string | null, sessionId: string): unknown {
  if (!toolMetadata) return null;
  try {
    return JSON.parse(toolMetadata);
  } catch (err) {
    log.warn('project_data.tool_metadata_parse_failed', { sessionId, error: String(err) });
    return null;
  }
}
