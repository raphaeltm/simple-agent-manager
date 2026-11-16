import { createModuleLogger, serializeError } from '@simple-agent-manager/worker-core';

import * as activity from './activity';
import { persistSystemMessage } from './messages';
import { projectDataPorts } from './ports';
import type { Env } from './types';

const log = createModuleLogger('project_data.wake_failure');
export const WAKE_FAILED_ATTENTION_KIND = 'wake_failed';

/**
 * A failed wake is one inbox error item in D1 `asks` (inbox slice E, dedupe key
 * `error:wake:<sessionId>`), not an attention marker: the chat list reads it back as its
 * `wake_failed` attention (`@simple-agent-manager/worker-core` `readOpenQuestionAttention`). A
 * repeat failure while the item is open updates it and posts nothing new in the chat.
 */
export interface RaiseSessionWakeFailureInput {
  sessionId: string;
  taskId?: string | null;
  deliveryId?: string | null;
  reason: string;
  detail?: string | null;
}

export async function raiseSessionWakeFailure(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  input: RaiseSessionWakeFailureInput,
  broadcastEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void
): Promise<{ askId: string | null; messageId: string | null; inserted: boolean }> {
  const session = sql
    .exec(
      `SELECT id, task_id, workspace_id, created_by_user_id, topic
         FROM chat_sessions
        WHERE id = ?
        LIMIT 1`,
      input.sessionId
    )
    .toArray()[0];
  if (!session) return { askId: null, messageId: null, inserted: false };

  const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
  const taskId = input.taskId ?? text(session.task_id);
  const workspaceId = text(session.workspace_id);
  const detail = input.detail?.trim();
  const message =
    detail && detail !== input.reason ? `Wake failed: ${detail}` : `Wake failed: ${input.reason}`;

  let filed: { id: string; created: boolean } | null = null;
  if (projectId) {
    try {
      filed = await projectDataPorts().inboxErrors.fileWakeFailure(env, {
        projectId,
        sessionId: input.sessionId,
        taskId,
        createdByUserId: text(session.created_by_user_id),
        topic: text(session.topic),
      });
    } catch (error) {
      log.error('wake_failure.inbox_item_failed', {
        sessionId: input.sessionId,
        reason: input.reason,
        ...serializeError(error),
      });
    }
  }
  if (filed && !filed.created) {
    log.info('wake_failure.already_visible', {
      sessionId: input.sessionId,
      deliveryId: input.deliveryId ?? null,
      reason: input.reason,
      askId: filed.id,
    });
    return { askId: filed.id, messageId: null, inserted: false };
  }
  const markerId = filed?.id ?? null;

  const persisted = persistSystemMessage(sql, input.sessionId, message);
  activity.recordActivityEventInternal(
    sql,
    'session.wake_failed',
    'system',
    null,
    workspaceId,
    input.sessionId,
    taskId,
    JSON.stringify({
      deliveryId: input.deliveryId ?? null,
      reason: input.reason,
      detail: detail ?? null,
      attentionMarkerId: markerId,
      messageId: persisted?.id ?? null,
    })
  );
  broadcastEvent(
    'session.wake_failed',
    {
      sessionId: input.sessionId,
      taskId,
      workspaceId,
      deliveryId: input.deliveryId ?? null,
      reason: input.reason,
      detail: detail ?? null,
      attentionMarkerId: markerId,
      messageId: persisted?.id ?? null,
    },
    input.sessionId
  );
  if (persisted) {
    broadcastEvent(
      'message.new',
      {
        sessionId: input.sessionId,
        messageId: persisted.id,
        role: 'system',
        content: message,
        toolMetadata: null,
        createdAt: persisted.now,
        sequence: persisted.sequence,
      },
      input.sessionId
    );
  }

  log.warn('wake_failure.visible', {
    sessionId: input.sessionId,
    taskId,
    workspaceId,
    deliveryId: input.deliveryId ?? null,
    reason: input.reason,
    detail: detail ?? null,
    attentionMarkerId: markerId,
    messageId: persisted?.id ?? null,
  });

  return { askId: markerId, messageId: persisted?.id ?? null, inserted: true };
}
