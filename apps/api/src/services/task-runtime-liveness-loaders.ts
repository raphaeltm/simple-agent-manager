/**
 * D1 reads behind the task-runtime liveness classifier.
 *
 * Split out of `task-runtime-liveness.ts` to keep that module under the 800-line
 * mandatory-split threshold (`.claude/rules/18`). These are the three point
 * lookups the classifier's inputs come from; the classifier itself stays pure.
 * Re-exported from `task-runtime-liveness.ts` so existing imports are unchanged.
 */
import {
  MAX_TASK_SUPERSESSION_CHAIN_DEPTH,
  type RuntimeWorkspaceSnapshot,
  type SessionResumabilitySnapshot,
  type TaskSupersession,
} from './task-runtime-liveness-types';

/** Load the D1-owned workspace/node snapshot used by both liveness adapters. */
export async function loadRuntimeWorkspaceSnapshot(
  db: D1Database,
  projectId: string,
  workspaceId: string
): Promise<RuntimeWorkspaceSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT w.id, w.status AS workspace_status, w.created_at AS workspace_created_at,
            w.chat_session_id, w.node_id, w.user_id,
            n.status AS node_status, n.health_status, n.last_heartbeat_at,
            n.runtime AS node_runtime,
            (SELECT COUNT(*) FROM workspaces nw WHERE nw.node_id = w.node_id AND nw.status = 'running') AS running_workspaces_on_node
     FROM workspaces w
     LEFT JOIN nodes n ON n.id = w.node_id
     WHERE w.id = ? AND w.project_id = ?
     LIMIT 1`
    )
    .bind(workspaceId, projectId)
    .first<{
      id?: string;
      workspace_status: string;
      workspace_created_at?: string | null;
      chat_session_id: string | null;
      node_id: string | null;
      user_id: string | null;
      node_status: string | null;
      health_status: string | null;
      last_heartbeat_at: string | null;
      node_runtime: string | null;
      running_workspaces_on_node: number | null;
    }>();
  if (!row) return null;

  const heartbeatAt = row.last_heartbeat_at ? Date.parse(row.last_heartbeat_at) : Number.NaN;
  return {
    id: row.id ?? workspaceId,
    status: row.workspace_status,
    createdAtMs: parseTimestamp(row.workspace_created_at ?? null),
    chatSessionId: row.chat_session_id,
    nodeId: row.node_id,
    userId: row.user_id,
    nodeRuntime: row.node_runtime,
    nodeStatus: row.node_status,
    nodeHealthStatus: row.health_status,
    nodeHeartbeatAt: Number.isFinite(heartbeatAt) ? heartbeatAt : null,
    runningWorkspacesOnNode: row.running_workspaces_on_node ?? null,
  };
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Follow the exact persisted ownership handoff marker to decide whether this
 * task has been superseded. This deliberately does not infer from family
 * topology: guarded parent wakes can create depth-2+ chains, and the marker on
 * each predecessor is the only durable "who replaced me" edge.
 *
 * Project-scoped per `.claude/rules/11`.
 */
export async function loadTaskSupersession(
  db: D1Database,
  projectId: string,
  taskId: string
): Promise<TaskSupersession> {
  // Bounded recursive walk (`.claude/rules/47`): this function is only called
  // for tasks already about to receive a terminal verdict, and the recursion is
  // capped so a corrupt cycle cannot make the sweep unbounded.
  const row = await db
    .prepare(
      `WITH RECURSIVE supersession_chain(id, status, superseded_by_task_id, depth) AS (
          SELECT id, status, superseded_by_task_id, 0
            FROM tasks
           WHERE id = ? AND project_id = ?
          UNION ALL
          SELECT successor.id, successor.status, successor.superseded_by_task_id, chain.depth + 1
            FROM supersession_chain chain
            JOIN tasks successor
              ON successor.id = chain.superseded_by_task_id
             AND successor.project_id = ?
           WHERE chain.superseded_by_task_id IS NOT NULL
             AND chain.depth < ?
        )
        SELECT id, status, depth
          FROM supersession_chain
         WHERE depth > 0
         ORDER BY depth DESC
         LIMIT 1`
    )
    .bind(taskId, projectId, projectId, MAX_TASK_SUPERSESSION_CHAIN_DEPTH)
    .first<{ id: string; status: string; depth: number }>();
  if (!row) return 'none';

  // Before the exact successor has accepted runtime ownership, preserve the
  // predecessor. Once the exact successor is `in_progress` or later, the
  // predecessor can leave the sweep candidate set via a benign cancellation; the
  // guard predicates are marker-aware and still authorize the live chain.
  return row.status === 'queued' || row.status === 'delegated' ? 'live' : 'terminal';
}

/**
 * Load the session sleep record used to tell "slept and restorable" apart from
 * "destroyed". Project- and workspace-scoped per `.claude/rules/11`;
 * `chat_session_id` is uniquely indexed so this is a point lookup.
 */
export async function loadSessionResumabilitySnapshot(
  db: D1Database,
  projectId: string,
  workspaceId: string,
  chatSessionId: string
): Promise<SessionResumabilitySnapshot | null> {
  const row = await db
    .prepare(
      `SELECT chat_session_id, project_id, workspace_id, sleeping_at, sleep_status, expires_at,
            status, degradation, recovery_attempts, recovery_failed_at
     FROM session_snapshots
     WHERE chat_session_id = ? AND project_id = ? AND workspace_id = ?
     LIMIT 1`
    )
    .bind(chatSessionId, projectId, workspaceId)
    .first<{
      chat_session_id: string;
      project_id: string | null;
      workspace_id: string | null;
      sleeping_at: string | null;
      sleep_status: string | null;
      expires_at: string | null;
      status: string | null;
      degradation: string | null;
      recovery_attempts: number | null;
      recovery_failed_at: string | null;
    }>();
  if (!row) return null;

  return {
    chatSessionId: row.chat_session_id,
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    sleepingAt: parseTimestamp(row.sleeping_at),
    sleepStatus: row.sleep_status,
    expiresAtMs: parseTimestamp(row.expires_at),
    status: row.status,
    degradation: row.degradation,
    // NOT NULL DEFAULT 0 in schema; coalesce defensively so a null can never
    // read as "attempts remaining" via NaN comparison.
    recoveryAttempts: row.recovery_attempts ?? 0,
    recoveryFailedAtMs: parseTimestamp(row.recovery_failed_at),
  };
}
