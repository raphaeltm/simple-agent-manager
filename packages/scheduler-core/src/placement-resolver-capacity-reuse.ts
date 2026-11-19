/** Matching an existing node to the effective pool's candidates for reuse. */
import type {
  CapacityPlacementSnapshot,
  ResolvedResourceReservation,
} from '@simple-agent-manager/shared';

import { legacyReusableNodeMatches } from './legacy-node-pool-compatibility';
import { capacityPlacementSnapshotForCandidate } from './placement-resolver-capacity-snapshot';
import type {
  CapacityAwareNodePlacementRow,
  TaskStartCapacityCandidate,
  TaskStartCapacityPoolSelection,
} from './placement-resolver-types';

export function hasNoCapacityPoolCandidates(
  selection: TaskStartCapacityPoolSelection | null | undefined
): boolean {
  return !!selection && selection.candidates.length === 0;
}

export function resolveReusableNodeCapacitySnapshot(input: {
  selection: TaskStartCapacityPoolSelection | null | undefined;
  node: CapacityAwareNodePlacementRow;
  projectId: string;
  requestedVmSize: string;
  requestedReservation?: ResolvedResourceReservation | null;
}): CapacityPlacementSnapshot | null | undefined {
  const selection = input.selection ?? null;
  const node = input.node;

  if (!selection) {
    if (node.capacityPoolScope === 'project') return undefined;
    return null;
  }

  if (hasNoCapacityPoolCandidates(selection)) {
    return undefined;
  }

  if (!node.capacityPoolId) {
    // Legacy nodes drain once any effective pool exists. An incomplete pool
    // snapshot cannot pass final admission and would be selected again on retry.
    return undefined;
  }

  if (selection.scope === 'project') {
    if (node.capacityPoolScope !== 'project') return undefined;
    if (node.capacityPoolId !== selection.poolId) return undefined;
    if (node.capacityPoolProjectId !== input.projectId) return undefined;
  } else {
    if (node.capacityPoolScope === 'project') return undefined;
    if (node.capacityPoolId !== selection.poolId) return undefined;
  }

  const candidate = selectCandidateForReusableNode(
    selection,
    node,
    input.requestedVmSize,
    input.requestedReservation ?? null
  );
  return candidate ? capacityPlacementSnapshotForCandidate(selection, candidate) : undefined;
}

function selectCandidateForReusableNode(
  selection: TaskStartCapacityPoolSelection,
  node: CapacityAwareNodePlacementRow,
  requestedVmSize: string,
  requestedReservation: ResolvedResourceReservation | null
): TaskStartCapacityCandidate | null {
  if (!node.capacitySourceId) return null;

  const exactCandidate = node.capacityPoolCandidateId
    ? selection.candidates.find((candidate) => candidate.id === node.capacityPoolCandidateId)
    : null;
  if (
    exactCandidate &&
    capacityCandidateMatchesNode(exactCandidate, node, requestedVmSize, requestedReservation)
  ) {
    return exactCandidate;
  }

  return (
    selection.candidates.find((candidate) =>
      capacityCandidateMatchesNode(candidate, node, requestedVmSize, requestedReservation)
    ) ?? null
  );
}

function capacityCandidateMatchesNode(
  candidate: TaskStartCapacityCandidate,
  node: CapacityAwareNodePlacementRow,
  requestedVmSize: string,
  requestedReservation: ResolvedResourceReservation | null
): boolean {
  if (candidate.capacitySourceId !== node.capacitySourceId) return false;
  if (node.cloudProvider && candidate.provider !== node.cloudProvider) return false;
  if (node.vmLocation && candidate.location !== node.vmLocation) return false;
  if (node.providerInstanceType) {
    if (candidate.providerInstanceType !== node.providerInstanceType) return false;
  } else if (candidate.machineSize && node.vmSize) {
    if (
      !legacyReusableNodeMatches({
        nodeVmSize: node.vmSize,
        requestedVmSize,
        candidateMachineSize: candidate.machineSize,
      })
    ) {
      return false;
    }
  } else {
    return false;
  }

  if (requestedReservation) {
    if (
      !nodeOfferingSatisfiesReservation(
        node,
        requestedReservation,
        node.providerInstanceType ? candidate : null
      )
    ) {
      return false;
    }
  }

  if (node.providerInstanceType) return true;
  return legacyReusableNodeMatches({
    nodeVmSize: node.vmSize,
    requestedVmSize,
    candidateMachineSize: null,
  });
}

export function capacityCandidateSatisfiesReservation(
  candidate: Pick<
    TaskStartCapacityCandidate,
    'providerInstanceVcpuCount' | 'providerInstanceMemoryMb' | 'providerInstanceDiskGb'
  >,
  reservation: ResolvedResourceReservation
): boolean {
  if (candidate.providerInstanceVcpuCount * 1000 < reservation.cpuMillis) return false;
  if (candidate.providerInstanceMemoryMb < reservation.memoryMb) return false;
  if (
    candidate.providerInstanceDiskGb !== null &&
    candidate.providerInstanceDiskGb * 1024 < reservation.diskMb
  ) {
    return false;
  }
  return true;
}

function nodeOfferingSatisfiesReservation(
  node: CapacityAwareNodePlacementRow,
  reservation: ResolvedResourceReservation,
  fallbackCandidate: TaskStartCapacityCandidate | null
): boolean {
  const vcpuCount = positiveInteger(node.providerInstanceVcpuCount);
  const memoryMb = positiveInteger(node.providerInstanceMemoryMb);
  const diskGb = optionalPositiveInteger(node.providerInstanceDiskGb);

  if (vcpuCount !== null && memoryMb !== null) {
    return capacityCandidateSatisfiesReservation(
      {
        providerInstanceVcpuCount: vcpuCount,
        providerInstanceMemoryMb: memoryMb,
        providerInstanceDiskGb: diskGb,
      },
      reservation
    );
  }

  if (fallbackCandidate) {
    return capacityCandidateSatisfiesReservation(fallbackCandidate, reservation);
  }

  return true;
}

export function positiveInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

export function optionalPositiveInteger(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return positiveInteger(value);
}
