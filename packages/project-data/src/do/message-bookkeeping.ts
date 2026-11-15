/** Durable ingest receipts stay synchronous; derived lifecycle rows are folded in bounded passes. */
import { DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES } from '@simple-agent-manager/shared';
import { parsePositiveInt } from '@simple-agent-manager/worker-core';

import type { Env } from './types';

export const DEFAULT_MESSAGE_BOOKKEEPING = { intervalMs: 15_000, flushBatchSize: 100 } as const;
/** Protocol state, outside the range of real millisecond deadlines; never a configurable limit. */
export const BOOKKEEPING_AWAITING_SUMMARY = Number.MAX_SAFE_INTEGER;
export const BOOKKEEPING_SUMMARY_CURSOR_KEY = 'chatBookkeepingSummaryCursor';

export function messageBookkeepingInterval(env: Env, configured?: number): number {
  const idleMs =
    parsePositiveInt(env.SESSION_IDLE_TIMEOUT_MINUTES, DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES) *
    60_000;
  const interval =
    configured && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_MESSAGE_BOOKKEEPING.intervalMs;
  // Even the shortest supported idle window has two opportunities to persist its extension.
  // Decisions also consult the durable receipt clock, including across external awaits.
  return Math.min(interval, idleMs / 2);
}

export function latestMessageIngestAt(sql: SqlStorage, sessionId: string): number {
  const row = sql
    .exec(
      `SELECT message_ingested_at FROM chat_sessions
      WHERE id = COALESCE((SELECT chat_session_id FROM acp_sessions WHERE id = ?), ?)`,
      sessionId,
      sessionId
    )
    .toArray()[0];
  return typeof row?.message_ingested_at === 'number' ? row.message_ingested_at : 0;
}

/** Flush synchronously, with no await between sampling and folding. Idempotent side effects precede
 * clearing the pending count, so a failed side effect leaves retryable work. The caller's SQL
 * transaction wraps this helper on the ingest path. No receipt or message text is deferred here.
 */
export function flushMessageBookkeeping(sql: SqlStorage, sessionId: string): boolean {
  const row = sql
    .exec(
      `SELECT workspace_id, pending_message_count, message_ingested_at,
            message_activity_at, message_idle_after FROM chat_sessions WHERE id = ?`,
      sessionId
    )
    .toArray()[0];
  if (!row || !(Number(row.pending_message_count) > 0)) return false;
  const ingestedAt = Number(row.message_ingested_at);
  const activityAt = Number(row.message_activity_at);
  sql.exec(
    `UPDATE idle_cleanup_schedule SET cleanup_at = MAX(cleanup_at, ?), retry_count = 0, last_error = NULL
     WHERE session_id = ? AND terminal_state IS NULL`,
    Number(row.message_idle_after),
    sessionId
  );
  sql.exec(
    `UPDATE session_state SET activity_at = MAX(activity_at, ?), work_at = MAX(COALESCE(work_at, 0), ?)
     WHERE activity IN ('prompting', 'recovering') AND
       (session_id = ? OR session_id IN (SELECT id FROM acp_sessions WHERE chat_session_id = ?))`,
    activityAt,
    ingestedAt,
    sessionId,
    sessionId
  );
  if (typeof row.workspace_id === 'string') {
    sql.exec(
      `INSERT INTO workspace_activity (workspace_id, session_id, last_message_at, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         session_id = CASE WHEN COALESCE(workspace_activity.last_message_at, 0) <= excluded.last_message_at
                           THEN excluded.session_id ELSE workspace_activity.session_id END,
         last_message_at = MAX(COALESCE(workspace_activity.last_message_at, 0), excluded.last_message_at),
         idle_check_retry_count = 0, next_idle_check_at = NULL`,
      row.workspace_id,
      sessionId,
      ingestedAt,
      ingestedAt
    );
  }
  sql.exec(
    `UPDATE chat_sessions SET message_count = message_count + pending_message_count,
       last_message_sequence_count = CASE WHEN last_message_sequence_count = message_count
         THEN message_count + pending_message_count ELSE NULL END,
       updated_at = MAX(updated_at, message_ingested_at), pending_message_count = 0,
       message_bookkeeping_due_at = ? WHERE id = ? AND pending_message_count > 0`,
    BOOKKEEPING_AWAITING_SUMMARY,
    sessionId
  );
  return true;
}

/** Lifecycle callbacks use ACP and chat IDs interchangeably. Resolve before flushing either. */
export function flushActivityMessageBookkeeping(sql: SqlStorage, sessionId: string): void {
  const row = sql
    .exec('SELECT chat_session_id FROM acp_sessions WHERE id = ?', sessionId)
    .toArray()[0];
  flushMessageBookkeeping(
    sql,
    typeof row?.chat_session_id === 'string' ? row.chat_session_id : sessionId
  );
}

export function flushDueMessageBookkeeping(
  sql: SqlStorage,
  limit: number,
  now = Date.now()
): number {
  const rows = sql
    .exec(
      `SELECT id FROM chat_sessions WHERE message_bookkeeping_due_at < ?
       AND message_bookkeeping_due_at <= ? ORDER BY message_bookkeeping_due_at LIMIT ?`,
      BOOKKEEPING_AWAITING_SUMMARY,
      now,
      limit
    )
    .toArray();
  for (const row of rows) flushMessageBookkeeping(sql, String(row.id));
  return rows.length;
}

export function computeMessageBookkeepingAlarmTime(sql: SqlStorage): number | null {
  const row = sql
    .exec(
      'SELECT MIN(message_bookkeeping_due_at) AS due FROM chat_sessions WHERE message_bookkeeping_due_at < ?',
      BOOKKEEPING_AWAITING_SUMMARY
    )
    .toArray()[0];
  return typeof row?.due === 'number' ? row.due : null;
}

export function computeBookkeepingSummaryAlarmTime(
  sql: SqlStorage,
  env: Env,
  now = Date.now()
): number | null {
  const row = sql
    .exec(
      'SELECT id FROM chat_sessions WHERE message_bookkeeping_due_at = ? LIMIT 1',
      BOOKKEEPING_AWAITING_SUMMARY
    )
    .toArray()[0];
  return row ? now + parsePositiveInt(env.DO_SUMMARY_SYNC_DEBOUNCE_MS, 5000) : null;
}
