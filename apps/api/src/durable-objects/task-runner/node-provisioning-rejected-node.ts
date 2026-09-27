import type { TaskRunnerContext, TaskRunnerState } from './types';

/** Record proof before provisionNode removes a rejected allocation's D1 row. */
export async function recordProviderRejectedNode(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  nodeId: string
): Promise<void> {
  state.stepResults.providerRejectedNodeId = nodeId;
  await rc.ctx.storage.put('state', state);
}

/**
 * Finish a proven provider rejection after any crash boundary. Keep the proof
 * until both the D1 node/task link and the DO claim are gone. A missing claimed
 * node without this proof still fails closed in assertClaimedNodeAvailable.
 */
export async function discardProviderRejectedNode(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  nodeId: string
): Promise<void> {
  await recordProviderRejectedNode(state, rc, nodeId);
  await rc.env.DATABASE.batch([
    rc.env.DATABASE.prepare(
      `DELETE FROM nodes WHERE id = ? AND user_id = ? AND provider_instance_id IS NULL`
    ).bind(nodeId, state.userId),
    rc.env.DATABASE.prepare(
      `UPDATE tasks SET auto_provisioned_node_id = NULL, updated_at = ?
        WHERE id = ? AND auto_provisioned_node_id = ?`
    ).bind(new Date().toISOString(), state.taskId, nodeId),
  ]);
  state.stepResults.nodeId = null;
  state.stepResults.autoProvisioned = false;
  state.stepResults.provisionedVmSize = null;
  state.stepResults.providerRejectedNodeId = null;
  await rc.ctx.storage.put('state', state);
}
