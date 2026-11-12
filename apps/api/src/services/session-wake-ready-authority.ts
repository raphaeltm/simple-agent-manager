import * as v from 'valibot';

import type { ProjectData } from '../durable-objects/project-data';
import type { SessionWakeReadyInput } from '../durable-objects/project-data/session-wake-ready';
import type { Env } from '../env';

/** Validate the exact committed recovery, never infer readiness from a browser delta. */
export async function isSessionWakeReadyCurrent(
  env: Pick<Env, 'DATABASE'>,
  input: SessionWakeReadyInput
): Promise<boolean> {
  let common = `SELECT 1 AS ready FROM workspaces w
    JOIN nodes n ON n.id = w.node_id AND n.user_id = w.user_id
    JOIN agent_sessions a ON a.workspace_id = w.id
    WHERE w.id = ? AND w.project_id = ? AND w.chat_session_id = ?
      AND a.id = ? AND a.user_id = w.user_id AND a.status = 'running' AND w.status = 'running'
      AND n.status = 'running' AND w.runtime_deletion_confirmed_at IS NULL`;
  const values: Array<string | null> = [
    input.workspaceId,
    input.projectId,
    input.chatSessionId,
    input.agentSessionId,
  ];
  if (input.expectedRuntime) {
    common += ' AND w.node_id = ? AND w.callback_generation IS ?';
    values.push(input.expectedRuntime.nodeId, input.expectedRuntime.workspaceCallbackGeneration);
  }
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

const CurrentTaskRow = v.object({ task_id: v.string() });
const ActiveSessionLink = v.object({
  id: v.string(),
  status: v.literal('active'),
  workspaceId: v.string(),
  taskId: v.string(),
});

/** A separate committed start may retain a restore receipt belonging to an older task. */
export async function isSessionHistoricalWakeReceiptCurrent(
  env: Pick<Env, 'DATABASE' | 'PROJECT_DATA'>,
  input: SessionWakeReadyInput,
  expectedRuntime: { nodeId: string; workspaceCallbackGeneration: string | null }
): Promise<boolean> {
  if (input.fence.runtime !== 'vm') return false;
  const result = await env.DATABASE.prepare(
    `SELECT current.id AS task_id FROM workspaces w
      JOIN nodes n ON n.id = w.node_id AND n.user_id = w.user_id
      JOIN agent_sessions a ON a.workspace_id = w.id AND a.user_id = w.user_id
      JOIN session_snapshots s ON s.chat_session_id = w.chat_session_id
        AND s.project_id = w.project_id AND s.user_id = w.user_id
      JOIN tasks historical ON historical.id = s.recovery_task_id
        AND historical.project_id = w.project_id
        AND historical.user_id = w.user_id AND historical.workspace_id = s.recovery_workspace_id
      JOIN tasks current ON current.workspace_id = w.id AND current.id != historical.id
        AND current.project_id = w.project_id AND current.chat_session_id = w.chat_session_id
        AND current.user_id = w.user_id AND current.status IN ('in_progress', 'awaiting_followup')
      WHERE w.id = ? AND w.project_id = ? AND w.chat_session_id = ?
        AND w.node_id = ? AND w.callback_generation IS ?
        AND w.status = 'running' AND w.runtime_deletion_confirmed_at IS NULL
        AND n.runtime = 'vm' AND n.status = 'running'
        AND (n.health_status IS NULL OR n.health_status != 'unhealthy')
        AND a.id = ? AND a.status = 'running'
        AND s.runtime = 'vm' AND s.recovery_status = 'restored'
        AND s.recovery_task_id = ? AND s.recovery_attempt_id = ?
        AND s.recovery_workspace_id != w.id LIMIT 1`
  )
    .bind(
      input.workspaceId,
      input.projectId,
      input.chatSessionId,
      expectedRuntime.nodeId,
      expectedRuntime.workspaceCallbackGeneration,
      input.agentSessionId,
      input.fence.taskId,
      input.fence.recoveryAttemptId
    )
    .first();
  const task = v.safeParse(CurrentTaskRow, result);
  if (!task.success) return false;
  // Read local lifecycle last: a stopped, sleeping or rebound chat cannot use this exemption.
  const stub = env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(input.projectId)
  ) as DurableObjectStub<ProjectData>;
  const session = v.safeParse(ActiveSessionLink, await stub.getSession(input.chatSessionId));
  return (
    session.success &&
    session.output.id === input.chatSessionId &&
    session.output.workspaceId === input.workspaceId &&
    task.output.task_id === session.output.taskId
  );
}
