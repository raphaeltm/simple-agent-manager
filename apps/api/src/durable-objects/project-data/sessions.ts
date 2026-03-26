/**
 * Chat session CRUD, state machine, listing, and search.
 */
import type { Env } from './types';
import { generateId } from './types';

export function createSession(
  sql: SqlStorage,
  env: Env,
  workspaceId: string | null,
  topic: string | null,
  taskId: string | null = null
): { id: string; now: number } {
  const maxSessions = parseInt(env.MAX_SESSIONS_PER_PROJECT || '1000', 10);
  const countRow = sql
    .exec('SELECT COUNT(*) as cnt FROM chat_sessions')
    .toArray()[0];
  if ((countRow?.cnt as number) >= maxSessions) {
    throw new Error(`Maximum ${maxSessions} sessions per project exceeded`);
  }

  const id = generateId();
  const now = Date.now();
  sql.exec(
    `INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
    id,
    workspaceId,
    taskId,
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

export function stopSession(
  sql: SqlStorage,
  sessionId: string
): { workspaceId: string | null; messageCount: number } | null {
  const now = Date.now();
  sql.exec(
    `UPDATE chat_sessions SET status = 'stopped', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'active'`,
    now,
    now,
    sessionId
  );

  const session = sql
    .exec('SELECT workspace_id, message_count FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];

  if (!session) return null;
  return {
    workspaceId: session.workspace_id as string | null,
    messageCount: session.message_count as number,
  };
}

export function stopSessionInternal(sql: SqlStorage, sessionId: string): void {
  const now = Date.now();
  sql.exec(
    `UPDATE chat_sessions SET status = 'stopped', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'active'`,
    now,
    now,
    sessionId
  );
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
  taskId: string | null = null
): { sessions: Record<string, unknown>[]; total: number } {
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

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalRow = sql
    .exec(`SELECT COUNT(*) as cnt FROM chat_sessions ${whereClause}`, ...params)
    .toArray()[0];

  const rows = sql
    .exec(
      `SELECT id, workspace_id, task_id, topic, status, message_count, started_at, ended_at, created_at, updated_at, agent_completed_at FROM chat_sessions ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset
    )
    .toArray();

  return {
    sessions: rows.map((row) => mapSessionRow(row)),
    total: (totalRow?.cnt as number) || 0,
  };
}

export function getSessionsByTaskIds(
  sql: SqlStorage,
  taskIds: string[]
): Array<Record<string, unknown>> {
  if (taskIds.length === 0) return [];

  const placeholders = taskIds.map(() => '?').join(', ');
  const rows = sql
    .exec(
      `SELECT id, workspace_id, task_id, topic, status, message_count, started_at, ended_at, created_at, updated_at, agent_completed_at
       FROM chat_sessions
       WHERE task_id IN (${placeholders})
       ORDER BY updated_at DESC`,
      ...taskIds
    )
    .toArray();

  return rows.map((row) => mapSessionRow(row));
}

export function getSession(
  sql: SqlStorage,
  sessionId: string
): Record<string, unknown> | null {
  const rows = sql
    .exec(
      `SELECT cs.id, cs.workspace_id, cs.task_id, cs.topic, cs.status,
              cs.message_count, cs.started_at, cs.ended_at, cs.created_at,
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
  return mapSessionRow(row);
}

export function updateSessionTopic(
  sql: SqlStorage,
  sessionId: string,
  topic: string
): boolean {
  const session = sql
    .exec('SELECT id, status FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];

  if (!session) return false;
  if ((session.status as string) !== 'active') return false;

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
  baseDomain?: string
): Record<string, unknown> {
  const status = row.status as string;
  const agentCompletedAt = (row.agent_completed_at as number) ?? null;
  const workspaceId = row.workspace_id as string | null;

  return {
    id: row.id,
    workspaceId,
    taskId: row.task_id ?? null,
    topic: row.topic,
    status,
    messageCount: row.message_count,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    agentCompletedAt,
    lastMessageAt: (row.updated_at as number) ?? null,
    isIdle: status === 'active' && agentCompletedAt != null,
    isTerminated: status === 'stopped',
    workspaceUrl: workspaceId && baseDomain ? `https://ws-${workspaceId}.${baseDomain}` : null,
    cleanupAt: (row.cleanup_at as number) ?? null,
  };
}
