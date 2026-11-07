/**
 * Acquiring the most preferred tier's VM provisioning lease for the TaskRunner
 * `node_provisioning` step. Split out of `node-provisioning-step.ts` (rule 18).
 *
 * Returns `step-finished` when the step must return now: the task is waiting for the lease or
 * the pool's node limit, or a reusable node was found after winning the lease.
 */
import {
  releaseVmProvisioningLease,
  tryAcquireVmProvisioningLease,
  type VmTaskAdmissionIdentity,
} from '../../services/vm-admission-control';
import {
  countActiveManagedPoolNodes,
  effectiveCapacityPoolMaxNodes,
  shouldProvisionSpreadNode,
} from './capacity-pool-node-limit';
import {
  handleLeaseResult,
  waitOrThrowForCapacityPoolNodeLimit,
} from './node-provisioning-admission';
import { trySelectReusableNodeForProvisioning } from './node-provisioning-reuse';
import { persistPlacementDiagnostics } from './placement-diagnostics';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export async function acquirePrimaryProvisioningLease(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  admissionIdentity: VmTaskAdmissionIdentity
): Promise<'proceed' | 'step-finished'> {
  if (state.admissionScopeKey && state.admissionScopeKey !== admissionIdentity.scopeKey) {
    // A lease left by a later provider tier before a crash or wait: this run starts again
    // from the most preferred tier, so give the other domain's lease back first.
    await releaseVmProvisioningLease(
      rc.env,
      state.admissionScopeKey,
      state.taskId,
      state.admissionLeaseToken,
      'provider_tier_restart'
    );
    state.admissionScopeKey = null;
    state.admissionLeaseToken = null;
  }
  const leaseResult = await tryAcquireVmProvisioningLease(rc.env, admissionIdentity);
  if ((await handleLeaseResult(state, rc, leaseResult)) === 'waiting') return 'step-finished';

  // Re-select after winning the claim. A compatible node may have become
  // reusable while this task was competing for the fenced provisioning lease.
  // Spread still provisions while below its pool limit; once another lease
  // holder reaches the limit, it switches to ordinary reuse before allocating.
  const spreadNeedsNodeAfterLease = await shouldProvisionSpreadNode(state, rc);
  if (!spreadNeedsNodeAfterLease) {
    const reusableNode = await trySelectReusableNodeForProvisioning(state, rc);
    if (reusableNode) {
      await releaseVmProvisioningLease(
        rc.env,
        state.admissionScopeKey,
        state.taskId,
        state.admissionLeaseToken,
        'claim_reselected_existing_node'
      );
      state.admissionScopeKey = null;
      state.admissionLeaseToken = null;
      state.stepResults.nodeId = reusableNode.nodeId;
      state.stepResults.capacityPlacementSnapshot = reusableNode.capacityPlacementSnapshot;
      await persistPlacementDiagnostics(state, rc, { queue: {} });
      await rc.advanceToStep(state, 'workspace_creation');
      return 'step-finished';
    }
  }

  // The provisioning lease serializes the final pool-count check. Without
  // this fence, two tasks that both observed maxNodes - 1 could over-provision.
  const poolNodeCountAfterLease = await countActiveManagedPoolNodes(state, rc);
  const poolMaxNodesAfterLease = effectiveCapacityPoolMaxNodes(state);
  if (
    poolNodeCountAfterLease !== null &&
    poolMaxNodesAfterLease !== null &&
    poolNodeCountAfterLease >= poolMaxNodesAfterLease
  ) {
    await releaseVmProvisioningLease(
      rc.env,
      state.admissionScopeKey,
      state.taskId,
      state.admissionLeaseToken,
      'capacity_pool_node_limit'
    );
    state.admissionScopeKey = null;
    state.admissionLeaseToken = null;
    await waitOrThrowForCapacityPoolNodeLimit(state, rc, admissionIdentity, poolMaxNodesAfterLease);
    return 'step-finished';
  }
  return 'proceed';
}
