/**
 * Activity event recording and retrieval.
 */
import { parseActivityEventRow } from './row-schemas';
import { generateId } from './types';

export function recordActivityEventInternal(
  sql: SqlStorage,
  eventType: string,
  actorType: string,
  actorId: string | null,
  workspaceId: string | null,
  sessionId: string | null,
  taskId: string | null,
  payload: string | null
): string {
  const id = generateId();
  const now = Date.now();
  sql.exec(
    `INSERT INTO activity_events (id, event_type, actor_type, actor_id, workspace_id, session_id, task_id, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    eventType,
    actorType,
    actorId,
    workspaceId,
    sessionId,
    taskId,
    payload,
    now
  );
  return id;
}

export function listActivityEvents(
  sql: SqlStorage,
  eventType: string | null,
  limit: number = 50,
  before: number | null = null
): { events: Record<string, unknown>[]; hasMore: boolean } {
  let query =
    'SELECT id, event_type, actor_type, actor_id, workspace_id, session_id, task_id, payload, created_at FROM activity_events WHERE 1=1';
  const params: (string | number)[] = [];

  if (eventType) {
    query += ' AND event_type = ?';
    params.push(eventType);
  }
  if (before !== null) {
    query += ' AND created_at < ?';
    params.push(before);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit + 1);

  const rows = sql.exec(query, ...params).toArray();
  const hasMore = rows.length > limit;
  const events = hasMore ? rows.slice(0, limit) : rows;

  return {
    events: events.map((row) => parseActivityEventRow(row)),
    hasMore,
  };
}

/**
 * Update terminal activity for a workspace.
 */
export function updateTerminalActivity(
  sql: SqlStorage,
  workspaceId: string,
  sessionId: string | null
): void {
  const now = Date.now();
  sql.exec(
    `INSERT INTO workspace_activity (workspace_id, session_id, last_terminal_activity_at, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET last_terminal_activity_at = ?, session_id = COALESCE(?, session_id)`,
    workspaceId,
    sessionId,
    now,
    now,
    now,
    sessionId
  );
}

/**
 * Clean up workspace activity tracking for a workspace.
 */
export function cleanupWorkspaceActivity(sql: SqlStorage, workspaceId: string): void {
  sql.exec('DELETE FROM workspace_activity WHERE workspace_id = ?', workspaceId);
}

/**
 * Record message activity for a workspace.
 */
export function updateMessageActivity(
  sql: SqlStorage,
  workspaceId: string,
  sessionId: string
): void {
  const now = Date.now();
  sql.exec(
    `INSERT INTO workspace_activity (workspace_id, session_id, last_message_at, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET last_message_at = ?, session_id = COALESCE(?, session_id)`,
    workspaceId,
    sessionId,
    now,
    now,
    now,
    sessionId
  );
}
