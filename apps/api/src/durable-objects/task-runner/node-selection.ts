/**
 * Reusable-node health, warm-pool claim, and capacity-selection helpers.
 *
 * Kept separate from the node step handlers so provisioning and placement
 * policy remain independently reviewable. See rule 18.
 */
import {
  canSatisfyVmSize,
  type CapacityPlacementSnapshot,
  DEFAULT_MAX_WORKSPACES_PER_NODE,
  DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT,
  DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT,
  type ResolvedResourceReservation,
} from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import { isNodeAgentVersionCompatible } from '../../services/node-agent-compatibility';
import {
  type CapacityAwareNodePlacementRow,
  resolveReusableNodeCapacitySnapshot,
} from '../../services/placement-resolver';
import {
  SessionRecoveryAuthorityRevokedError,
  type SessionRecoverySourceTaskGuard,
} from '../../services/session-recovery-authority';
import type { NodeLifecycle } from '../node-lifecycle';
import { parseEnvInt } from './helpers';
import type { TaskRunnerContext, TaskRunnerState } from './types';

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
  providerInstancePriceDisplay?: string | null;
  providerInstancePriceCurrency?: string | null;
  providerInstancePriceMonthlyCents?: number | null;
  providerInstancePriceHourlyMicros?: number | null;
  placementExplanationJson?: string | null;
};

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

/**
 * Verify that the VM agent on a node is actually healthy by checking D1
 * heartbeat records. We cannot fetch the VM directly because Cloudflare
 * same-zone routing intercepts Worker subrequests to vm-* hostnames,
 * routing them back to this API Worker instead of the VM agent.
 */
export async function verifyNodeAgentHealthy(
  nodeId: string,
  rc: TaskRunnerContext
): Promise<boolean> {
  try {
    const node = await rc.env.DATABASE.prepare(
      `SELECT health_status, last_heartbeat_at, agent_ready_at, agent_version FROM nodes WHERE id = ?`
    )
      .bind(nodeId)
      .first<{
        health_status: string | null;
        last_heartbeat_at: string | null;
        agent_ready_at: string | null;
        agent_version: string | null;
      }>();

    if (
      !node ||
      node.health_status !== 'healthy' ||
      !node.last_heartbeat_at ||
      !node.agent_ready_at ||
      !isNodeAgentVersionCompatible(node.agent_version, rc.env.VM_AGENT_REQUIRED_VERSION)
    ) {
      return false;
    }

    // Consider node healthy if heartbeat is within the stale threshold
    const staleSeconds = parseInt(rc.env.NODE_HEARTBEAT_STALE_SECONDS || '180', 10);
    const heartbeatAge = (Date.now() - new Date(node.last_heartbeat_at).getTime()) / 1000;
    return heartbeatAge < staleSeconds;
  } catch {
    return false;
  }
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
       n.provider_instance_type AS providerInstanceType,
       n.provider_instance_vcpu_count AS providerInstanceVcpuCount,
       n.provider_instance_memory_mb AS providerInstanceMemoryMb,
       n.provider_instance_disk_gb AS providerInstanceDiskGb,
       n.provider_instance_price_display AS providerInstancePriceDisplay,
       n.provider_instance_price_currency AS providerInstancePriceCurrency,
       n.provider_instance_price_monthly_cents AS providerInstancePriceMonthlyCents,
       n.provider_instance_price_hourly_micros AS providerInstancePriceHourlyMicros,
       n.placement_explanation_json AS placementExplanationJson
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
    await releaseClaimedWarmNode(state, rc, persistedClaim.claimedWarmNodeId).catch(() => undefined);
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
       provider_instance_type AS providerInstanceType,
       provider_instance_vcpu_count AS providerInstanceVcpuCount,
       provider_instance_memory_mb AS providerInstanceMemoryMb,
       provider_instance_disk_gb AS providerInstanceDiskGb,
       provider_instance_price_display AS providerInstancePriceDisplay,
       provider_instance_price_currency AS providerInstancePriceCurrency,
       provider_instance_price_monthly_cents AS providerInstancePriceMonthlyCents,
       provider_instance_price_hourly_micros AS providerInstancePriceHourlyMicros,
       placement_explanation_json AS placementExplanationJson,
       agent_version AS agentVersion
     FROM nodes
     WHERE user_id = ? AND status = 'running' AND warm_since IS NOT NULL AND node_role = 'workspace'
       AND (runtime IS NULL OR runtime != 'cf-container')`
  )
    .bind(state.userId)
    .all<NodePlacementFields & { agentVersion: string | null }>();

  if (!warmNodes.results.length) return null;

  // Sort nodes that can satisfy the requested size, preferring exact size/location.
  const sorted = warmNodes.results
    .filter((node) =>
      isNodeAgentVersionCompatible(node.agentVersion, rc.env.VM_AGENT_REQUIRED_VERSION)
    )
    .filter((node) => nodeSatisfiesTaskResources(node, state))
    .flatMap((node) => {
      const selection = resolveReusableNodeSelection(state, node);
      return selection ? [{ ...node, selection }] : [];
    })
    .sort((a, b) => {
      const aSizeMatch = a.vmSize === state.config.vmSize ? 1 : 0;
      const bSizeMatch = b.vmSize === state.config.vmSize ? 1 : 0;
      if (aSizeMatch !== bSizeMatch) return bSizeMatch - aSizeMatch;
      const aLocMatch = a.vmLocation === state.config.vmLocation ? 1 : 0;
      const bLocMatch = b.vmLocation === state.config.vmLocation ? 1 : 0;
      return bLocMatch - aLocMatch;
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
           provider_instance_type AS providerInstanceType,
           provider_instance_vcpu_count AS providerInstanceVcpuCount,
           provider_instance_memory_mb AS providerInstanceMemoryMb,
           provider_instance_disk_gb AS providerInstanceDiskGb,
           provider_instance_price_display AS providerInstancePriceDisplay,
           provider_instance_price_currency AS providerInstancePriceCurrency,
           provider_instance_price_monthly_cents AS providerInstancePriceMonthlyCents,
           provider_instance_price_hourly_micros AS providerInstancePriceHourlyMicros,
           placement_explanation_json AS placementExplanationJson,
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
        // Defense-in-depth: verify workspace count even for warm nodes
        const wsCount = await rc.env.DATABASE.prepare(
          `SELECT COUNT(*) as c FROM workspaces WHERE node_id = ? AND status IN ('running', 'creating', 'recovery')`
        )
          .bind(warmNode.id)
          .first<{ c: number }>();
        const warmMaxWs =
          state.config.projectScaling?.maxWorkspacesPerNode ??
          parseEnvInt(rc.env.MAX_WORKSPACES_PER_NODE, DEFAULT_MAX_WORKSPACES_PER_NODE);
        if ((wsCount?.c ?? 0) >= warmMaxWs) {
          await releaseClaimedWarmNode(state, rc, warmNode.id);
          continue; // At capacity despite being warm — skip
        }
        log.info('task_runner_do.warm_node_claimed', {
          taskId: state.taskId,
          nodeId: warmNode.id,
          capacityPoolId: selection.capacityPlacementSnapshot?.capacityPoolId ?? null,
          capacitySourceId: selection.capacityPlacementSnapshot?.capacitySourceId ?? null,
          capacityPoolCandidateId:
            selection.capacityPlacementSnapshot?.capacityPoolCandidateId ?? null,
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
  const cpuThreshold =
    scaling?.nodeCpuThresholdPercent ??
    parseEnvInt(
      rc.env.TASK_RUN_NODE_CPU_THRESHOLD_PERCENT,
      DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT
    );
  const memThreshold =
    scaling?.nodeMemoryThresholdPercent ??
    parseEnvInt(
      rc.env.TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT,
      DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT
    );
  const maxWorkspaces =
    scaling?.maxWorkspacesPerNode ??
    parseEnvInt(rc.env.MAX_WORKSPACES_PER_NODE, DEFAULT_MAX_WORKSPACES_PER_NODE);

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
       provider_instance_type AS providerInstanceType,
       provider_instance_vcpu_count AS providerInstanceVcpuCount,
       provider_instance_memory_mb AS providerInstanceMemoryMb,
       provider_instance_disk_gb AS providerInstanceDiskGb,
       provider_instance_price_display AS providerInstancePriceDisplay,
       provider_instance_price_currency AS providerInstancePriceCurrency,
       provider_instance_price_monthly_cents AS providerInstancePriceMonthlyCents,
       provider_instance_price_hourly_micros AS providerInstancePriceHourlyMicros,
       placement_explanation_json AS placementExplanationJson,
       health_status AS healthStatus,
       last_metrics AS lastMetrics,
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
      providerInstanceType: string | null;
      providerInstanceVcpuCount: number | null;
      providerInstanceMemoryMb: number | null;
      providerInstanceDiskGb: number | null;
      providerInstancePriceDisplay: string | null;
      providerInstancePriceCurrency: string | null;
      providerInstancePriceMonthlyCents: number | null;
      providerInstancePriceHourlyMicros: number | null;
      placementExplanationJson: string | null;
      healthStatus: string;
      lastMetrics: string | null;
      agentVersion: string | null;
    }>();

  if (!nodes.results.length) return null;

  // Batch workspace count query to avoid N+1 D1 round-trips
  const nodeIds = nodes.results.map((n) => n.id);
  const placeholders = nodeIds.map(() => '?').join(',');
  const wsCounts = await rc.env.DATABASE.prepare(
    `SELECT node_id, COUNT(*) as c FROM workspaces
     WHERE node_id IN (${placeholders})
     AND status IN ('running', 'creating', 'recovery')
     GROUP BY node_id`
  )
    .bind(...nodeIds)
    .all<{ node_id: string; c: number }>();
  const countByNode = new Map((wsCounts.results ?? []).map((r) => [r.node_id, r.c]));

  type ScoredNode = {
    id: string;
    vmSize: string;
    vmLocation: string;
    capacityPlacementSnapshot: CapacityPlacementSnapshot | null;
    score: number | null;
  };

  const candidates: ScoredNode[] = [];

  for (const node of nodes.results) {
    if (!isNodeAgentVersionCompatible(node.agentVersion, rc.env.VM_AGENT_REQUIRED_VERSION)) {
      continue;
    }
    if (!nodeSatisfiesTaskResources(node, state)) continue;
    const selection = resolveReusableNodeSelection(state, node);
    if (!selection) continue;

    // Hard workspace count limit — reject node regardless of CPU/memory metrics
    if ((countByNode.get(node.id) ?? 0) >= maxWorkspaces) continue;
    let metrics: {
      cpuLoadAvg1?: number;
      memoryPercent?: number;
      creatingWorkspaces?: number;
    } | null = null;
    if (node.lastMetrics) {
      try {
        metrics = JSON.parse(node.lastMetrics);
      } catch {
        /* ignore */
      }
    }

    if (metrics) {
      if ((metrics.creatingWorkspaces ?? 0) > 0) continue;
      const cpu = metrics.cpuLoadAvg1 ?? 0;
      const mem = metrics.memoryPercent ?? 0;
      if (cpu >= cpuThreshold || mem >= memThreshold) continue;
      candidates.push({
        id: node.id,
        vmSize: node.vmSize,
        vmLocation: node.vmLocation,
        capacityPlacementSnapshot: selection.capacityPlacementSnapshot,
        score: cpu * 0.4 + mem * 0.6,
      });
    } else {
      candidates.push({
        id: node.id,
        vmSize: node.vmSize,
        vmLocation: node.vmLocation,
        capacityPlacementSnapshot: selection.capacityPlacementSnapshot,
        score: null,
      });
    }
  }

  if (!candidates.length) return null;

  // Sort: prefer matching location/size, then lowest load
  candidates.sort((a, b) => {
    const aLoc = a.vmLocation === state.config.vmLocation ? 1 : 0;
    const bLoc = b.vmLocation === state.config.vmLocation ? 1 : 0;
    if (aLoc !== bLoc) return bLoc - aLoc;
    const aSize = a.vmSize === state.config.vmSize ? 1 : 0;
    const bSize = b.vmSize === state.config.vmSize ? 1 : 0;
    if (aSize !== bSize) return bSize - aSize;
    if (a.score === null && b.score === null) return 0;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return a.score - b.score;
  });

  const best = candidates[0];
  if (!best) {
    // candidates.length was already checked above — this should never happen.
    return null;
  }
  return { nodeId: best.id, capacityPlacementSnapshot: best.capacityPlacementSnapshot };
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
    requestedReservation: state.config.resolvedReservation ?? null,
  });
  if (capacityPlacementSnapshot === undefined) return null;
  return {
    nodeId: node.id,
    capacityPlacementSnapshot,
  };
}

export function nodeSatisfiesTaskResources(
  node: NodePlacementFields,
  state: TaskRunnerState
): boolean {
  const reservation = state.config.resolvedReservation ?? null;
  if (
    reservation &&
    node.providerInstanceType &&
    positiveInteger(node.providerInstanceVcpuCount) !== null &&
    positiveInteger(node.providerInstanceMemoryMb) !== null
  ) {
    return offeringSatisfiesReservation(
      {
        vcpuCount: positiveInteger(node.providerInstanceVcpuCount) ?? 0,
        memoryMb: positiveInteger(node.providerInstanceMemoryMb) ?? 0,
        diskGb: optionalPositiveInteger(node.providerInstanceDiskGb),
      },
      reservation
    );
  }

  return canSatisfyVmSize(node.vmSize, state.config.vmSize);
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

function positiveInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function optionalPositiveInteger(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return positiveInteger(value);
}
