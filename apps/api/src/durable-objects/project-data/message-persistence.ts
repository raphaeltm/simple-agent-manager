import { createModuleLogger } from '../../lib/logger';
import * as activity from './activity';
import * as attention from './attention';
import * as idleCleanup from './idle-cleanup';
import * as messages from './messages';
import * as sessionState from './session-state';
import type { Env } from './types';

const log = createModuleLogger('project_data.messages');

export type BatchMessageInput = {
  messageId: string;
  role: string;
  content: string;
  toolMetadata: string | null;
  timestamp: string;
  sequence?: number;
};

export type MessagePersistenceHooks = {
  recalculateAlarm: () => Promise<void>;
  scheduleSummarySync: () => void;
  broadcastEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void;
};

export async function persistMessageWithSideEffects(
  sql: SqlStorage,
  env: Env,
  hooks: MessagePersistenceHooks,
  sessionId: string,
  role: string,
  content: string,
  toolMetadata: string | null,
): Promise<string> {
  const result = messages.persistMessage(sql, env, sessionId, role, content, toolMetadata);
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

  await resolveAttentionForRoles(sql, hooks, sessionId, [{ id: result.id, role }]);

  if (result.workspaceId) activity.updateMessageActivity(sql, result.workspaceId, sessionId);
  hooks.scheduleSummarySync();
  hooks.broadcastEvent(
    'message.new',
    {
      sessionId,
      messageId: result.id,
      role,
      content,
      toolMetadata: parseToolMetadata(toolMetadata, sessionId),
      createdAt: result.now,
      sequence: result.sequence,
    },
    sessionId,
  );
  return result.id;
}

export async function persistMessageBatchWithSideEffects(
  sql: SqlStorage,
  env: Env,
  hooks: MessagePersistenceHooks,
  sessionId: string,
  batchMessages: BatchMessageInput[],
): Promise<{ persisted: number; duplicates: number }> {
  const result = messages.persistMessageBatch(sql, env, sessionId, batchMessages);
  if (result.persisted === 0) {
    return { persisted: result.persisted, duplicates: result.duplicates };
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

  await resolveAttentionForRoles(sql, hooks, sessionId, result.persistedMessages);

  if (result.workspaceId) activity.updateMessageActivity(sql, result.workspaceId, sessionId);
  hooks.scheduleSummarySync();
  hooks.broadcastEvent(
    'messages.batch',
    { sessionId, messages: result.persistedMessages, count: result.persisted },
    sessionId,
  );
  return { persisted: result.persisted, duplicates: result.duplicates };
}

async function resolveAttentionForRoles(
  sql: SqlStorage,
  hooks: MessagePersistenceHooks,
  sessionId: string,
  persistedMessages: Array<{ id: string; role: string }>,
): Promise<void> {
  const firstUserMsg = persistedMessages.find((m) => m.role === 'user');
  const firstAssistantMsg = persistedMessages.find((m) => m.role === 'assistant');
  let resolved = 0;
  let reason: string | null = null;

  if (firstUserMsg) {
    resolved = attention.resolveAttentionMarkers(sql, sessionId, firstUserMsg.id, 'human', 'human_message');
    reason = 'human_message';
  } else if (firstAssistantMsg) {
    resolved = attention.resolveAttentionMarkersByKind(
      sql,
      sessionId,
      'reconciliation_checkin',
      firstAssistantMsg.id,
      'agent',
      'agent_message',
    );
    reason = 'agent_message';
  }

  if (resolved > 0 && reason) {
    await hooks.recalculateAlarm();
    hooks.broadcastEvent('attention.resolved', { sessionId, count: resolved, reason }, sessionId);
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
