import type { ProjectData } from '@simple-agent-manager/project-data/durable-object';
import * as v from 'valibot';

import type { SessionWakeReadyInput } from '../durable-objects/project-data/session-wake-ready';
import type { Env } from '../env';

export { isSessionWakeReadyCurrent } from '@simple-agent-manager/project-data';

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
  const query = `SELECT current.id AS task_id FROM workspaces w
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
        AND s.recovery_workspace_id != w.id`;
  const values = [
    input.workspaceId,
    input.projectId,
    input.chatSessionId,
    expectedRuntime.nodeId,
    expectedRuntime.workspaceCallbackGeneration,
    input.agentSessionId,
    input.fence.taskId,
    input.fence.recoveryAttemptId,
  ];
  const result = await env.DATABASE.prepare(`${query} LIMIT 1`)
    .bind(...values)
    .first();
  const task = v.safeParse(CurrentTaskRow, result);
  if (!task.success) return false;
  // Both stores must prove the same committed task before the final D1 revalidation.
  const stub = env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(input.projectId)
  ) as DurableObjectStub<ProjectData>;
  const session = v.safeParse(ActiveSessionLink, await stub.getSession(input.chatSessionId));
  if (
    !session.success ||
    session.output.id !== input.chatSessionId ||
    session.output.workspaceId !== input.workspaceId ||
    task.output.task_id !== session.output.taskId
  )
    return false;
  // ProjectData I/O can outlive a cancellation, rebind or replacement. Recheck the exact task,
  // captured runtime and snapshot attempt instead of accepting another qualifying LIMIT 1 row.
  const current = v.safeParse(
    CurrentTaskRow,
    await env.DATABASE.prepare(`${query} AND current.id = ? LIMIT 1`)
      .bind(...values, task.output.task_id)
      .first()
  );
  return current.success && current.output.task_id === task.output.task_id;
}
