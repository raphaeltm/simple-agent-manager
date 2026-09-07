/**
 * Reusable-node warm-pool claim and capacity-selection helpers.
 *
 * Kept separate from the node step handlers so provisioning and placement
 * policy remain independently reviewable. See rule 18.
 */
import {
  type CapacityPlacementSnapshot,
  type CapacityPoolStrategy,
  type ResolvedResourceReservation,
  resolveResourceReservation,
} from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import { isNodeAgentVersionCompatible } from '../../services/node-agent-compatibility';
import type { PlacementHostDiagnosticInput } from '../../services/placement-diagnostics';
import {
  type CapacityAwareNodePlacementRow,
  resolveReusableNodeCapacitySnapshot,
} from '../../services/placement-resolver';
import {
  comparePlacementRolloutHosts,
  PLACEMENT_ROLLOUT_BASELINE_STRATEGY,
  resolvePlacementRollout,
} from '../../services/placement-rollout';
import {
  comparePlacementHostsByStrategy,
  normalizePlacementHostSignals,
  type PlacementHostSignals,
} from '../../services/placement-strategy';
import { filterReusableNodesByCurrentAuthority } from '../../services/reusable-node-authority';
import {
  SessionRecoveryAuthorityRevokedError,
  type SessionRecoverySourceTaskGuard,
} from '../../services/session-recovery-authority';
import {
  evaluateWorkspaceReservationCapacity,
  hasWorkspaceReservationCapacity,
  isResolvedResourceReservation,
  loadActiveWorkspaceReservationUsage,
  parseWorkspaceAdmissionMetrics,
  resolveTrustedWorkspaceNodeCapacity,
  resolveWorkspaceAdmissionPolicy,
  trustedWorkspaceNodeCapacityColumnsSql,
  type TrustedWorkspaceNodeCapacityRow,
} from '../../services/workspace-resource-capacity';
import type { NodeLifecycle } from '../node-lifecycle';
import { updatePlacementDiagnostics } from './placement-diagnostics';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export { verifyNodeAgentHealthy } from './node-agent-health';

export interface ReusableNodeSelection {
  nodeId: string;
  capacityPlacementSnapshot: CapacityPlacementSnapshot | null;
}

export type NodePlacementFields = {
  id: string;
  vmSize: string | null;
  vmLocation: string | null;
  cloudProvider: string | null;
  capacityPoolId: string | null;
  capacityPoolScope: string | null;
  capacityPoolRevision?: number | null;
  capacitySourceId: string | null;
  capacityPoolCandidateId?: string | null;
  placementCredentialSource?: string | null;
  placementCredentialReference?: string | null;
  placementCredentialVersion?: number | null;
  capacityPoolProjectId: string | null;
  workloadRole: string | null;
  providerInstanceType?: string | null;
  providerInstanceVcpuCount?: number | null;
  providerInstanceMemoryMb?: number | null;
  providerInstanceDiskGb?: number | null;
  providerInstanceBootDiskSizeGb?: number | null;
  providerInstanceImage?: string | null;
  providerInstanceArchitecture?: string | null;
  providerInstancePriceDisplay?: string | null;
  providerInstancePriceCurrency?: string | null;
  providerInstancePriceMonthlyCents?: number | null;
  providerInstancePriceHourlyMicros?: number | null;
  placementExplanationJson?: string | null;
  lastMetrics?: string | null;
  lastHeartbeatAt?: string | null;
} & Partial<TrustedWorkspaceNodeCapacityRow>;

function recoverySourceTaskGuard(
  state: TaskRunnerState
): SessionRecoverySourceTaskGuard | undefined {
  const taskId = state.config.recoverySourceTaskId ?? null;
  const chatSessionId = state.config.resumeSnapshotChatSessionId ?? null;
  return taskId && chatSessionId
    ? { taskId, projectId: state.projectId, chatSessionId }
    : undefined;
}

export async function releaseClaimedWarmNode(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  nodeId: string | null = state.stepResults.claimedWarmNodeId ?? null
): Promise<boolean> {
  if (!nodeId || !rc.env.NODE_LIFECYCLE) return false;
  const doId = rc.env.NODE_LIFECYCLE.idFromName(nodeId);
  const stub = rc.env.NODE_LIFECYCLE.get(doId) as DurableObjectStub<NodeLifecycle>;
  const result = await stub.releaseClaim(state.taskId);
  if (result.released || result.state.claimedByTask !== state.taskId) {
    if (state.stepResults.nodeId === nodeId && !state.stepResults.workspaceId) {
      state.stepResults.nodeId = null;
      state.stepResults.capacityPlacementSnapshot = null;
    }
    if (state.stepResults.claimedWarmNodeId === nodeId) {
      state.stepResults.claimedWarmNodeId = null;
    }
    await rc.ctx.storage.put('state', state);
  }
  return result.released;
}

async function claimWarmNodeCandidate(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  selection: ReusableNodeSelection
): Promise<boolean> {
  const nodeId = selection.nodeId;
  const eligible = await filterReusableNodesByCurrentAuthority(rc.env.DATABASE, {
    userId: state.userId,
    projectId: state.projectId,
    selections: [selection],
  });
  if (!eligible.has(nodeId)) return false;
  const doId = rc.env.NODE_LIFECYCLE.idFromName(nodeId);
  const stub = rc.env.NODE_LIFECYCLE.get(doId) as DurableObjectStub<NodeLifecycle>;
  await rc.assertRecoveryAuthority(state);
  const result = await stub.tryClaim(state.taskId, recoverySourceTaskGuard(state));
  if (result.reason === 'source_task_revoked') {
    await stub.releaseClaim(state.taskId).catch(() => undefined);
    throw new SessionRecoveryAuthorityRevokedError();
  }
  if (!result.claimed) return false;

  // The DO persisted tasks.claimed_warm_node_id before cancelling its alarm.
  // Mirror the claim into TaskRunner storage immediately for ordinary cleanup.
  state.stepResults.nodeId = nodeId;
  state.stepResults.claimedWarmNodeId = nodeId;
  state.stepResults.autoProvisioned = false;
  state.stepResults.capacityPlacementSnapshot = selection.capacityPlacementSnapshot;
  await rc.ctx.storage.put('state', state);
  try {
    await rc.assertRecoveryAuthority(state);
  } catch (error) {
    await releaseClaimedWarmNode(state, rc, nodeId).catch(() => undefined);
    throw error;
  }
  return true;
}

export async function tryClaimWarmNode(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<ReusableNodeSelection | null> {
  if (!rc.env.NODE_LIFECYCLE) return null;

  // Recover a claim persisted by NodeLifecycle if the TaskRunner crashed after
  // the DO mutation but before its own storage.put.
  const persistedClaim = await rc.env.DATABASE.prepare(
    `SELECT
       t.claimed_warm_node_id AS claimedWarmNodeId,
       n.id,
       n.vm_size AS vmSize,
       n.vm_location AS vmLocation,
       n.cloud_provider AS cloudProvider,
       n.capacity_pool_id AS capacityPoolId,
       n.capacity_pool_scope AS capacityPoolScope,
       n.capacity_pool_revision AS capacityPoolRevision,
       n.capacity_source_id AS capacitySourceId,
       n.capacity_pool_candidate_id AS capacityPoolCandidateId,
       n.placement_credential_source AS placementCredentialSource,
       n.placement_credential_reference AS placementCredentialReference,
       n.placement_credential_version AS placementCredentialVersion,
       n.capacity_pool_project_id AS capacityPoolProjectId,
       n.workload_role AS workloadRole,
       ${trustedWorkspaceNodeCapacityColumnsSql('n')},
       n.provider_instance_type AS providerInstanceType,
       n.provider_instance_vcpu_count AS providerInstanceVcpuCount,
       n.provider_instance_memory_mb AS providerInstanceMemoryMb,
       n.provider_instance_disk_gb AS providerInstanceDiskGb,
       n.provider_instance_boot_disk_size_gb AS providerInstanceBootDiskSizeGb,
       n.provider_instance_image AS providerInstanceImage,
       n.provider_instance_architecture AS providerInstanceArchitecture,
       n.provider_instance_price_display AS providerInstancePriceDisplay,
       n.provider_instance_price_currency AS providerInstancePriceCurrency,
       n.provider_instance_price_monthly_cents AS providerInstancePriceMonthlyCents,
       n.provider_instance_price_hourly_micros AS providerInstancePriceHourlyMicros,
       n.placement_explanation_json AS placementExplanationJson,
       n.last_metrics AS lastMetrics,
       n.last_heartbeat_at AS lastHeartbeatAt
     FROM tasks t
     LEFT JOIN nodes n ON n.id = t.claimed_warm_node_id
     WHERE t.id = ?`
  )
    .bind(state.taskId)
    .first<(NodePlacementFields & { claimedWarmNodeId: string | null }) | null>();
  if (persistedClaim?.claimedWarmNodeId) {
    const selection = persistedClaim.id
      ? resolveReusableNodeSelection(state, persistedClaim)
      : null;
    if (selection && (await claimWarmNodeCandidate(state, rc, selection))) {
      return selection;
    }
    // The persisted warm claim can no longer be used: either the referenced
    // node is no longer a reusable selection, or claiming it failed. Release
    // the NodeLifecycle claim first (NodeLifecycle.alarm() does not expire
    // active claims), then clear the D1 pointer so the node becomes reusable.
    await releaseClaimedWarmNode(state, rc, persistedClaim.claimedWarmNodeId).catch(
      () => undefined
    );
    await rc.env.DATABASE.prepare(
      `UPDATE tasks SET claimed_warm_node_id = NULL, claimed_warm_node_at = NULL, updated_at = ?
        WHERE id = ? AND claimed_warm_node_id = ?`
    )
      .bind(new Date().toISOString(), state.taskId, persistedClaim.claimedWarmNodeId)
      .run();
  }

  const warmNodes = await rc.env.DATABASE.prepare(
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
       last_metrics AS lastMetrics,
       last_heartbeat_at AS lastHeartbeatAt,
       agent_version AS agentVersion
     FROM nodes
     WHERE user_id = ? AND status = 'running' AND warm_since IS NOT NULL AND node_role = 'workspace'
       AND (runtime IS NULL OR runtime != 'cf-container')`
  )
    .bind(state.userId)
    .all<NodePlacementFields & { agentVersion: string | null }>();

  if (!warmNodes.results.length) return null;

  // Warm hosts are ranked by the SAME strategy comparator as occupied reuse, so
  // an operator's pool strategy is observable on the warm path too. It used to
  // rank on `vmSize` equality, which made every strategy pick the same host.
  const warmPolicy = resolveWorkspaceAdmissionPolicy(rc.env, state.config.projectScaling);
  const warmReservation = getTaskReservation(state);
  const warmUsage = await loadActiveWorkspaceReservationUsage(
    rc.env.DATABASE,
    warmNodes.results.map((node) => node.id)
  );
  const warmStrategy = taskPlacementStrategy(state);
  const warmSelectionSettings = state.config.capacityPoolSelection?.selectionSettings;
  const authoritativeWarmNodes = await currentReusableNodeIds(state, rc, warmNodes.results);
  const sorted = warmNodes.results
    .filter((node) => authoritativeWarmNodes.has(node.id))
    .filter((node) =>
      isNodeAgentVersionCompatible(node.agentVersion, rc.env.VM_AGENT_REQUIRED_VERSION)
    )
    .filter((node) => nodeSatisfiesTaskResources(node, state))
    .flatMap((node) => {
      const selection = resolveReusableNodeSelection(state, node);
      if (!selection) return [];
      const signals = normalizePlacementHostSignals({
        node,
        usage: warmUsage.get(node.id),
        request: warmReservation,
        policy: warmPolicy,
      });
      return [{ ...node, selection, signals }];
    })
    .sort((a, b) => {
      const aLocMatch = a.vmLocation === state.config.vmLocation ? 1 : 0;
      const bLocMatch = b.vmLocation === state.config.vmLocation ? 1 : 0;
      if (aLocMatch !== bLocMatch) return bLocMatch - aLocMatch;
      return comparePlacementHostsByStrategy(
        a.signals,
        b.signals,
        warmStrategy,
        warmSelectionSettings
      );
    });

  for (const warmNode of sorted) {
    try {
      // Re-check freshness
      const fresh = await rc.env.DATABASE.prepare(
        `SELECT
           id,
           status,
           warm_since AS warmSince,
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
           last_metrics AS lastMetrics,
           last_heartbeat_at AS lastHeartbeatAt,
           agent_version AS agentVersion
         FROM nodes WHERE id = ? AND status = 'running' AND warm_since IS NOT NULL`
      )
        .bind(warmNode.id)
        .first<
          | (NodePlacementFields & {
              status: string;
              warmSince: string | null;
              agentVersion: string | null;
            })
          | null
        >();

      if (
        !fresh ||
        !isNodeAgentVersionCompatible(fresh.agentVersion, rc.env.VM_AGENT_REQUIRED_VERSION)
      ) {
        continue;
      }
      const selection = resolveReusableNodeSelection(state, fresh);
      if (!selection) continue;

      if (await claimWarmNodeCandidate(state, rc, selection)) {
        if (!(await hasReusableNodeReservationCapacity(rc, state, fresh))) {
          await releaseClaimedWarmNode(state, rc, warmNode.id);
          continue;
        }
        log.info('task_runner_do.warm_node_claimed', {
          taskId: state.taskId,
          nodeId: warmNode.id,
          capacityPoolId: selection.capacityPlacementSnapshot?.capacityPoolId ?? null,
          capacitySourceId: selection.capacityPlacementSnapshot?.capacitySourceId ?? null,
          capacityPoolCandidateId:
            selection.capacityPlacementSnapshot?.capacityPoolCandidateId ?? null,
        });
        updatePlacementDiagnostics(state, {
          selectedNodeId: warmNode.id,
          hosts: [
            {
              signals: warmNode.signals,
              outcome: 'selected',
              reasons: [],
              provider: warmNode.cloudProvider,
              location: warmNode.vmLocation,
              providerInstanceType: warmNode.providerInstanceType,
            },
          ],
        });
        return selection;
      }
    } catch (error) {
      if (error instanceof SessionRecoveryAuthorityRevokedError) throw error;
      if (state.stepResults.claimedWarmNodeId === warmNode.id) {
        await releaseClaimedWarmNode(state, rc, warmNode.id).catch(() => undefined);
      }
      // Claim failed — try next
    }
  }

  return null;
}

export async function findNodeWithCapacity(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<ReusableNodeSelection | null> {
  const scaling = state.config.projectScaling;
  const policy = resolveWorkspaceAdmissionPolicy(rc.env, scaling);
  const requestedReservation = getTaskReservation(state);

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
       agent_version AS agentVersion
     FROM nodes
     WHERE user_id = ? AND status = 'running' AND health_status != 'unhealthy' AND node_role = 'workspace'
       AND (runtime IS NULL OR runtime != 'cf-container')`
  )
    .bind(state.userId)
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
    }>();

  if (!nodes.results.length) return null;

  const authoritativeNodes = await currentReusableNodeIds(state, rc, nodes.results);

  const nodeIds = nodes.results.map((n) => n.id);
  const usageByNode = await loadActiveWorkspaceReservationUsage(rc.env.DATABASE, nodeIds);

  type RankedNode = {
    id: string;
    vmLocation: string;
    capacityPlacementSnapshot: CapacityPlacementSnapshot | null;
    signals: PlacementHostSignals;
  };

  const candidates: RankedNode[] = [];
  const diagnosticHosts: PlacementHostDiagnosticInput[] = [];
  const rejectionDiagnostics: Array<{ nodeId: string; reasons: string[] }> = [];

  for (const node of nodes.results) {
    const metrics = parseWorkspaceAdmissionMetrics(node, policy);
    const signals = normalizePlacementHostSignals({
      node,
      usage: usageByNode.get(node.id),
      request: requestedReservation,
      policy,
      metrics,
    });
    const selection = resolveReusableNodeSelection(state, node);
    const exclusion = !isNodeAgentVersionCompatible(
      node.agentVersion,
      rc.env.VM_AGENT_REQUIRED_VERSION
    )
      ? 'Host agent version is incompatible'
      : !nodeSatisfiesTaskResources(node, state)
        ? 'Trusted host hardware does not satisfy the requested resources'
        : !selection || !authoritativeNodes.has(node.id)
          ? 'Host is outside the current pool allocation authority'
          : null;
    if (exclusion || !selection) {
      diagnosticHosts.push({
        signals,
        outcome: 'rejected',
        reasons: [exclusion ?? 'Host is not eligible'],
        provider: node.cloudProvider,
        location: node.vmLocation,
        providerInstanceType: node.providerInstanceType,
      });
      continue;
    }

    const capacity = evaluateWorkspaceReservationCapacity(
      node,
      usageByNode.get(node.id),
      requestedReservation,
      policy,
      metrics
    );
    const diagnosticHost: PlacementHostDiagnosticInput = {
      signals: normalizePlacementHostSignals({
        node,
        usage: usageByNode.get(node.id),
        request: requestedReservation,
        policy,
        metrics,
      }),
      outcome: 'rejected',
      reasons: capacity.admitted ? ['Another eligible host ranked higher'] : capacity.reasons,
      provider: node.cloudProvider,
      location: node.vmLocation,
      providerInstanceType: node.providerInstanceType,
    };
    diagnosticHosts.push(diagnosticHost);
    if (!capacity.admitted) {
      rejectionDiagnostics.push({ nodeId: node.id, reasons: capacity.reasons });
      continue;
    }
    candidates.push({
      id: node.id,
      vmLocation: node.vmLocation,
      capacityPlacementSnapshot: selection.capacityPlacementSnapshot,
      signals: normalizePlacementHostSignals({
        node,
        usage: usageByNode.get(node.id),
        request: requestedReservation,
        policy,
        metrics,
      }),
    });
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

  // Requested location stays a hard preference (an explicit locality constraint
  // the caller made), then the pool's configured strategy decides. The former
  // `vmSize === config.vmSize` tier is gone: a size label never outranked
  // concrete capacity, it only made every strategy behave like `balanced`.
  const strategy = taskPlacementStrategy(state);
  const selectionSettings = state.config.capacityPoolSelection?.selectionSettings;
  candidates.sort((a, b) => {
    const aLoc = a.vmLocation === state.config.vmLocation ? 1 : 0;
    const bLoc = b.vmLocation === state.config.vmLocation ? 1 : 0;
    if (aLoc !== bLoc) return bLoc - aLoc;
    return comparePlacementHostsByStrategy(a.signals, b.signals, strategy, selectionSettings);
  });

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
      location: state.config.vmLocation,
      candidates,
    });
    updatePlacementDiagnostics(state, { rollout });
  }
  const selectedDiagnostic = diagnosticHosts.find((host) => host.signals.nodeId === best.id);
  if (selectedDiagnostic) {
    selectedDiagnostic.outcome = 'selected';
    selectedDiagnostic.reasons = [];
  }
  updatePlacementDiagnostics(state, { hosts: diagnosticHosts, selectedNodeId: best.id });
  return { nodeId: best.id, capacityPlacementSnapshot: best.capacityPlacementSnapshot };
}

export async function hasReusableNodeReservationCapacity(
  rc: TaskRunnerContext,
  state: TaskRunnerState,
  node: NodePlacementFields
): Promise<boolean> {
  const policy = resolveWorkspaceAdmissionPolicy(rc.env, state.config.projectScaling);
  const usage = await loadActiveWorkspaceReservationUsage(rc.env.DATABASE, [node.id]);
  return hasWorkspaceReservationCapacity(
    node,
    usage.get(node.id),
    getTaskReservation(state),
    policy,
    parseWorkspaceAdmissionMetrics(node, policy)
  );
}

function resolveReusableNodeSelection(
  state: TaskRunnerState,
  node: NodePlacementFields
): ReusableNodeSelection | null {
  const capacityPlacementSnapshot = resolveReusableNodeCapacitySnapshot({
    selection: state.config.capacityPoolSelection,
    node: node as CapacityAwareNodePlacementRow,
    projectId: state.projectId,
    requestedVmSize: state.config.vmSize,
    requestedReservation: getTaskReservation(state),
  });
  if (capacityPlacementSnapshot === undefined) return null;
  return {
    nodeId: node.id,
    capacityPlacementSnapshot,
  };
}

async function currentReusableNodeIds(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  nodes: readonly NodePlacementFields[]
): Promise<Set<string>> {
  return filterReusableNodesByCurrentAuthority(rc.env.DATABASE, {
    userId: state.userId,
    projectId: state.projectId,
    selections: nodes.flatMap((node) => {
      const selection = resolveReusableNodeSelection(state, node);
      return selection ? [selection] : [];
    }),
  });
}

/**
 * Whether a host's hardware can satisfy the canonical reservation.
 *
 * Ranks concrete capacity only. The legacy `canSatisfyVmSize(node.vmSize, ...)`
 * fallback this replaced let a stale `vm_size` label — a transport/compatibility
 * field, not an authority — admit a host whose real hardware was never verified.
 * Trusted OBSERVED capacity is preferred; the planned provider-native offering is
 * accepted only as a pre-heartbeat estimate for a node that carries a native
 * instance identity. A host with neither fails closed: `vm_size` alone can no
 * longer admit anything. `evaluateWorkspaceReservationCapacity` independently
 * re-rejects such a host, so this is defence in depth, not the only gate.
 */
export function nodeSatisfiesTaskResources(
  node: NodePlacementFields,
  state: TaskRunnerState
): boolean {
  const reservation = getTaskReservation(state);
  if (!reservation) return false;

  const trusted = resolveTrustedWorkspaceNodeCapacity(node);
  if (trusted.source !== null) {
    return offeringSatisfiesReservation(
      {
        vcpuCount: trusted.vcpuCount ?? 0,
        memoryMb: trusted.memoryMb ?? 0,
        diskGb: trusted.diskGb,
      },
      reservation
    );
  }

  // Pre-heartbeat compatibility estimate: a node that carries a provider-native
  // instance identity may be ranked on its PLANNED offering until observed
  // hardware arrives. Marked as an estimate in placement diagnostics.
  const plannedVcpu = positiveInteger(node.providerInstanceVcpuCount);
  const plannedMemoryMb = positiveInteger(node.providerInstanceMemoryMb);
  if (node.providerInstanceType && plannedVcpu !== null && plannedMemoryMb !== null) {
    return offeringSatisfiesReservation(
      {
        vcpuCount: plannedVcpu,
        memoryMb: plannedMemoryMb,
        diskGb: optionalPositiveInteger(node.providerInstanceDiskGb),
      },
      reservation
    );
  }

  return false;
}

function offeringSatisfiesReservation(
  offering: { vcpuCount: number; memoryMb: number; diskGb: number | null },
  reservation: ResolvedResourceReservation
): boolean {
  if (offering.vcpuCount * 1000 < reservation.cpuMillis) return false;
  if (offering.memoryMb < reservation.memoryMb) return false;
  if (offering.diskGb !== null && offering.diskGb * 1024 < reservation.diskMb) return false;
  return true;
}

/**
 * The effective pool's configured packing strategy for this run.
 *
 * A run with no capacity-pool selection is a legacy/unpooled placement: it keeps
 * the historical least-loaded ordering, which `balanced` reproduces exactly.
 */
export function taskPlacementStrategy(state: TaskRunnerState): CapacityPoolStrategy {
  const selection = state.config.capacityPoolSelection;
  if (!selection) return PLACEMENT_ROLLOUT_BASELINE_STRATEGY;
  return resolvePlacementRollout({
    userId: state.userId,
    poolId: selection.poolId,
    strategy: selection.strategy,
    cohortPercent: selection.selectionSettings?.rolloutCohortPercent,
  }).appliedStrategy;
}

export function getTaskReservation(state: TaskRunnerState): ResolvedResourceReservation {
  if (isResolvedResourceReservation(state.config.resolvedReservation)) {
    return state.config.resolvedReservation;
  }

  return resolveResourceReservation(
    { task: state.config.resourceRequirements ?? undefined },
    {
      taskId: state.taskId,
      projectId: state.projectId,
      userId: state.userId,
    }
  );
}

function positiveInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function optionalPositiveInteger(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return positiveInteger(value);
}
