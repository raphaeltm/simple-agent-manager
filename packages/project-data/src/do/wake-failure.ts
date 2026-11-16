import { createModuleLogger, serializeError } from '@simple-agent-manager/worker-core';

import * as activity from './activity';
import { createAttentionMarker } from './attention';
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
      `SELECT id, task_id, workspace_id, created_by_user_id, topic, status
         FROM chat_sessions
        WHERE id = ?
        LIMIT 1`,
      input.sessionId
    )
    .toArray()[0];
  if (!session) return { askId: null, messageId: null, inserted: false };
  // An archived chat is a normal ending: nobody is waiting on it (policy a974b04f).
  if (session.status === 'archived') return { askId: null, messageId: null, inserted: false };

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
        taskId: text(session.task_id) ?? taskId,
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
  let markerId = filed?.id ?? null;
  if (!filed) {
    // One visible failure at a time, as before: an open marker already shows it.
    const existing = sql
      .exec(
        `SELECT id FROM session_attention_markers
          WHERE session_id = ? AND kind = ? AND resolved_at IS NULL LIMIT 1`,
        input.sessionId,
        WAKE_FAILED_ATTENTION_KIND
      )
      .toArray()[0];
    if (typeof existing?.id === 'string') {
      return { askId: null, messageId: null, inserted: false };
    }
    // The inbox item could not be filed (D1 unavailable, no one to address it to): fall back to
    // the chat's own marker so the failure never goes invisible. Readers still show it.
    try {
      markerId = createAttentionMarker(sql, {
        sessionId: input.sessionId,
        taskId,
        workspaceId,
        kind: WAKE_FAILED_ATTENTION_KIND,
        source: 'session_wake',
        reason: input.reason,
        metadata: JSON.stringify({ deliveryId: input.deliveryId ?? null, detail: detail ?? null }),
      }).id;
    } catch (error) {
      log.error('wake_failure.attention_marker_create_failed', {
        sessionId: input.sessionId,
        reason: input.reason,
        ...serializeError(error),
      });
    }
  }

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
