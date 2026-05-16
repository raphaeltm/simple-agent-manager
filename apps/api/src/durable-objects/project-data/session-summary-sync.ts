/**
 * Sync session metadata from DO SQLite to D1 session_summaries table.
 * Enables single-query cross-project session listing (recent chats, /chats page, command palette).
 */
import { createModuleLogger } from '../../lib/logger';
import type { Env } from './types';

const log = createModuleLogger('session_summary_sync');

/**
 * Batch-sync all session metadata from DO SQLite to D1 session_summaries table.
 * Only syncs sessions updated in the last 24 hours to limit batch size on active projects.
 */
export async function syncSessionSummariesToD1(
  sql: SqlStorage,
  env: Env,
  projectId: string
): Promise<void> {
  // Look up the project owner from D1
  const projectRow = await env.DATABASE.prepare('SELECT user_id FROM projects WHERE id = ?')
    .bind(projectId).first<{ user_id: string }>();
  if (!projectRow) return;
  const userId = projectRow.user_id;

  // Fetch recently-updated sessions from DO SQLite (last 24h)
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const rows = sql.exec(
    `SELECT id, workspace_id, task_id, topic, status, message_count,
            started_at, ended_at, updated_at, agent_completed_at,
            (SELECT MAX(created_at) FROM chat_messages WHERE session_id = chat_sessions.id) as last_message_at
     FROM chat_sessions
     WHERE updated_at > ?
     ORDER BY updated_at DESC
     LIMIT 200`,
    cutoff
  ).toArray();

  if (rows.length === 0) return;

  // Batch upsert using D1 batch API
  const stmts = rows.map((row) =>
    env.DATABASE.prepare(
      `INSERT INTO session_summaries
         (id, project_id, user_id, status, topic, task_id, workspace_id,
          message_count, started_at, last_message_at, agent_completed_at, ended_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         topic = excluded.topic,
         task_id = excluded.task_id,
         workspace_id = excluded.workspace_id,
         message_count = excluded.message_count,
         last_message_at = excluded.last_message_at,
         agent_completed_at = excluded.agent_completed_at,
         ended_at = excluded.ended_at,
         updated_at = excluded.updated_at`
    ).bind(
      row.id as string,
      projectId,
      userId,
      row.status as string,
      row.topic as string | null,
      row.task_id as string | null,
      row.workspace_id as string | null,
      row.message_count as number,
      row.started_at as number,
      (row.last_message_at as number | null) ?? null,
      row.agent_completed_at as number | null,
      row.ended_at as number | null,
      row.updated_at as number
    )
  );

  // D1 batch limit is 100 statements; chunk if needed
  const BATCH_SIZE = 100;
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    await env.DATABASE.batch(stmts.slice(i, i + BATCH_SIZE));
  }

  log.info('session_summaries_synced', { projectId, count: rows.length });
}
