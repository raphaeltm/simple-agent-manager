import type { Env } from '../env';
import { log } from '../lib/logger';
import { transitionTaskToTerminal } from './task-terminal-transition';

export type StrandedNodeTask = {
  taskId: string;
  projectId: string;
  workspaceId: string;
};

export async function listStrandedNodeTasks(env: Env, nodeId: string): Promise<StrandedNodeTask[]> {
  const rows = await env.DATABASE.prepare(
    `SELECT t.id AS taskId, t.project_id AS projectId, w.id AS workspaceId
     FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
     WHERE w.node_id = ? AND w.status IN ('running', 'creating', 'recovery')
       AND t.status IN ('queued', 'delegated', 'in_progress')`
  )
    .bind(nodeId)
    .all<StrandedNodeTask>();
  return rows.results;
}

export async function terminalizeStrandedNodeTasks(
  env: Env,
  nodeId: string,
  tasks: StrandedNodeTask[],
  cause: 'heartbeat_lost' | 'owner_deleted'
): Promise<number> {
  let failures = 0;
  for (const task of tasks) {
    try {
      const outcome = await transitionTaskToTerminal(env, {
        taskId: task.taskId,
        projectId: task.projectId,
        status: cause === 'owner_deleted' ? 'cancelled' : 'failed',
        reason:
          cause === 'owner_deleted'
            ? `Workspace node ${nodeId} was deleted by its owner`
            : `Control plane lost heartbeat from node ${nodeId}; SAM released the node after the configured recovery window. Agent progress after the last persisted callback is unknown.`,
        source: cause === 'owner_deleted' ? 'owner_node_deletion' : 'unhealthy_node_cleanup',
        expectedWorkspaceId: task.workspaceId,
        lifecycleOutcome: cause === 'owner_deleted',
        stopWorkspace: false,
      });
      if (outcome !== 'transitioned' && outcome !== 'already_terminal') failures++;
    } catch (error) {
      failures++;
      log.error('node_stranded_tasks.transition_failed', {
        nodeId,
        taskId: task.taskId,
        cause,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failures;
}
