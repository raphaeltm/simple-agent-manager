import type { Env } from '../env';

interface SleepPlaceholder {
  id: string;
  projectId: string | null;
  workspaceId: string;
  nodeId: string | null;
  userId: string;
  chatSessionId: string;
  agentSessionId: string | null;
  runtime: string;
  manifestR2Key: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Atomically reject a late old-node sleep intent after recovery or node release. */
export async function ensureUnhealthyNodeSleepPlaceholder(
  env: Env,
  row: SleepPlaceholder,
  expectedNodeId: string
): Promise<boolean> {
  if (row.nodeId !== expectedNodeId) return false;
  const result = await env.DATABASE.prepare(
    `INSERT INTO session_snapshots
       (id, project_id, workspace_id, node_id, user_id, chat_session_id, agent_session_id,
        runtime, status, degradation, manifest_r2_key, expires_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'none', ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM workspaces w
         WHERE w.id = ? AND w.node_id = ? AND w.user_id = ? AND w.chat_session_id = ?
           AND w.status IN ('running', 'creating', 'recovery')
       )
       ON CONFLICT(chat_session_id) DO UPDATE SET
         project_id = excluded.project_id,
         workspace_id = excluded.workspace_id,
         node_id = excluded.node_id,
         user_id = excluded.user_id,
         agent_session_id = excluded.agent_session_id,
         runtime = excluded.runtime,
         updated_at = excluded.updated_at
       WHERE (session_snapshots.workspace_id IS NULL
              OR session_snapshots.workspace_id = excluded.workspace_id)
         AND EXISTS (
           SELECT 1 FROM workspaces w
           WHERE w.id = excluded.workspace_id AND w.node_id = ? AND w.user_id = excluded.user_id
             AND w.chat_session_id = excluded.chat_session_id
             AND w.status IN ('running', 'creating', 'recovery')
         )`
  )
    .bind(
      row.id,
      row.projectId,
      row.workspaceId,
      row.nodeId,
      row.userId,
      row.chatSessionId,
      row.agentSessionId,
      row.runtime,
      row.manifestR2Key,
      row.expiresAt,
      row.createdAt,
      row.updatedAt,
      row.workspaceId,
      expectedNodeId,
      row.userId,
      row.chatSessionId,
      expectedNodeId
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}
