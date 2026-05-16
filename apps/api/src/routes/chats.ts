/**
 * Cross-project chat session routes — single-query D1 access for recent chats
 * popover, /chats page, and command palette.
 *
 * Reads from the D1 session_summaries table (populated by ProjectData DO sync).
 * These routes eliminate the N+1 DO fan-out that previously required fetching
 * sessions from every project's Durable Object individually.
 */
import { Hono } from 'hono';

// Table: session_summaries — see apps/api/src/db/schema.ts:sessionSummaries
import type { Env } from '../env';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';

const chatsRoutes = new Hono<{ Bindings: Env }>();

chatsRoutes.use('/*', requireAuth(), requireApproved());

/** Default stale threshold: 3 hours (ms). Sessions older than this are excluded from "recent". */
const DEFAULT_STALE_THRESHOLD_MS = 3 * 60 * 60 * 1000;

/**
 * GET /api/chats/recent
 * Single D1 query for the recent chats popover.
 * Returns active, non-stale sessions sorted by recency + totalActive count.
 */
chatsRoutes.get('/recent', async (c) => {
  const userId = getUserId(c);
  const limit = Math.min(parseInt(c.req.query('limit') || '8', 10), 50);
  const staleThreshold = parseInt(
    c.req.query('staleThreshold') || String(DEFAULT_STALE_THRESHOLD_MS),
    10
  );
  const cutoff = Date.now() - staleThreshold;

  const db = c.env.DATABASE;

  // Single query: recent active sessions for this user
  const sessionsResult = await db
    .prepare(
      `SELECT ss.*, p.name AS project_name
       FROM session_summaries ss
       JOIN projects p ON p.id = ss.project_id
       WHERE ss.user_id = ?
         AND ss.status NOT IN ('stopped', 'failed')
         AND ss.updated_at > ?
       ORDER BY ss.updated_at DESC
       LIMIT ?`
    )
    .bind(userId, cutoff, limit)
    .all<SessionSummaryD1Row>();

  // Count total active (non-stale) sessions for the badge
  const countResult = await db
    .prepare(
      `SELECT COUNT(*) as cnt
       FROM session_summaries
       WHERE user_id = ?
         AND status NOT IN ('stopped', 'failed')
         AND updated_at > ?`
    )
    .bind(userId, cutoff)
    .first<{ cnt: number }>();

  return c.json({
    sessions: (sessionsResult.results ?? []).map(mapSessionSummaryRow),
    totalActive: countResult?.cnt ?? 0,
  });
});

/**
 * GET /api/chats
 * Paginated all-sessions for the /chats page.
 * Returns all sessions (including stopped) sorted by recency.
 */
chatsRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const status = c.req.query('status') || null;

  const db = c.env.DATABASE;

  const conditions = ['ss.user_id = ?'];
  const params: (string | number)[] = [userId];

  if (status) {
    conditions.push('ss.status = ?');
    params.push(status);
  }

  const whereClause = conditions.join(' AND ');

  // Total count
  const countResult = await db
    .prepare(`SELECT COUNT(*) as cnt FROM session_summaries ss WHERE ${whereClause}`)
    .bind(...params)
    .first<{ cnt: number }>();

  // Paginated results
  const sessionsResult = await db
    .prepare(
      `SELECT ss.*, p.name AS project_name
       FROM session_summaries ss
       JOIN projects p ON p.id = ss.project_id
       WHERE ${whereClause}
       ORDER BY ss.updated_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...params, limit, offset)
    .all<SessionSummaryD1Row>();

  return c.json({
    sessions: (sessionsResult.results ?? []).map(mapSessionSummaryRow),
    total: countResult?.cnt ?? 0,
  });
});

/** Raw D1 row shape from session_summaries + joined project name. */
interface SessionSummaryD1Row {
  id: string;
  project_id: string;
  user_id: string;
  status: string;
  topic: string | null;
  task_id: string | null;
  workspace_id: string | null;
  message_count: number;
  started_at: number;
  last_message_at: number | null;
  agent_completed_at: number | null;
  ended_at: number | null;
  updated_at: number;
  project_name: string;
}

/** Map D1 snake_case row to camelCase API response. */
function mapSessionSummaryRow(row: SessionSummaryD1Row) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    userId: row.user_id,
    status: row.status,
    topic: row.topic,
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    messageCount: row.message_count,
    startedAt: row.started_at,
    lastMessageAt: row.last_message_at,
    agentCompletedAt: row.agent_completed_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at,
  };
}

export { chatsRoutes };
