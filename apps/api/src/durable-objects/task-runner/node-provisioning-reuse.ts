import { log } from '../../lib/logger';
import {
  findNodeWithCapacity,
  releaseClaimedWarmNode,
  type ReusableNodeSelection,
  tryClaimWarmNode,
  verifyNodeAgentHealthy,
} from './node-selection';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export async function trySelectReusableNodeForProvisioning(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<ReusableNodeSelection | null> {
  const warmNode = await tryClaimWarmNode(state, rc);
  if (warmNode) {
    if (await verifyNodeAgentHealthy(warmNode.nodeId, rc)) return warmNode;
    await releaseClaimedWarmNode(state, rc, warmNode.nodeId);
    log.warn('task_runner_do.node_provisioning.warm_node_unhealthy', {
      taskId: state.taskId,
      nodeId: warmNode.nodeId,
    });
  }

  const existingNode = await findNodeWithCapacity(state, rc);
  if (existingNode) {
    if (await verifyNodeAgentHealthy(existingNode.nodeId, rc)) return existingNode;
    log.warn('task_runner_do.node_provisioning.existing_node_unhealthy', {
      taskId: state.taskId,
      nodeId: existingNode.nodeId,
    });
  }

  return null;
}
