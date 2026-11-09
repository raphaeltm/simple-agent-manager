import { log } from '../../lib/logger';
import { isNodeAgentVersionCompatible } from '../../services/node-agent-compatibility';
import {
  pastLifetimeAdmissionCutoffColumnSql,
  resolvePlacementAdmissionPolicy,
} from '../../services/node-lifetime-admission';
import type { PlacementHostDiagnosticInput } from '../../services/placement-diagnostics';
import { comparePlacementRolloutHosts } from '../../services/placement-rollout';
import {
  loadActiveWorkspaceReservationUsage,
  trustedWorkspaceNodeCapacityColumnsSql,
} from '../../services/workspace-resource-capacity';
import { evaluateReusableNodeCandidate, type RankedReusableNode } from './node-placement-candidate';
import {
  currentReusableNodeIds,
  getTaskReservation,
  nodeSatisfiesTaskResources,
  resolveReusableNodeSelection,
  type ReusableNodeSelection,
} from './node-selection-shared';
import { updatePlacementDiagnostics } from './placement-diagnostics';
import { compareReusableHosts } from './task-placement-strategy';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export { verifyNodeAgentHealthy } from './node-agent-health';
export type { NodePlacementFields, ReusableNodeSelection } from './node-selection-shared';
export {
  getTaskReservation,
  hasReusableNodeReservationCapacity,
  nodeSatisfiesTaskResources,
} from './node-selection-shared';
export { taskPlacementStrategy } from './task-placement-strategy';
export { releaseClaimedWarmNode, tryClaimWarmNode } from './warm-node-claim';

/**
 * The best admitted running node for this run, or null when none can admit it.
 *
 * A node that is building another workspace is NOT refused: it queues this start behind its
 * single build slot, and the ranking prefers the shorter queue (`compareReusableHosts`). Only
 * capacity, telemetry, identity, authority, version and lifetime checks refuse a node, so a
 * busy-but-sufficient node never sends a run to provisioning.
 */
export async function findNodeWithCapacity(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<ReusableNodeSelection | null> {
  const scaling = state.config.projectScaling;
  const policy = await resolvePlacementAdmissionPolicy(rc.env, scaling);
  const requestedReservation = getTaskReservation(state);
  // A hint that records its refusal: the final reservation repeats the cutoff
  // (`workspace-admission-sql.ts`).
  const lifetimeCutoff = pastLifetimeAdmissionCutoffColumnSql(
    'nodes',
    policy.lifetimeAdmissionCutoffAgeMs,
    new Date()
  );

  const nodes = await rc.env.DATABASE.prepare(
    `SELECT
       id,
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
       ${trustedWorkspaceNodeCapacityColumnsSql()},
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
       health_status AS healthStatus,
       last_metrics AS lastMetrics,
       last_heartbeat_at AS lastHeartbeatAt,
       agent_version AS agentVersion,
       ${lifetimeCutoff.sql}
     FROM nodes
     WHERE user_id = ? AND status = 'running' AND health_status != 'unhealthy' AND node_role = 'workspace'
       AND (runtime IS NULL OR runtime != 'cf-container')`
  )
    .bind(...lifetimeCutoff.binds, state.userId)
    .all<{
      id: string;
      vmSize: string;
      vmLocation: string;
      cloudProvider: string | null;
      capacityPoolId: string | null;
      capacityPoolScope: string | null;
      capacityPoolRevision: number | null;
      capacitySourceId: string | null;
      capacityPoolCandidateId: string | null;
      placementCredentialSource: string | null;
      placementCredentialReference: string | null;
      placementCredentialVersion: number | null;
      capacityPoolProjectId: string | null;
      workloadRole: string | null;
      nodeClass: string | null;
      providerInstanceId: string | null;
      observedProviderInstanceType: string | null;
      observedProviderInstanceVcpuCount: number | null;
      observedProviderInstanceMemoryMb: number | null;
      observedProviderInstanceDiskGb: number | null;
      observedHardwareSource: string | null;
      providerInstanceType: string | null;
      providerInstanceVcpuCount: number | null;
      providerInstanceMemoryMb: number | null;
      providerInstanceDiskGb: number | null;
      providerInstanceBootDiskSizeGb: number | null;
      providerInstanceImage: string | null;
      providerInstanceArchitecture: string | null;
      providerInstancePriceDisplay: string | null;
      providerInstancePriceCurrency: string | null;
      providerInstancePriceMonthlyCents: number | null;
      providerInstancePriceHourlyMicros: number | null;
      placementExplanationJson: string | null;
      healthStatus: string;
      lastMetrics: string | null;
      lastHeartbeatAt: string | null;
      agentVersion: string | null;
      pastLifetimeAdmissionCutoff: number;
    }>();

  if (!nodes.results.length) return null;

  const authoritativeNodes = await currentReusableNodeIds(state, rc, nodes.results);

  const nodeIds = nodes.results.map((n) => n.id);
  const usageByNode = await loadActiveWorkspaceReservationUsage(rc.env.DATABASE, nodeIds);

  const candidates: RankedReusableNode[] = [];
  const diagnosticHosts: PlacementHostDiagnosticInput[] = [];
  const rejectionDiagnostics: Array<{ nodeId: string; reasons: string[] }> = [];

  for (const node of nodes.results) {
    const selection = resolveReusableNodeSelection(state, node);
    const evaluation = evaluateReusableNodeCandidate({
      node,
      selection,
      policy,
      usage: usageByNode.get(node.id),
      requestedReservation,
      agentCompatible: isNodeAgentVersionCompatible(
        node.agentVersion,
        rc.env.VM_AGENT_REQUIRED_VERSION
      ),
      satisfiesTaskResources: nodeSatisfiesTaskResources(node, state),
      authoritative: authoritativeNodes.has(node.id),
      pastLifetimeAdmissionCutoff: node.pastLifetimeAdmissionCutoff === 1,
    });
    diagnosticHosts.push(evaluation.diagnosticHost);
    if (evaluation.candidate) candidates.push(evaluation.candidate);
    if (evaluation.rejection) rejectionDiagnostics.push(evaluation.rejection);
  }

  if (!candidates.length) {
    updatePlacementDiagnostics(state, { hosts: diagnosticHosts });
    if (rejectionDiagnostics.length) {
      log.info('task_runner_do.node_capacity_rejected', {
        taskId: state.taskId,
        sample: rejectionDiagnostics.slice(0, 5),
      });
    }
    return null;
  }

  candidates.sort((a, b) => compareReusableHosts(state, a, b));

  const best = candidates[0];
  if (!best) {
    // candidates.length was already checked above — this should never happen.
    return null;
  }
  const pool = state.config.capacityPoolSelection;
  if (pool) {
    const rollout = comparePlacementRolloutHosts({
      userId: state.userId,
      poolId: pool.poolId,
      strategy: pool.strategy,
      settings: pool.selectionSettings,
      candidates,
      compare: (a, b, strategy) => compareReusableHosts(state, a, b, strategy),
    });
    updatePlacementDiagnostics(state, { rollout });
  }
  const selectedDiagnostic = diagnosticHosts.find((host) => host.signals.nodeId === best.id);
  if (selectedDiagnostic) {
    selectedDiagnostic.outcome = 'selected';
    selectedDiagnostic.reasons = [];
  }
  updatePlacementDiagnostics(state, { hosts: diagnosticHosts, selectedNodeId: best.id });
  log.info('task_runner_do.node_capacity_selected', {
    taskId: state.taskId,
    nodeId: best.id,
    startupBacklog: best.signals.startupBacklog,
    admittedCandidates: candidates.length,
  });
  return {
    nodeId: best.id,
    capacityPlacementSnapshot: best.capacityPlacementSnapshot,
    // With an alternative available, a growing queue on the chosen node should send this
    // start to the other one: the final reservation refuses if the backlog has grown.
    observedStartupBacklog: candidates.length > 1 ? best.signals.startupBacklog : null,
  };
}
