/** A queued prompt or positive preparation checkpoint proves no outstanding submission. */
export const UNISSUED_PROMPT_DELIVERY_SQL = `(delivery_state = 'queued'
  OR (delivery_state IN ('retry_wait', 'delivering') AND prompt_delivery_phase = 'preparing'))`;

/** Legacy unsafe retries retain receipt evidence, but never silently become a fresh submit. */
export function quarantineUncertainPromptRetries(
  sql: SqlStorage,
  sessionId: string,
  senderScope?: { userIds: string[]; humanSources: readonly string[] }
): void {
  sql.exec(
    `UPDATE session_inbox SET delivery_state = 'ambiguous', terminal_reason = 'receipt_unavailable',
       last_error = 'Cancellation retained an uncertain prior submission; receipt evidence requires review',
       next_attempt_at = NULL, wake_ready_attempt_id = NULL
     WHERE target_session_id = ? AND delivery_state = 'retry_wait'
       AND (prompt_delivery_phase = 'submitting' OR prompt_delivery_phase IS NULL)
       ${
         senderScope
           ? `AND sender_id IN (SELECT value FROM json_each(?))
         AND ((sender_type = 'human' AND source_kind IN (SELECT value FROM json_each(?)))
           OR source_kind = 'scheduled_action')`
           : ''
       }`,
    sessionId,
    ...(senderScope
      ? [JSON.stringify(senderScope.userIds), JSON.stringify(senderScope.humanSources)]
      : [])
  );
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

/** Run inside the caller's synchronous transaction, before any awaited side effects. */
export function cancelUnissuedSessionPrompts(
  sql: SqlStorage,
  sessionId: string,
  taskId: string
): number {
  if (
    !sql
      .exec('SELECT 1 FROM chat_sessions WHERE id = ? AND task_id = ?', sessionId, taskId)
      .toArray().length
  )
    throw new Error('Session task binding changed before prompt cancellation');
  quarantineUncertainPromptRetries(sql, sessionId);
  const cancelled = sql
    .exec(
      `UPDATE session_inbox SET delivery_state = 'failed', terminal_reason = 'task_cancelled',
      last_error = 'Task was cancelled before prompt submission', next_attempt_at = NULL,
      attempt_started_at = NULL, attempt_id = NULL, wake_ready_attempt_id = NULL
     WHERE target_session_id = ? AND ${UNISSUED_PROMPT_DELIVERY_SQL}
     RETURNING prompt_message_id`,
      sessionId
    )
    .toArray();
  for (const row of cancelled) {
    if (typeof row.prompt_message_id === 'string')
      labelUndeliveredPrompt(sql, sessionId, row.prompt_message_id, 'task_cancelled');
  }
  if (cancelled.length)
    sql.exec('DELETE FROM prompt_delivery_target_backoff WHERE target_session_id = ?', sessionId);
  return cancelled.length;
}
