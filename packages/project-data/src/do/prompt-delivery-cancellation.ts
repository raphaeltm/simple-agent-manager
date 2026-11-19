import { settleRetiredProjectEventPrompt } from './project-events-wake-delivery';

/** A queued prompt or positive preparation checkpoint proves no outstanding submission. */
export const UNISSUED_PROMPT_DELIVERY_SQL = `(delivery_state = 'queued'
  OR (delivery_state IN ('retry_wait', 'delivering') AND prompt_delivery_phase = 'preparing'))`;

/** Legacy unsafe retries retain receipt evidence, but never silently become a fresh submit. */
export function quarantineUncertainPromptRetries(
  sql: SqlStorage,
  sessionId: string,
  senderScope?: { userIds: string[]; humanSources: readonly string[] },
  projectId?: string | null,
  acceptedBefore?: number
): void {
  const retired = sql
    .exec(
      `UPDATE session_inbox SET delivery_state = 'ambiguous', terminal_reason = 'receipt_unavailable',
       last_error = 'Cancellation retained an uncertain prior submission; receipt evidence requires review',
       next_attempt_at = NULL, wake_ready_attempt_id = NULL
     WHERE target_session_id = ? AND (? IS NULL OR created_at <= ?) AND delivery_state = 'retry_wait'
       AND (prompt_delivery_phase = 'submitting' OR prompt_delivery_phase IS NULL)
       AND (? = 0 OR (
         sender_id IN (SELECT value FROM json_each(?))
         AND ((sender_type = 'human' AND source_kind IN (SELECT value FROM json_each(?)))
           OR source_kind = 'scheduled_action')
       )) RETURNING id, source_kind`,
      sessionId,
      acceptedBefore ?? null,
      acceptedBefore ?? null,
      senderScope ? 1 : 0,
      JSON.stringify(senderScope?.userIds ?? []),
      JSON.stringify(senderScope?.humanSources ?? [])
    )
    .toArray();
  const exactProjectId =
    projectId ?? sql.exec("SELECT value FROM do_meta WHERE key='projectId'").toArray()[0]?.value;
  if (typeof exactProjectId === 'string')
    for (const row of retired)
      if (row.source_kind === 'project_event_wake' && typeof row.id === 'string')
        settleRetiredProjectEventPrompt(sql, exactProjectId, row.id, 'receipt_unavailable');
}

/** Shared by access revocation and task cancellation; these are distinct terminal reasons. */
export function labelUndeliveredPrompt(
  sql: SqlStorage,
  sessionId: string,
  promptMessageId: string,
  reason: string
): void {
  sql.exec(
    `UPDATE chat_messages
     SET tool_metadata = json_set(COALESCE(tool_metadata, '{}'), '$.deliveryCancelled', ?)
     WHERE id = ? AND session_id = ? AND json_valid(COALESCE(tool_metadata, '{}'))`,
    reason,
    promptMessageId,
    sessionId
  );
}

export type CancelUnissuedSessionPromptsResult =
  | { matched: true; cancelled: number }
  | { matched: false; cancelled: 0; reason: 'missing' | 'task_mismatch' | 'task_unbound' };

/**
 * Run inside the caller's synchronous transaction. A bounded cancellation turn
 * carries its original acceptance cutoff so a delayed RPC cannot retire newer intent.
 */
export function cancelUnissuedSessionPrompts(
  sql: SqlStorage,
  sessionId: string,
  taskId: string,
  projectId: string | null,
  acceptedBefore?: number
): CancelUnissuedSessionPromptsResult {
  const session = sql
    .exec('SELECT task_id FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];
  if (!session) return { matched: false, cancelled: 0, reason: 'missing' };
  if (session.task_id !== taskId)
    return {
      matched: false,
      cancelled: 0,
      reason: session.task_id === null ? 'task_unbound' : 'task_mismatch',
    };
  quarantineUncertainPromptRetries(sql, sessionId, undefined, projectId, acceptedBefore);
  const cancelled = sql
    .exec(
      `UPDATE session_inbox SET delivery_state = 'failed', terminal_reason = 'task_cancelled',
      last_error = 'Task was cancelled before prompt submission', next_attempt_at = NULL,
      attempt_started_at = NULL, attempt_id = NULL, wake_ready_attempt_id = NULL
     WHERE target_session_id = ? AND (? IS NULL OR created_at <= ?)
       AND ${UNISSUED_PROMPT_DELIVERY_SQL}
     RETURNING id, source_kind, prompt_message_id`,
      sessionId,
      acceptedBefore ?? null,
      acceptedBefore ?? null
    )
    .toArray();
  for (const row of cancelled) {
    if (row.source_kind === 'project_event_wake' && typeof row.id === 'string')
      settleRetiredProjectEventPrompt(sql, projectId, row.id, 'task_cancelled');
    if (typeof row.prompt_message_id === 'string')
      labelUndeliveredPrompt(sql, sessionId, row.prompt_message_id, 'task_cancelled');
  }
  if (cancelled.length)
    sql.exec('DELETE FROM prompt_delivery_target_backoff WHERE target_session_id = ?', sessionId);
  return { matched: true, cancelled: cancelled.length };
}
