import { DEFAULT_NODE_WORKSPACE_IDLE_TIMEOUT_MS } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { parseMs } from '../../scheduled/node-cleanup/config';
import { TASK_EXECUTION_STATUSES } from '../../services/task-status';
import { releaseVmProvisioningLease } from '../../services/vm-admission-control';
import { boundedWarmPlacementClaimGuardSql } from '../../services/warm-placement-claims';
import { ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL } from '../../services/workspace-resource-capacity';
import type { StartTaskInput, TaskRunnerContext, TaskRunnerState } from './types';

export class TaskExecutionAuthorityRevokedError extends Error {
  readonly permanent = true;
  constructor() {
    super('Task is missing, no longer executable, or belongs to another owner');
    this.name = 'TaskExecutionAuthorityRevokedError';
  }
}

export const TASK_EXECUTION_AUTHORITY_STATUS_SQL = TASK_EXECUTION_STATUSES.map(
  (status) => `'${status}'`
).join(', ');

export async function assertTaskExecutionAuthority(
  env: Env,
  input: StartTaskInput | TaskRunnerState
): Promise<void> {
  const task = await env.DATABASE.prepare(
    `SELECT id FROM tasks WHERE id = ? AND project_id = ? AND user_id = ?
       AND status IN (${TASK_EXECUTION_AUTHORITY_STATUS_SQL})`
  )
    .bind(input.taskId, input.projectId, input.userId)
    .first<{ id: string }>();
  if (!task) throw new TaskExecutionAuthorityRevokedError();
}

/** Retire this runner without changing the winning task verdict or touching reused hosts. */
export async function retireRevokedTaskRunner(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  const complete = async () => {
    state.completed = true;
    await rc.ctx.storage.put('state', state);
    await rc.ctx.storage.deleteAlarm();
  };
  await releaseVmProvisioningLease(
    rc.env,
    state.admissionScopeKey,
    state.taskId,
    state.admissionLeaseToken,
    'task_execution_authority_revoked'
  );
  if (
    !state.stepResults.autoProvisioned ||
    !state.stepResults.nodeId ||
    state.stepResults.workspaceId
  ) {
    await complete();
    return;
  }
  const warmClaimCutoff = new Date(
    Date.now() -
      parseMs(
        rc.env.NODE_WORKSPACE_IDLE_TIMEOUT_MS ?? rc.env.NODE_ORPHAN_IDLE_TIMEOUT_MS,
        DEFAULT_NODE_WORKSPACE_IDLE_TIMEOUT_MS
      )
  ).toISOString();
  // Claim the exact new empty host atomically. Placement refuses destroying hosts,
  // so a concurrent workspace cannot enter after this check.
  const claimed = await rc.env.DATABASE.prepare(
    `UPDATE nodes SET status = 'destroying', updated_at = ?
       WHERE id = ? AND user_id = ? AND node_class = 'managed' AND node_role = 'workspace'
         AND status IN ('creating', 'running', 'recovery', 'error', 'stopped')
         AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.node_id = nodes.id
           AND w.status IN (${ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL}))
         AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.auto_provisioned_node_id = nodes.id AND t.id != ?)
         ${boundedWarmPlacementClaimGuardSql('nodes.id')}`
  )
    .bind(
      new Date().toISOString(),
      state.stepResults.nodeId,
      state.userId,
      state.taskId,
      warmClaimCutoff
    )
    .run();
  // Only terminalize after all local cleanup prerequisites succeeded. A D1
  // failure must let the alarm retry cleanup without allocating fresh compute.
  // After a successful claim, the destroying-node sweep owns external retries.
  await complete();
  if ((claimed.meta.changes ?? 0) === 0) return;
  try {
    const { deleteNodeResourcesStrict } = await import('../../services/nodes');
    await deleteNodeResourcesStrict(state.stepResults.nodeId, state.userId, rc.env);
  } catch (error) {
    log.error('task_runner_do.revoked_empty_node_delete_failed', {
      taskId: state.taskId,
      nodeId: state.stepResults.nodeId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
