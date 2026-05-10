/**
 * Chat session CRUD, state machine, listing, and search.
 */
import { DEFAULT_CHAT_SESSION_STALE_TIMEOUT_MS } from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import {
  parseChatSessionListRow,
  parseCountCnt,
  parseMinEarliest,
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
  taskId: string | null = null
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

  const row = sql
    .exec('SELECT workspace_id, message_count FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];

  if (!row) return null;
  return parseSessionStop(row);
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
    total: totalRow ? parseCountCnt(totalRow, 'sessions.list_total') : 0,
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

/**
 * Stop stale active chat sessions:
 * 1. Sessions whose workspace is in a terminal state (stopped/deleted/error)
 * 2. Sessions with no workspace that have been active past the stale timeout
 *
 * The workspace status check queries D1 (DATABASE binding) since workspace
 * status lives in D1, not the ProjectData DO's SQLite.
 */
export async function checkStaleChatSessions(
  sql: SqlStorage,
  env: Env,
): Promise<number> {
  const staleTimeoutMs = parseInt(
    env.CHAT_SESSION_STALE_TIMEOUT_MS || String(DEFAULT_CHAT_SESSION_STALE_TIMEOUT_MS),
    10
  );
  const cutoff = Date.now() - staleTimeoutMs;
  let stopped = 0;

  // 1. Stop sessions whose workspace is in a terminal state
  const activeWithWorkspace = sql
    .exec(
      `SELECT id, workspace_id FROM chat_sessions
       WHERE status = 'active' AND workspace_id IS NOT NULL`
    )
    .toArray();

  if (activeWithWorkspace.length > 0) {
    // Batch D1 reads to avoid N+1 query pattern
    const stmts = activeWithWorkspace.map((row) =>
      env.DATABASE.prepare('SELECT id, status FROM workspaces WHERE id = ?').bind(row.workspace_id as string)
    );

    try {
      const results = await env.DATABASE.batch<{ id: string; status: string }>(stmts);

      for (let i = 0; i < activeWithWorkspace.length; i++) {
        const row = activeWithWorkspace[i]!;
        const sessionId = row.id as string;
        const workspaceId = row.workspace_id as string;
        const wsRow = results[i]?.results?.[0] ?? null;

        if (!wsRow || ['stopped', 'deleted', 'error'].includes(wsRow.status)) {
          stopSessionInternal(sql, sessionId);
          log.info('session.stale_workspace_stopped', {
            sessionId,
            workspaceId,
            workspaceStatus: wsRow?.status ?? 'not_found',
          });
          stopped++;
        }
      }
    } catch (err) {
      log.error('session.stale_check_workspace_batch_failed', {
        sessionCount: activeWithWorkspace.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2. Stop sessions with no workspace that have been active past the stale timeout
  const noWorkspaceSessions = sql
    .exec(
      `SELECT id FROM chat_sessions
       WHERE status = 'active'
       AND workspace_id IS NULL
       AND created_at < ?`,
      cutoff
    )
    .toArray();

  for (const row of noWorkspaceSessions) {
    const sessionId = row.id as string;
    stopSessionInternal(sql, sessionId);
    log.info('session.stale_no_workspace_stopped', { sessionId });
    stopped++;
  }

  return stopped;
}

/**
 * Compute alarm time for stale chat session checks.
 * Returns the earliest time we should wake up to check for stale sessions.
 */
export function computeStaleChatSessionAlarmTime(sql: SqlStorage, env: Env): number | null {
  const staleTimeoutMs = parseInt(
    env.CHAT_SESSION_STALE_TIMEOUT_MS || String(DEFAULT_CHAT_SESSION_STALE_TIMEOUT_MS),
    10
  );

  // Check if there are any active sessions that might need checking
  const activeCount = sql
    .exec("SELECT COUNT(*) as cnt FROM chat_sessions WHERE status = 'active'")
    .toArray()[0];

  if (!activeCount || parseCountCnt(activeCount, 'sessions.active_count') === 0) return null;

  // For sessions with workspaces: check periodically (every 5 minutes)
  const withWorkspaceRow = sql
    .exec(
      "SELECT COUNT(*) as cnt FROM chat_sessions WHERE status = 'active' AND workspace_id IS NOT NULL"
    )
    .toArray()[0];

  const hasWorkspaceSessions = withWorkspaceRow && parseCountCnt(withWorkspaceRow, 'sessions.with_workspace') > 0;

  // For sessions without workspaces: alarm at earliest_created_at + stale_timeout
  const noWsRow = sql
    .exec(
      `SELECT MIN(created_at) as earliest FROM chat_sessions
       WHERE status = 'active' AND workspace_id IS NULL`
    )
    .toArray()[0];

  const candidates: number[] = [];

  if (hasWorkspaceSessions) {
    // Check workspace-linked sessions every 5 minutes
    candidates.push(Date.now() + 5 * 60 * 1000);
  }

  if (noWsRow) {
    const earliest = parseMinEarliest(noWsRow, 'sessions.earliest_no_workspace');
    if (earliest !== null) {
      candidates.push(earliest + staleTimeoutMs);
    }
  }

  return candidates.length > 0 ? Math.min(...candidates) : null;
}
