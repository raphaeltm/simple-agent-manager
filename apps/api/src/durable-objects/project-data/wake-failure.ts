import { createModuleLogger, serializeError } from '../../lib/logger';
import * as activity from './activity';
import { createAttentionMarker } from './attention';
import { persistSystemMessage } from './messages';

const log = createModuleLogger('project_data.wake_failure');
export const WAKE_FAILED_ATTENTION_KIND = 'wake_failed';

export interface RaiseSessionWakeFailureInput {
  sessionId: string;
  taskId?: string | null;
  deliveryId?: string | null;
  reason: string;
  detail?: string | null;
}

export function raiseSessionWakeFailure(
  sql: SqlStorage,
  input: RaiseSessionWakeFailureInput,
  broadcastEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void
): { markerId: string | null; messageId: string | null; inserted: boolean } {
  const session = sql
    .exec(
      `SELECT id, task_id, workspace_id
         FROM chat_sessions
        WHERE id = ?
        LIMIT 1`,
      input.sessionId
    )
    .toArray()[0];
  if (!session) return { markerId: null, messageId: null, inserted: false };

  const existing = sql
    .exec(
      `SELECT id
         FROM session_attention_markers
        WHERE session_id = ?
          AND kind = ?
          AND resolved_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      input.sessionId,
      WAKE_FAILED_ATTENTION_KIND
    )
    .toArray()[0];
  if (typeof existing?.id === 'string') {
    log.info('wake_failure.already_visible', {
      sessionId: input.sessionId,
      deliveryId: input.deliveryId ?? null,
      reason: input.reason,
      attentionMarkerId: existing.id,
    });
    return { markerId: existing.id, messageId: null, inserted: false };
  }

  const taskId = input.taskId ?? (typeof session.task_id === 'string' ? session.task_id : null);
  const workspaceId = typeof session.workspace_id === 'string' ? session.workspace_id : null;
  const detail = input.detail?.trim();
  const message =
    detail && detail !== input.reason ? `Wake failed: ${detail}` : `Wake failed: ${input.reason}`;

  let markerId: string | null = null;
  try {
    markerId = createAttentionMarker(sql, {
      sessionId: input.sessionId,
      taskId,
      workspaceId,
      kind: WAKE_FAILED_ATTENTION_KIND,
      source: 'session_wake',
      reason: input.reason,
      metadata: JSON.stringify({
        deliveryId: input.deliveryId ?? null,
        detail: detail ?? null,
      }),
    }).id;
  } catch (error) {
    log.error('wake_failure.attention_marker_create_failed', {
      sessionId: input.sessionId,
      reason: input.reason,
      ...serializeError(error),
    });
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

  return { markerId, messageId: persisted?.id ?? null, inserted: true };
}
