/**
 * Fail a task step promptly when a previously claimed node has disappeared.
 *
 * Preserve nodeId for diagnostics, but disable auto-provisioned warm cleanup:
 * the resource is already missing/deleted and must not re-enter the warm pool.
 */
import { log } from '../../lib/logger';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export async function assertClaimedNodeAvailable(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  node: { status: string } | null,
  step: 'node_provisioning' | 'node_agent_ready'
): Promise<void> {
  if (node && node.status !== 'deleted') {
    return;
  }

  const nodeId = state.stepResults.nodeId;
  const observedStatus = node?.status ?? 'missing';

  state.stepResults.autoProvisioned = false;
  await rc.ctx.storage.put('state', state);

  log.error('task_runner_do.claimed_node_unavailable', {
    taskId: state.taskId,
    projectId: state.projectId,
    nodeId,
    step,
    observedStatus,
    action: 'failed_task_without_warm_cleanup',
  });

  throw Object.assign(
    new Error(
      `Provisioned node ${nodeId ?? 'unknown'} disappeared during ${step}. Retry the task to provision a replacement.`
    ),
    { permanent: true }
  );
}
