/**
 * Chat session CRUD, state machine, listing, and search.
 */
import { log } from '../../lib/logger';
import { getAttentionSummary } from './attention';
import {
  parseChatSessionListRow,
  parseCountCnt,
  parseSessionStatus,
  parseSessionStop,
} from './row-schemas';
import type { Env } from './types';
import { generateId } from './types';

export function createSession(
  sql: SqlStorage,
  env: Env,
  workspaceId: string | null,
  topic: string | null,
  taskId: string | null = null,
  createdByUserId: string | null = null
): { id: string; now: number } {
  const maxSessions = parseInt(env.MAX_SESSIONS_PER_PROJECT || '10000', 10);
  const countRow = sql
    .exec('SELECT COUNT(*) as cnt FROM chat_sessions')
    .toArray()[0];
  if (countRow && parseCountCnt(countRow, 'sessions.create_count') >= maxSessions) {
    throw new Error(`Maximum ${maxSessions} sessions per project exceeded`);
  }

  const id = generateId();
  const now = Date.now();
  sql.exec(
    `INSERT INTO chat_sessions (id, workspace_id, task_id, created_by_user_id, topic, status, message_count, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
    id,
    workspaceId,
    taskId,
    createdByUserId,
    topic,
    now,
    now,
    now
  );

  // Initialize workspace activity tracking for idle detection
  if (workspaceId) {
    sql.exec(
      `INSERT OR IGNORE INTO workspace_activity (workspace_id, session_id, last_message_at, created_at)
       VALUES (?, ?, ?, ?)`,
      workspaceId,
      id,
      now,
      now
    );
  }

  return { id, now };
}

export function linkSessionToTask(sql: SqlStorage, sessionId: string, taskId: string): boolean {
  const cursor = sql.exec(
    'UPDATE chat_sessions SET task_id = ?, updated_at = ? WHERE id = ? AND (task_id IS NULL OR task_id = ?)',
    taskId, Date.now(), sessionId, taskId
  );
  return cursor.rowsWritten > 0;
}

function terminateSession(
  sql: SqlStorage,
  sessionId: string,
  terminalStatus: 'stopped' | 'failed',
): { workspaceId: string | null; messageCount: number; rowsWritten: number } | null {
  const now = Date.now();
  const cursor = sql.exec(
    `UPDATE chat_sessions SET status = ?, ended_at = ?, updated_at = ? WHERE id = ? AND status = 'active'`,
    terminalStatus,
    now,
    now,
    sessionId
  );

  const row = sql
    .exec('SELECT workspace_id, message_count FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];

  if (!row) return null;
  return { ...parseSessionStop(row), rowsWritten: cursor.rowsWritten };
}

export function stopSession(
  sql: SqlStorage,
  sessionId: string
): { workspaceId: string | null; messageCount: number } | null {
  return terminateSession(sql, sessionId, 'stopped');
}

export function stopSessionInternal(sql: SqlStorage, sessionId: string): void {
  terminateSession(sql, sessionId, 'stopped');
}

export function failSession(
  sql: SqlStorage,
  sessionId: string
): { workspaceId: string | null; messageCount: number } | null {
  const result = terminateSession(sql, sessionId, 'failed');
  // If no rows were updated, session was already stopped/failed — skip
  if (!result || result.rowsWritten === 0) return null;
  return result;
}

export function linkSessionToWorkspace(
  sql: SqlStorage,
  sessionId: string,
  workspaceId: string
): void {
  const session = sql
    .exec('SELECT id, status FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const now = Date.now();
  sql.exec(
    'UPDATE chat_sessions SET workspace_id = ?, updated_at = ? WHERE id = ?',
    workspaceId,
    now,
    sessionId
  );

  // Initialize workspace activity tracking for idle detection.
  sql.exec(
    `INSERT OR IGNORE INTO workspace_activity (workspace_id, session_id, last_message_at, created_at)
     VALUES (?, ?, ?, ?)`,
    workspaceId,
    sessionId,
    now,
    now
  );
}

export function listSessions(
  sql: SqlStorage,
  status: string | null,
  limit: number = 20,
  offset: number = 0,
  taskId: string | null = null,
  createdByUserId: string | null = null
): { sessions: Record<string, unknown>[]; total: number; hasMore: boolean } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (taskId) {
    conditions.push('task_id = ?');
    params.push(taskId);
  }
  if (createdByUserId) {
    conditions.push('created_by_user_id = ?');
    params.push(createdByUserId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalRow = sql
    .exec(`SELECT COUNT(*) as cnt FROM chat_sessions ${whereClause}`, ...params)
    .toArray()[0];
  const total = totalRow ? parseCountCnt(totalRow, 'sessions.list_total') : 0;

  const rows = sql
    .exec(
      `SELECT id, workspace_id, task_id, created_by_user_id, topic, status, message_count, started_at, ended_at, created_at, updated_at, agent_completed_at FROM chat_sessions ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset
    )
    .toArray();

  // Fault-isolated enrichment. A single malformed row (e.g. a legacy row that
  // fails the valibot schema) must NEVER throw and 500 the whole list — it is
  // skipped and logged so the offending field is diagnosable in prod. See
  // .claude/rules/50 (list reads tolerate a single bad row) and .claude/rules/41.
  const { sessions, skipped } = enrichSessionRows(sql, rows, 'sessions.list');

  // Offset-paginated: there are more sessions beyond this page whenever the
  // offset window has not reached the total row count. `rows.length` is the raw
  // SQL-fetched count, unaffected by post-fetch skips, so this stays correct.
  const hasMore = offset + rows.length < total;

  if (skipped > 0) {
    log.warn('sessions.list_degraded', {
      status,
      taskId,
      createdByUserId,
      total,
      fetched: rows.length,
      returned: sessions.length,
      skipped,
    });
  }

  return { sessions, total, hasMore };
}

/**
 * Map + attention-enrich a set of raw session rows without ever throwing for a
 * single bad row. A row that fails to parse/enrich is skipped and logged with a
 * best-effort id + the parser error so the offending field is diagnosable.
 * Returns the successfully-enriched sessions plus the skipped count.
 */
function enrichSessionRows(
  sql: SqlStorage,
  rows: Record<string, unknown>[],
  context: string
): { sessions: Record<string, unknown>[]; skipped: number } {
  const sessions: Record<string, unknown>[] = [];
  let skipped = 0;

  for (const row of rows) {
    try {
      sessions.push(enrichWithAttention(sql, mapSessionRow(row)));
    } catch (e) {
      skipped++;
      // Extract a best-effort id for diagnosis without re-triggering the parse.
      const rawId = typeof row.id === 'string' ? row.id : null;
      log.warn(`${context}_row_skipped`, { rowId: rawId, error: String(e) });
    }
  }

  return { sessions, skipped };
}

export function getSessionsByTaskIds(
  sql: SqlStorage,
  taskIds: string[]
): Array<Record<string, unknown>> {
  if (taskIds.length === 0) return [];

  const placeholders = taskIds.map(() => '?').join(', ');
  const rows = sql
    .exec(
      `SELECT id, workspace_id, task_id, created_by_user_id, topic, status, message_count, started_at, ended_at, created_at, updated_at, agent_completed_at
       FROM chat_sessions
       WHERE task_id IN (${placeholders})
       ORDER BY updated_at DESC`,
      ...taskIds
    )
    .toArray();

  // Tolerate a single malformed row rather than throwing the whole lookup.
  return enrichSessionRows(sql, rows, 'sessions.by_task_ids').sessions;
}

export function getSession(
  sql: SqlStorage,
  sessionId: string
): Record<string, unknown> | null {
  const rows = sql
    .exec(
      `SELECT cs.id, cs.workspace_id, cs.task_id, cs.topic, cs.status,
              cs.created_by_user_id, cs.message_count, cs.started_at, cs.ended_at, cs.created_at,
              cs.updated_at, cs.agent_completed_at,
              ics.cleanup_at
       FROM chat_sessions cs
       LEFT JOIN idle_cleanup_schedule ics ON ics.session_id = cs.id
       WHERE cs.id = ?`,
      sessionId
    )
    .toArray();

  const row = rows[0];
  if (!row) return null;
  // A malformed row must NOT 500 this hot single-session path (chat-state
  // polling, deep links, task repair) — the same class of bad row the list read
  // now tolerates. Degrade to null (caller returns a clean 404) and log the
  // offending field for repair, rather than throwing INTERNAL_ERROR. See
  // .claude/rules/50.
  try {
    return enrichWithAttention(sql, mapSessionRow(row));
  } catch (e) {
    const rawId = typeof row.id === 'string' ? row.id : sessionId;
    log.warn('sessions.get_row_skipped', { rowId: rawId, error: String(e) });
    return null;
  }
}

export function updateSessionTopic(
  sql: SqlStorage,
  sessionId: string,
  topic: string
): boolean {
  const row = sql
    .exec('SELECT id, status FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];

  if (!row) return false;
  const session = parseSessionStatus(row);
  if (session.status !== 'active') return false;

  const now = Date.now();
  sql.exec(
    'UPDATE chat_sessions SET topic = ?, updated_at = ? WHERE id = ?',
    topic,
    now,
    sessionId
  );
  return true;
}

export function markAgentCompleted(sql: SqlStorage, sessionId: string): number {
  const now = Date.now();
  sql.exec(
    `UPDATE chat_sessions SET agent_completed_at = ?, updated_at = ? WHERE id = ? AND agent_completed_at IS NULL`,
    now,
    now,
    sessionId
  );
  return now;
}

export function mapSessionRow(
  row: Record<string, unknown>,
  _baseDomain?: string
): Record<string, unknown> {
  return parseChatSessionListRow(row);
}

function enrichWithAttention(
  sql: SqlStorage,
  session: Record<string, unknown>,
): Record<string, unknown> {
  const sessionId = session.id as string;
  const summary = getAttentionSummary(sql, sessionId);
  return { ...session, attention: summary };
}
