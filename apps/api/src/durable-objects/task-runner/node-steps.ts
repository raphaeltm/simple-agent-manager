/**
 * The `node_selection` step handler for the TaskRunner DO.
 *
 * `node_provisioning` lives in `./node-provisioning-step` and
 * `node_agent_ready` in `./node-agent-ready-step`; both are re-exported here so
 * the DO's step table keeps one import site. See rule 18.
 */
import { log } from '../../lib/logger';
import { isNodeAgentVersionCompatible } from '../../services/node-agent-compatibility';
import {
  type CapacityAwareNodePlacementRow,
  capacityPoolNoCandidatesError,
  hasNoCapacityPoolCandidates,
  resolveReusableNodeCapacitySnapshot,
} from '../../services/placement-resolver';
import { filterReusableNodesByCurrentAuthority } from '../../services/reusable-node-authority';
import {
  resolveEffectiveNodeHostMemoryReserveMb,
  trustedWorkspaceNodeCapacityColumnsSql,
} from '../../services/workspace-resource-capacity';
import {
  findNodeWithCapacity,
  getTaskReservation,
  hasReusableNodeReservationCapacity,
  nodeSatisfiesTaskResources,
  releaseClaimedWarmNode,
  tryClaimWarmNode,
  verifyNodeAgentHealthy,
} from './node-selection';
import { persistPlacementDiagnostics } from './placement-diagnostics';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export { handleNodeAgentReady } from './node-agent-ready-step';
export { verifyNodeAgentHealthy } from './node-selection';

// =========================================================================
// Step Handlers

export async function handleNodeSelection(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  await rc.updateD1ExecutionStep(state.taskId, 'node_selection');

  log.info('task_runner_do.step.node_selection', {
    taskId: state.taskId,
    preferredNodeId: state.config.preferredNodeId,
  });

  // Revalidate persisted plans created before usable-memory filtering was deployed.
  const selection = state.config.capacityPoolSelection;
  if (selection?.workloadRole === 'workspace') {
    const reservation = getTaskReservation(state);
    const reserve = resolveEffectiveNodeHostMemoryReserveMb(rc.env, state.config.projectScaling);
    selection.candidates = selection.candidates.filter(
      (candidate) => candidate.providerInstanceMemoryMb - reserve >= reservation.memoryMb
    );
  }

  if (
    state.config.capacityPoolSelection &&
    hasNoCapacityPoolCandidates(state.config.capacityPoolSelection)
  ) {
    throw capacityPoolNoCandidatesError(state.config.capacityPoolSelection);
  }

  if (state.config.preferredNodeId) {
    // Validate the preferred node
    const node = await rc.env.DATABASE.prepare(
      `SELECT
         id,
         ${trustedWorkspaceNodeCapacityColumnsSql()},
         status,
         vm_size AS vmSize,
         vm_location AS vmLocation,
         cloud_provider AS cloudProvider,
         capacity_pool_id AS capacityPoolId,
         capacity_pool_scope AS capacityPoolScope,
         capacity_pool_revision AS capacityPoolRevision,
         capacity_source_id AS capacitySourceId,
         capacity_pool_candidate_id AS capacityPoolCandidateId,
         placement_credential_source AS placementCredentialSource,
         placement_credential_reference AS placementCredentialReference,
         placement_credential_version AS placementCredentialVersion,
         capacity_pool_project_id AS capacityPoolProjectId,
         workload_role AS workloadRole,
         provider_instance_type AS providerInstanceType,
         provider_instance_vcpu_count AS providerInstanceVcpuCount,
         provider_instance_memory_mb AS providerInstanceMemoryMb,
         provider_instance_disk_gb AS providerInstanceDiskGb,
         provider_instance_boot_disk_size_gb AS providerInstanceBootDiskSizeGb,
         provider_instance_image AS providerInstanceImage,
         provider_instance_architecture AS providerInstanceArchitecture,
         provider_instance_price_display AS providerInstancePriceDisplay,
         provider_instance_price_currency AS providerInstancePriceCurrency,
         provider_instance_price_monthly_cents AS providerInstancePriceMonthlyCents,
         provider_instance_price_hourly_micros AS providerInstancePriceHourlyMicros,
         placement_explanation_json AS placementExplanationJson,
         last_metrics AS lastMetrics,
         last_heartbeat_at AS lastHeartbeatAt,
         agent_version AS agentVersion
       FROM nodes WHERE id = ? AND user_id = ?`
    )
      .bind(state.config.preferredNodeId, state.userId)
      .first<
        | (CapacityAwareNodePlacementRow & {
            id: string;
            status: string;
            agentVersion: string | null;
          })
        | null
      >();

    if (!node || node.status !== 'running') {
      throw Object.assign(new Error('Specified node is not available'), { permanent: true });
    }
    if (!nodeSatisfiesTaskResources(node, state)) {
      throw Object.assign(new Error('Specified node does not satisfy the requested resources'), {
        permanent: true,
      });
    }
    if (!isNodeAgentVersionCompatible(node.agentVersion, rc.env.VM_AGENT_REQUIRED_VERSION)) {
      throw Object.assign(new Error('Specified node is running an incompatible VM agent build'), {
        permanent: true,
      });
    }
    if (!(await hasReusableNodeReservationCapacity(rc, state, node))) {
      throw Object.assign(
        new Error('Specified node lacks aggregate reservation capacity or fresh safe telemetry'),
        {
          permanent: true,
        }
      );
    }
    const capacityPlacementSnapshot = resolveReusableNodeCapacitySnapshot({
      selection: state.config.capacityPoolSelection,
      node,
      projectId: state.projectId,
      requestedVmSize: state.config.vmSize,
      requestedReservation: getTaskReservation(state),
    });
    if (capacityPlacementSnapshot === undefined) {
      throw Object.assign(new Error('Specified node is outside the selected capacity pool'), {
        permanent: true,
      });
    }

    const authoritativeNodes = await filterReusableNodesByCurrentAuthority(rc.env.DATABASE, {
      userId: state.userId,
      projectId: state.projectId,
      selections: [{ nodeId: node.id, capacityPlacementSnapshot }],
    });
    if (!authoritativeNodes.has(node.id)) {
      throw Object.assign(new Error('Specified node no longer has current placement authority'), {
        permanent: true,
      });
    }

    // Verify the VM agent is actually reachable before reusing
    if (await verifyNodeAgentHealthy(node.id, rc)) {
      state.stepResults.nodeId = node.id;
      state.stepResults.capacityPlacementSnapshot = capacityPlacementSnapshot;
      await persistPlacementDiagnostics(state, rc, { queue: {} });
      await rc.advanceToStep(state, 'workspace_creation');
      return;
    }
    log.warn('task_runner_do.preferred_node_unhealthy', {
      taskId: state.taskId,
      nodeId: node.id,
    });
    throw Object.assign(new Error('Specified node is not reachable'), { permanent: true });
  }

  // Try warm pool first
  const warmNode = await tryClaimWarmNode(state, rc);
  if (warmNode) {
    if (await verifyNodeAgentHealthy(warmNode.nodeId, rc)) {
      state.stepResults.nodeId = warmNode.nodeId;
      state.stepResults.capacityPlacementSnapshot = warmNode.capacityPlacementSnapshot;
      await persistPlacementDiagnostics(state, rc, { queue: {} });
      await rc.advanceToStep(state, 'workspace_creation');
      return;
    }
    await releaseClaimedWarmNode(state, rc, warmNode.nodeId);
    // Warm node agent not healthy — fall through to try other options
    log.warn('task_runner_do.warm_node_unhealthy', {
      taskId: state.taskId,
      nodeId: warmNode.nodeId,
    });
  }

  // Try existing running nodes with capacity
  const existingNode = await findNodeWithCapacity(state, rc);
  if (existingNode) {
    if (await verifyNodeAgentHealthy(existingNode.nodeId, rc)) {
      state.stepResults.nodeId = existingNode.nodeId;
      state.stepResults.capacityPlacementSnapshot = existingNode.capacityPlacementSnapshot;
      await persistPlacementDiagnostics(state, rc, { queue: {} });
      await rc.advanceToStep(state, 'workspace_creation');
      return;
    }
    // Existing node agent not healthy — fall through to provision
    log.warn('task_runner_do.existing_node_unhealthy', {
      taskId: state.taskId,
      nodeId: existingNode.nodeId,
    });
  }

  // No node found — need to provision
  await persistPlacementDiagnostics(state, rc);
  await rc.advanceToStep(state, 'node_provisioning');
}
export { handleNodeProvisioning } from './node-provisioning-step';
