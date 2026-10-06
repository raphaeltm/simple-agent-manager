import { DEFAULT_NODE_WORKSPACE_IDLE_TIMEOUT_MS } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { parseMs } from '../../scheduled/node-cleanup/config';
import { TASK_EXECUTION_STATUSES } from '../../services/task-status';
import { releaseVmProvisioningLease } from '../../services/vm-admission-control';
import { boundedWarmPlacementClaimGuardSql } from '../../services/warm-placement-claims';
import { ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL } from '../../services/workspace-resource-capacity';
import { putTaskRunnerState } from './attempt-storage';
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
    await putTaskRunnerState(rc.ctx.storage, state, { deleteAlarm: true });
    log.info('task_runner_do.execution_authority_revoked', {
      taskId: state.taskId,
      projectId: state.projectId,
      step: state.currentStep,
      nodeId: state.stepResults.nodeId ?? null,
    });
  };
  // A grant can race API cancellation and revive the admission mirror. Retire
  // only our admission generation; an executable replacement or newer token wins.
  const now = new Date().toISOString();
  await rc.env.DATABASE.prepare(
    `UPDATE vm_task_admissions SET state = 'cancelled', reason = 'task_execution_authority_revoked',
        next_retry_at = NULL, completed_at = COALESCE(completed_at, ?), updated_at = ?
      WHERE task_id = ? AND project_id = ? AND user_id = ?
        AND COALESCE(fencing_token, 0) = ?
        AND state IN ('queued', 'waiting', 'provisioning_granted', 'provisioning', 'node_ready')
        AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = vm_task_admissions.task_id
          AND t.project_id = vm_task_admissions.project_id AND t.user_id = vm_task_admissions.user_id
          AND t.status NOT IN (${TASK_EXECUTION_AUTHORITY_STATUS_SQL}))`
  )
    .bind(now, now, state.taskId, state.projectId, state.userId, state.admissionLeaseToken ?? 0)
    .run();
  // Use the persisted terminal admission so a replay repairs the mirror even
  // when the first write succeeded and this write previously failed.
  await rc.env.DATABASE.prepare(
    `UPDATE tasks SET admission_state = 'cancelled', admission_reason = 'task_execution_authority_revoked',
        admission_next_retry_at = NULL, updated_at = ?
      WHERE id = ? AND project_id = ? AND user_id = ?
        AND status NOT IN (${TASK_EXECUTION_AUTHORITY_STATUS_SQL})
        AND EXISTS (SELECT 1 FROM vm_task_admissions a WHERE a.task_id = tasks.id
          AND a.project_id = tasks.project_id AND a.user_id = tasks.user_id
          AND COALESCE(a.fencing_token, 0) = ?
          AND a.state = 'cancelled' AND a.reason = 'task_execution_authority_revoked')`
  )
    .bind(now, state.taskId, state.projectId, state.userId, state.admissionLeaseToken ?? 0)
    .run();
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
         AND NOT EXISTS (SELECT 1 FROM tasks owner_task WHERE owner_task.auto_provisioned_node_id = nodes.id
           AND owner_task.status IN (${TASK_EXECUTION_AUTHORITY_STATUS_SQL}))
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
