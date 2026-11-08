/**
 * Node-placement helpers shared by the warm-pool claim (`warm-node-claim.ts`) and
 * reusable-node selection (`node-selection.ts`). Split out per rule 18.
 */
import {
  type CapacityPlacementSnapshot,
  type ResolvedResourceReservation,
  resolveResourceReservation,
} from '@simple-agent-manager/shared';

import {
  type CapacityAwareNodePlacementRow,
  resolveReusableNodeCapacitySnapshot,
} from '../../services/placement-resolver';
import { filterReusableNodesByCurrentAuthority } from '../../services/reusable-node-authority';
import {
  hasWorkspaceReservationCapacity,
  isResolvedResourceReservation,
  loadActiveWorkspaceReservationUsage,
  parseWorkspaceAdmissionMetrics,
  resolveTrustedWorkspaceNodeCapacity,
  resolveWorkspaceAdmissionPolicy,
  type TrustedWorkspaceNodeCapacityRow,
} from '../../services/workspace-resource-capacity';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export interface ReusableNodeSelection {
  nodeId: string;
  capacityPlacementSnapshot: CapacityPlacementSnapshot | null;
  /**
   * The node's startup backlog when it was ranked above at least one other admitted host. The
   * final reservation refuses if the backlog has grown since, so the run reselects and can take
   * the other host (`maxStartupBacklog`). Null or absent when there was no alternative, and for
   * pinned nodes and warm claims.
   */
  observedStartupBacklog?: number | null;
}

/** Record a reusable node as this run's placement target. */
export function adoptReusableNodeSelection(
  state: TaskRunnerState,
  selection: ReusableNodeSelection
): void {
  state.stepResults.nodeId = selection.nodeId;
  state.stepResults.capacityPlacementSnapshot = selection.capacityPlacementSnapshot;
  // Keyed by node so a value observed for one node can never guard a reservation on another.
  state.stepResults.rankedStartupBacklog =
    selection.observedStartupBacklog === null || selection.observedStartupBacklog === undefined
      ? null
      : { nodeId: selection.nodeId, backlog: selection.observedStartupBacklog };
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

export function resolveReusableNodeSelection(
  state: TaskRunnerState,
  node: NodePlacementFields
): ReusableNodeSelection | null {
  if (node.id === state.config.excludedNodeId) return null;
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

export async function currentReusableNodeIds(
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
