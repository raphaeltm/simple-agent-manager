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

/**
 * Cloudflare DO RPC has a hard 32 MiB serialization ceiling. We leave an 8 MiB
 * margin for the response envelope, pagination metadata, and JSON structural
 * overhead. The sessions-list payload is normally tiny (<=100 small rows), so
 * this is defense-in-depth against a pathological project rather than a common
 * trim point. Mirrors the budget in `messages.ts`.
 */
export const DEFAULT_SESSIONS_LIST_RPC_BUDGET_BYTES = 24 * 1024 * 1024; // 24 MiB

function resolveSessionsListRpcBudgetBytes(env: Env | undefined): number {
  const parsed = Number.parseInt(env?.SESSIONS_LIST_RPC_BUDGET_BYTES || '', 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_SESSIONS_LIST_RPC_BUDGET_BYTES;
}

function estimateSessionBytes(session: Record<string, unknown>): number {
  let size = 256; // object overhead + fixed scalar fields
  for (const value of Object.values(session)) {
    if (typeof value === 'string') size += value.length * 2; // UTF-16 chars
    else if (value && typeof value === 'object') size += JSON.stringify(value).length * 2;
  }
  return size;
}

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
  env: Env | undefined,
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

  // Fault-isolated enrichment + RPC size budget. A single malformed row (e.g. a
  // legacy row that fails the valibot schema) must NEVER throw and 500 the whole
  // list — it is skipped and logged so the offending field is diagnosable. See
  // .claude/rules/41 (tolerate a single bad row) and .claude/rules/44/35.
  const { sessions, skipped, truncated } = enrichSessionRows(sql, env, rows, 'sessions.list');

  // There are more sessions beyond this page either because the offset window
  // did not reach `total`, or because the size budget trimmed the page.
  const hasMore = offset + rows.length < total || truncated;

  if (skipped > 0 || truncated) {
    log.warn('sessions.list_degraded', {
      status,
      taskId,
      createdByUserId,
      total,
      fetched: rows.length,
      returned: sessions.length,
      skipped,
      truncated,
    });
  }

  return { sessions, total, hasMore };
}

/**
 * Map + attention-enrich a set of raw session rows without ever throwing for a
 * single bad row, and stop before exceeding the RPC serialization budget.
 * Returns the successfully-enriched sessions plus diagnostics.
 */
function enrichSessionRows(
  sql: SqlStorage,
  env: Env | undefined,
  rows: Record<string, unknown>[],
  context: string
): { sessions: Record<string, unknown>[]; skipped: number; truncated: boolean } {
  const budgetBytes = resolveSessionsListRpcBudgetBytes(env);
  const sessions: Record<string, unknown>[] = [];
  let skipped = 0;
  let truncated = false;
  let cumulativeBytes = 0;

  for (const row of rows) {
    let enriched: Record<string, unknown>;
    try {
      enriched = enrichWithAttention(sql, mapSessionRow(row));
    } catch (e) {
      skipped++;
      // Extract a best-effort id for diagnosis without re-triggering the parse.
      const rawId = typeof row.id === 'string' ? row.id : null;
      log.warn(`${context}_row_skipped`, { rowId: rawId, error: String(e) });
      continue;
    }

    cumulativeBytes += estimateSessionBytes(enriched);
    if (cumulativeBytes > budgetBytes && sessions.length > 0) {
      // Last-resort guard against exceeding Cloudflare's 32 MiB DO-RPC ceiling:
      // return what fits rather than throwing a serialization overflow (which
      // would 500 again). NOTE: sessions listing is OFFSET-paginated, so unlike
      // the cursor-based messages read this truncated tail is NOT cleanly
      // resumable by a subsequent `offset += limit` request — those rows are
      // dropped from this response. This is acceptable only because it is
      // practically unreachable (rows are tiny and capped at `limit` <= 100);
      // `hasMore` signals the truncation. If sessions ever grow large per-row,
      // move this read to cursor pagination before relying on the guard.
      truncated = true;
      break;
    }
    sessions.push(enriched);
  }

  return { sessions, skipped, truncated };
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
  return enrichSessionRows(sql, undefined, rows, 'sessions.by_task_ids').sessions;
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
  return enrichWithAttention(sql, mapSessionRow(row));
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
