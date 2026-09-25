/**
 * The latest assigned or running ACP session of a chat (on one workspace when
 * given), joined to its activity state. Read by attention expiry, both to defer a
 * SAM check-in while its agent is still working and to tell a failed agent that
 * is stuck mid-turn from one that is idle.
 */
export function loadLatestActiveAcpActivity(
  sql: SqlStorage,
  scope: { sessionId: string; workspaceId: string | null }
): Record<string, unknown> | null {
  const rows = sql
    .exec(
      `SELECT acp.id AS acp_session_id,
              acp.status AS acp_status,
              ss.activity AS activity,
              ss.activity_at AS activity_at,
              ss.prompt_started_at AS prompt_started_at,
              ss.runtime_work_state AS runtime_work_state,
              ss.runtime_work_updated_at AS runtime_work_updated_at,
              ss.runtime_work_progress_at AS runtime_work_progress_at
       FROM acp_sessions acp
       LEFT JOIN session_state ss ON ss.session_id = acp.id
       WHERE acp.chat_session_id = ?
         AND acp.status IN ('assigned', 'running')
         AND (? IS NULL OR acp.workspace_id = ?)
       ORDER BY COALESCE(acp.started_at, acp.assigned_at, acp.updated_at, acp.created_at) DESC
       LIMIT 1`,
      scope.sessionId,
      scope.workspaceId,
      scope.workspaceId
    )
    .toArray();
  return rows[0] ?? null;
}

/** True while that session is inside a turn: prompting, recovering, or running harness work. */
export function isAcpSessionMidTurn(active: Record<string, unknown> | null): boolean {
  if (!active) return false;
  const activity = typeof active.activity === 'string' ? active.activity : null;
  const work = typeof active.runtime_work_state === 'string' ? active.runtime_work_state : null;
  return (
    activity === 'prompting' ||
    activity === 'recovering' ||
    work === 'active' ||
    work === 'settling'
  );
}
