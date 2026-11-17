import { log } from '../../lib/logger';
import { handOffEmptyWorkspaceNode } from '../../services/node-warm-handoff';
import { releaseVmProvisioningLease } from '../../services/vm-admission-control';
import { TaskExecutionAuthorityRevokedError } from './task-execution-authority';
import type { TaskRunnerContext, TaskRunnerState } from './types';

/**
 * Resume the single fallback after any crash boundary. The intent is persisted before releasing
 * D1 ownership. A node-local proof retains cleanup and lifetime provenance even after a
 * replacement overwrites auto_provisioned_node_id. Never delete or quarantine the rejected host.
 */
export async function resumeWorkspacePlacementFallback(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<boolean> {
  const nodeId = state.rejectedAutoProvisionedNodeId;
  if (!nodeId || state.stepResults.nodeId !== nodeId) return false;
  await rc.assertRecoveryAuthority(state);
  const database = rc.env.DATABASE;
  const transfer = await database.batch([
    database
      .prepare(
        `UPDATE nodes SET task_provisioned = 1
      WHERE id = ? AND user_id = ? AND node_class = 'managed' AND runtime = 'vm' AND node_role = 'workspace'
        AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = ? AND t.project_id = ? AND t.user_id = nodes.user_id
          AND t.auto_provisioned_node_id = nodes.id AND t.workspace_id IS NULL
          AND t.status IN ('queued', 'delegated', 'in_progress'))`
      )
      .bind(nodeId, state.userId, state.taskId, state.projectId),
    database
      .prepare(
        `UPDATE tasks SET auto_provisioned_node_id = NULL, updated_at = ?
     WHERE id = ? AND user_id = ? AND project_id = ?
       AND auto_provisioned_node_id = ? AND workspace_id IS NULL
       AND status IN ('queued', 'delegated', 'in_progress')
       AND EXISTS (SELECT 1 FROM nodes n WHERE n.id = tasks.auto_provisioned_node_id AND n.user_id = tasks.user_id
         AND n.task_provisioned = 1 AND n.node_class = 'managed' AND n.runtime = 'vm' AND n.node_role = 'workspace')`
      )
      .bind(new Date().toISOString(), state.taskId, state.userId, state.projectId, nodeId),
  ]);
  if ((transfer[1]?.meta.changes ?? 0) === 0) {
    // Replay is safe only after the exact pointer was released (or its node was deleted).
    const released = await database
      .prepare(
        `SELECT t.id FROM tasks t
      WHERE t.id = ? AND t.user_id = ? AND t.project_id = ? AND t.workspace_id IS NULL
        AND t.status IN ('queued', 'delegated', 'in_progress') AND t.auto_provisioned_node_id IS NULL
        AND (NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = ?)
          OR EXISTS (SELECT 1 FROM nodes n WHERE n.id = ? AND n.user_id = t.user_id AND n.task_provisioned = 1))`
      )
      .bind(state.taskId, state.userId, state.projectId, nodeId, nodeId)
      .first();
    if (!released) throw new TaskExecutionAuthorityRevokedError();
  }
  await handOffEmptyWorkspaceNode(rc.env, {
    nodeId,
    expectedUserId: state.userId,
    sourceProjectId: state.projectId,
    reason: 'provisioned_node_placement_fallback',
  });
  await releaseVmProvisioningLease(
    rc.env,
    state.admissionScopeKey,
    state.taskId,
    state.admissionLeaseToken,
    'provisioned_node_placement_fallback'
  );
  state.admissionScopeKey = null;
  state.admissionLeaseToken = null;
  state.workspacePlacementRejections = 0;
  state.startupBacklogConflicts = 0;
  state.provisioningStartedAt = null;
  state.agentReadyStartedAt = null;
  state.stepResults.nodeId = null;
  state.stepResults.autoProvisioned = false;
  state.stepResults.provisionedVmSize = null;
  state.stepResults.capacityPlacementSnapshot = null;
  state.stepResults.rankedStartupBacklog = null;
  log.info('task_runner_do.provisioned_node_placement_fallback', { taskId: state.taskId, nodeId });
  await rc.advanceToStep(state, 'node_selection');
  return true;
}
