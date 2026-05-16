/**
 * Session Summary D1 Sync — upserts session metadata from the ProjectData DO
 * into the D1 `session_summaries` table for cross-project queries.
 *
 * The DO remains authoritative. D1 is an eventually-consistent read index.
 */

/**
 * Upsert a full session summary row (used on session creation and bulk sync).
 */
export async function upsertSessionSummary(
  db: D1Database,
  params: {
    id: string;
    projectId: string;
    userId: string;
    status: string;
    topic: string | null;
    taskId: string | null;
    workspaceId: string | null;
    messageCount: number;
    startedAt: number;
    lastMessageAt: number | null;
    agentCompletedAt: number | null;
    endedAt: number | null;
    updatedAt: number;
  }
): Promise<void> {
  await db
    .prepare(
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
    )
    .bind(
      params.id,
      params.projectId,
      params.userId,
      params.status,
      params.topic,
      params.taskId,
      params.workspaceId,
      params.messageCount,
      params.startedAt,
      params.lastMessageAt,
      params.agentCompletedAt,
      params.endedAt,
      params.updatedAt
    )
    .run();
}

/**
 * Update specific fields on an existing session summary row.
 * Used for targeted updates (status change, topic change, workspace link, etc.).
 */
export async function updateSessionSummaryFields(
  db: D1Database,
  sessionId: string,
  fields: Partial<{
    status: string;
    topic: string | null;
    workspaceId: string | null;
    messageCount: number;
    lastMessageAt: number | null;
    agentCompletedAt: number | null;
    endedAt: number | null;
    updatedAt: number;
  }>
): Promise<void> {
  const setClauses: string[] = [];
  const values: (string | number | null)[] = [];

  if (fields.status !== undefined) {
    setClauses.push('status = ?');
    values.push(fields.status);
  }
  if (fields.topic !== undefined) {
    setClauses.push('topic = ?');
    values.push(fields.topic);
  }
  if (fields.workspaceId !== undefined) {
    setClauses.push('workspace_id = ?');
    values.push(fields.workspaceId);
  }
  if (fields.messageCount !== undefined) {
    setClauses.push('message_count = ?');
    values.push(fields.messageCount);
  }
  if (fields.lastMessageAt !== undefined) {
    setClauses.push('last_message_at = ?');
    values.push(fields.lastMessageAt);
  }
  if (fields.agentCompletedAt !== undefined) {
    setClauses.push('agent_completed_at = ?');
    values.push(fields.agentCompletedAt);
  }
  if (fields.endedAt !== undefined) {
    setClauses.push('ended_at = ?');
    values.push(fields.endedAt);
  }

  // Always update updated_at
  const updatedAt = fields.updatedAt ?? Date.now();
  setClauses.push('updated_at = ?');
  values.push(updatedAt);

  if (setClauses.length === 0) return;

  values.push(sessionId);

  await db
    .prepare(`UPDATE session_summaries SET ${setClauses.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
}
