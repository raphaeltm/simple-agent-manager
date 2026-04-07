/**
 * Session inbox — per-session message queue for parent agent notifications.
 *
 * When child tasks complete, fail, or request input, messages are enqueued
 * to the parent session's inbox. Messages are drained when the parent goes idle.
 */
import { createModuleLogger } from '../../lib/logger';
import { parseCountCnt, parseInboxMessageRow } from './row-schemas';

const log = createModuleLogger('session_inbox');

export interface InboxMessageInput {
  targetSessionId: string;
  sourceTaskId: string | null;
  messageType: 'child_completed' | 'child_failed' | 'child_needs_input' | 'parent_message';
  content: string;
  priority: 'normal' | 'urgent';
}

export interface InboxMessage {
  id: string;
  targetSessionId: string;
  sourceTaskId: string | null;
  messageType: string;
  content: string;
  priority: string;
  createdAt: number;
  deliveredAt: number | null;
}

/**
 * Enqueue a message to a session's inbox.
 * If the inbox exceeds maxSize, the oldest undelivered messages are deleted to make room.
 */
export function enqueueInboxMessage(
  sql: SqlStorage,
  input: InboxMessageInput,
  maxSize: number,
  maxContentLength: number,
): string {
  const id = crypto.randomUUID();
  const now = Date.now();

  // Truncate content if needed
  const content = input.content.length > maxContentLength
    ? input.content.slice(0, maxContentLength)
    : input.content;

  // Check current inbox size
  const countRow = sql.exec(
    'SELECT COUNT(*) as cnt FROM session_inbox WHERE target_session_id = ? AND delivered_at IS NULL',
    input.targetSessionId,
  ).toArray()[0];
  const currentCount = countRow ? parseCountCnt(countRow, 'inbox.enqueue_count') : 0;

  // If at capacity, drop oldest undelivered messages to make room
  if (currentCount >= maxSize) {
    const excess = currentCount - maxSize + 1;
    sql.exec(
      `DELETE FROM session_inbox WHERE id IN (
        SELECT id FROM session_inbox
        WHERE target_session_id = ? AND delivered_at IS NULL
        ORDER BY created_at ASC
        LIMIT ?
      )`,
      input.targetSessionId,
      excess,
    );
    log.warn('inbox.overflow_trimmed', {
      targetSessionId: input.targetSessionId,
      dropped: excess,
      maxSize,
    });
  }

  sql.exec(
    `INSERT INTO session_inbox (id, target_session_id, source_task_id, message_type, content, priority, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.targetSessionId,
    input.sourceTaskId,
    input.messageType,
    content,
    input.priority,
    now,
  );

  log.info('inbox.message_enqueued', {
    id,
    targetSessionId: input.targetSessionId,
    sourceTaskId: input.sourceTaskId,
    messageType: input.messageType,
    priority: input.priority,
  });

  return id;
}

/**
 * Get pending (undelivered) inbox messages for a session, ordered by creation time.
 */
export function getPendingInboxMessages(
  sql: SqlStorage,
  targetSessionId: string,
  limit: number,
): InboxMessage[] {
  const rows = sql.exec(
    `SELECT id, target_session_id, source_task_id, message_type, content, priority, created_at, delivered_at
     FROM session_inbox
     WHERE target_session_id = ? AND delivered_at IS NULL
     ORDER BY created_at ASC
     LIMIT ?`,
    targetSessionId,
    limit,
  ).toArray();

  return rows.map((row) => parseInboxMessageRow(row));
}

/**
 * Mark inbox messages as delivered.
 */
export function markInboxDelivered(
  sql: SqlStorage,
  messageIds: string[],
): number {
  if (messageIds.length === 0) return 0;

  const now = Date.now();
  let updated = 0;

  for (const id of messageIds) {
    const result = sql.exec(
      'UPDATE session_inbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL',
      now,
      id,
    );
    updated += result.rowsWritten;
  }

  if (updated > 0) {
    log.info('inbox.messages_delivered', { count: updated, messageIds });
  }

  return updated;
}

export interface InboxStats {
  pending: number;
  urgentCount: number;
  oldestMessageAge: number;
}

/**
 * Get inbox stats for a session (count of pending/urgent messages and oldest message age).
 */
export function getInboxStats(
  sql: SqlStorage,
  targetSessionId: string,
): InboxStats {
  const row = sql.exec(
    `SELECT
       COUNT(*) as cnt,
       SUM(CASE WHEN priority = 'urgent' THEN 1 ELSE 0 END) as urgent_cnt,
       MIN(created_at) as oldest_created_at
     FROM session_inbox
     WHERE target_session_id = ? AND delivered_at IS NULL`,
    targetSessionId,
  ).toArray()[0];

  const pending = row ? parseCountCnt(row, 'inbox.stats') : 0;
  const urgentCnt = row && typeof row['urgent_cnt'] === 'number' ? row['urgent_cnt'] : 0;
  const oldestCreatedAt = row && typeof row['oldest_created_at'] === 'number' ? row['oldest_created_at'] : 0;
  const oldestMessageAge = oldestCreatedAt > 0 ? Date.now() - oldestCreatedAt : 0;

  return { pending, urgentCount: urgentCnt, oldestMessageAge };
}
