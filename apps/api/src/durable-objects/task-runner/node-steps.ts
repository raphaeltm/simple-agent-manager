/**
 * The `node_selection` step handler for the TaskRunner DO.
 *
 * `node_provisioning` lives in `./node-provisioning-step` and
 * `node_agent_ready` in `./node-agent-ready-step`; both are re-exported here so
 * the DO's step table keeps one import site. See rule 18.
 */
import { resolveEffectiveNodeHostMemoryReserveMb } from '@simple-agent-manager/scheduler-core';

import { log } from '../../lib/logger';
import {
  isNodeAgentVersionCompatible,
  normalizeAgentVersion,
} from '../../services/node-agent-compatibility';
import {
  type CapacityAwareNodePlacementRow,
  capacityPoolNoCandidatesError,
  hasNoCapacityPoolCandidates,
  resolveReusableNodeCapacitySnapshot,
} from '../../services/placement-resolver';
import { filterReusableNodesByCurrentAuthority } from '../../services/reusable-node-authority';
import { trustedWorkspaceNodeCapacityColumnsSql } from '../../services/workspace-admission-sql';
import { shouldProvisionSpreadNode } from './capacity-pool-node-limit';
import {
  findNodeWithCapacity,
  getTaskReservation,
  hasReusableNodeReservationCapacity,
  nodeSatisfiesTaskResources,
  releaseClaimedWarmNode,
  tryClaimWarmNode,
  verifyNodeAgentHealthy,
} from './node-selection';
import { adoptReusableNodeSelection } from './node-selection-shared';
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
    if (state.config.preferredNodeId === state.config.excludedNodeId) {
      throw Object.assign(new Error('Specified node is excluded from this recovery placement'), {
        permanent: true,
      });
    }
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
         agent_version AS agentVersion,
         agent_ready_at AS agentReadyAt
       FROM nodes WHERE id = ? AND user_id = ?`
    )
      .bind(state.config.preferredNodeId, state.userId)
      .first<
        | (CapacityAwareNodePlacementRow & {
            id: string;
            status: string;
            agentVersion: string | null;
            agentReadyAt: string | null;
          })
        | null
      >();

    if (!node || !['creating', 'running'].includes(node.status)) {
      throw Object.assign(new Error('Specified node is not available'), { permanent: true });
    }
    // Missing version is boot progress, not evidence of a different build. Keep
    // the shared compatibility predicate strict for reuse, dispatch and cleanup.
    const agentVersion = normalizeAgentVersion(node.agentVersion);
    if (
      agentVersion &&
      !isNodeAgentVersionCompatible(agentVersion, rc.env.VM_AGENT_REQUIRED_VERSION)
    ) {
      throw Object.assign(
        new Error('Specified node agent build differs from the required VM agent build'),
        { permanent: true }
      );
    }
    const waitingForVersion =
      !agentVersion && !!normalizeAgentVersion(rc.env.VM_AGENT_REQUIRED_VERSION);
    const awaitingReadiness = node.status === 'creating' || !node.agentReadyAt || waitingForVersion;
    if (awaitingReadiness || state.agentReadyStartedAt !== null) {
      // Stay in selection: each alarm must revalidate ownership, placement and
      // reservation capacity before adopting a user-pinned node. Never replace it.
      state.agentReadyStartedAt ??= Date.now();
      const deadline = state.agentReadyStartedAt + rc.getAgentReadyTimeoutMs();
      let reason = 'agent readiness deadline exceeded';
      if (waitingForVersion) {
        reason = 'agent has not reported a version yet';
      } else if (awaitingReadiness) {
        reason = 'agent has not become ready yet';
      }
      // The callback timestamp is server-assigned. A delayed alarm must not
      // reject readiness that arrived on time; current version/admission checks still apply.
      const readyAt = node.agentReadyAt ? Date.parse(node.agentReadyAt) : Number.NaN;
      const readyByDeadline = !awaitingReadiness && Number.isFinite(readyAt) && readyAt <= deadline;
      if (Date.now() >= deadline && !readyByDeadline) {
        throw Object.assign(new Error(`Specified node not ready by deadline: ${reason}`), {
          permanent: true,
        });
      }
      if (awaitingReadiness) {
        log.info('task_runner_do.preferred_node_waiting', {
          taskId: state.taskId,
          nodeId: node.id,
          reason,
          deadline,
        });
        await rc.ctx.storage.put('state', state);
        await rc.ctx.storage.setAlarm(Math.min(deadline, Date.now() + rc.getAgentPollIntervalMs()));
        return;
      }
    }
    if (!nodeSatisfiesTaskResources(node, state)) {
      throw Object.assign(new Error('Specified node does not satisfy the requested resources'), {
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
      // An explicit pin has no alternative node, so it carries no backlog guard.
      adoptReusableNodeSelection(state, { nodeId: node.id, capacityPlacementSnapshot });
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

  // Spread deliberately grows the selected pool until its explicit limit. Once
  // the limit is reached, normal reusable-node ranking packs subsequent work
  // onto those nodes according to explicit reservations.
  if (await shouldProvisionSpreadNode(state, rc)) {
    await persistPlacementDiagnostics(state, rc);
    await rc.advanceToStep(state, 'node_provisioning');
    return;
  }

  // Try warm pool first
  const warmNode = await tryClaimWarmNode(state, rc);
  if (warmNode) {
    if (await verifyNodeAgentHealthy(warmNode.nodeId, rc)) {
      adoptReusableNodeSelection(state, warmNode);
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

  // Try existing running nodes with capacity. A node busy building another workspace is
  // still a candidate: this start queues behind its build slot, and ranking prefers the
  // shortest queue. Nothing here provisions because a build queue is long.
  const existingNode = await findNodeWithCapacity(state, rc);
  if (existingNode) {
    if (await verifyNodeAgentHealthy(existingNode.nodeId, rc)) {
      adoptReusableNodeSelection(state, existingNode);
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
