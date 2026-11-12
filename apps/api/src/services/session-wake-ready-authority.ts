import type { SessionWakeReadyInput } from '../durable-objects/project-data/session-wake-ready';
import type { Env } from '../env';

/** Validate the exact committed recovery, never infer readiness from a browser delta. */
export async function isSessionWakeReadyCurrent(
  env: Pick<Env, 'DATABASE'>,
  input: SessionWakeReadyInput
): Promise<boolean> {
  const common = `SELECT 1 AS ready FROM workspaces w
    JOIN nodes n ON n.id = w.node_id
    JOIN agent_sessions a ON a.workspace_id = w.id
    WHERE w.id = ? AND w.project_id = ? AND w.chat_session_id = ?
      AND a.id = ? AND a.user_id = w.user_id AND a.status = 'running' AND w.status = 'running'
      AND n.status = 'running' AND w.runtime_deletion_confirmed_at IS NULL`;
  const values = [input.workspaceId, input.projectId, input.chatSessionId, input.agentSessionId];
  const fence = input.fence;
  const query =
    fence.runtime === 'vm'
      ? env.DATABASE.prepare(
          `${common} AND n.runtime = 'vm'
        AND EXISTS (SELECT 1 FROM session_snapshots s JOIN tasks t ON t.id = s.recovery_task_id
          WHERE s.chat_session_id = w.chat_session_id AND s.project_id = w.project_id
            AND s.user_id = w.user_id
            AND s.recovery_status = 'restored' AND s.recovery_workspace_id = w.id
            AND s.recovery_task_id = ? AND s.recovery_attempt_id = ?
            AND t.project_id = w.project_id AND t.chat_session_id = w.chat_session_id
            AND t.workspace_id = w.id AND t.user_id = w.user_id
            AND t.status IN ('in_progress', 'awaiting_followup'))`
        ).bind(...values, fence.taskId, fence.recoveryAttemptId)
      : env.DATABASE.prepare(
          `${common} AND n.runtime = 'cf-container'
        AND n.id = ? AND n.runtime_incarnation_id = ?`
        ).bind(...values, fence.nodeId, fence.runtimeIncarnationId);
  return (await query.first<{ ready: number }>())?.ready === 1;
}
