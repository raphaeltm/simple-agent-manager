import type {
  CapacityPlacementSnapshot,
  CapacityPool as CapacityPoolDto,
  CapacityPoolCandidate as CapacityPoolCandidateDto,
  CapacityPoolStrategy,
  CapacitySourceIdentity,
  CapacityWorkloadRole,
  CredentialSource,
  ResolvedResourceReservation,
  VMLocation,
  VMSize,
} from '@simple-agent-manager/shared';
import {
  canSatisfyVmSize,
  isCapacityPlacementCredentialSource,
  isValidLocationForProvider,
  isValidProvider,
} from '@simple-agent-manager/shared';

import type { CapacityPoolSummary } from './default-capacity-pools';
import type {
  CapacityAwareNodePlacementRow,
  TaskStartCapacityCandidate,
  TaskStartCapacityPoolSelection,
  TaskStartPlacement,
} from './placement-resolver-types';

export function capacityPoolSnapshotForPool(
  selection: Pick<
    TaskStartCapacityPoolSelection,
    'poolId' | 'scope' | 'revision' | 'strategy' | 'capacityPoolProjectId' | 'workloadRole'
  >
): CapacityPlacementSnapshot {
  return {
    capacityPoolId: selection.poolId,
    capacityPoolScope: selection.scope,
    capacityPoolRevision: selection.revision,
    capacitySourceId: null,
    capacityPoolCandidateId: null,
    placementCredentialSource: null,
    placementCredentialReference: null,
    placementCredentialVersion: null,
    capacityPoolProjectId: selection.capacityPoolProjectId,
    workloadRole: selection.workloadRole,
    placementExplanationJson: buildCapacityPlacementExplanation(selection),
  };
}

export function capacityPlacementSnapshotForTaskStart(
  selection: TaskStartCapacityPoolSelection | null | undefined
): CapacityPlacementSnapshot | null {
  const candidate = selection?.candidates[0] ?? null;
  if (!selection) return null;
  return candidate
    ? capacityPlacementSnapshotForCandidate(selection, candidate)
    : selection.poolSnapshot;
}

export function hasNoCapacityPoolCandidates(
  selection: TaskStartCapacityPoolSelection | null | undefined
): boolean {
  return !!selection && selection.candidates.length === 0;
}

export function capacityPoolNoCandidatesMessage(
  selection: Pick<TaskStartCapacityPoolSelection, 'scope'>
): string {
  return `No active compute pool offerings in the selected ${selection.scope} pool satisfy the requested resources.`;
}

export function capacityPoolNoCandidatesError(
  selection: Pick<TaskStartCapacityPoolSelection, 'scope'>
): Error & { permanent: true } {
  return Object.assign(new Error(capacityPoolNoCandidatesMessage(selection)), {
    permanent: true as const,
  });
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
    return selection.scope === 'project' ? undefined : capacityPoolSnapshotForPool(selection);
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

export function capacityPlacementSnapshotForCandidate(
  selection: Pick<
    TaskStartCapacityPoolSelection,
    'poolId' | 'scope' | 'revision' | 'strategy' | 'capacityPoolProjectId' | 'workloadRole'
  >,
  candidate: TaskStartCapacityCandidate
): CapacityPlacementSnapshot {
  return (
    candidate.snapshot ?? {
      capacityPoolId: selection.poolId,
      capacityPoolScope: selection.scope,
      capacityPoolRevision: selection.revision,
      capacitySourceId: candidate.capacitySourceId,
      capacityPoolCandidateId: candidate.id,
      placementCredentialSource: candidate.placementCredentialSource,
      placementCredentialReference: candidate.placementCredentialReference,
      placementCredentialVersion: candidate.placementCredentialVersion,
      capacityPoolProjectId: candidate.capacityPoolProjectId,
      workloadRole: candidate.workloadRole,
      providerInstanceType: candidate.providerInstanceType,
      providerInstanceVcpuCount: candidate.providerInstanceVcpuCount,
      providerInstanceMemoryMb: candidate.providerInstanceMemoryMb,
      providerInstanceDiskGb: candidate.providerInstanceDiskGb,
      providerInstancePriceDisplay: candidate.providerInstancePriceDisplay,
      providerInstancePriceCurrency: candidate.providerInstancePriceCurrency,
      providerInstancePriceMonthlyCents: candidate.providerInstancePriceMonthlyCents,
      providerInstancePriceHourlyMicros: candidate.providerInstancePriceHourlyMicros,
      placementExplanationJson: buildCapacityPlacementExplanation(selection, candidate),
    }
  );
}

export function buildCapacityPoolSelection(
  summary: CapacityPoolSummary,
  placement: TaskStartPlacement,
  workloadRole: CapacityWorkloadRole
): TaskStartCapacityPoolSelection | null {
  const pool = summary.pool;
  const sourceById = new Map(summary.sources.map((source) => [source.id, source]));
  const baseSelection: Omit<TaskStartCapacityPoolSelection, 'poolSnapshot' | 'candidates'> = {
    poolId: pool.id,
    scope: pool.scope,
    revision: pool.revision,
    strategy: pool.strategy,
    capacityPoolProjectId:
      pool.scope === 'project' ? (pool.ownerProjectId ?? placement.projectId) : null,
    workloadRole,
  };
  const poolSnapshot = capacityPoolSnapshotForPool(baseSelection);

  const candidates = summary.candidates
    .flatMap((candidate) => {
      const source = sourceById.get(candidate.capacitySourceId);
      if (!source) return [];
      const normalized = normalizeCapacityCandidate(
        pool,
        candidate,
        source,
        placement,
        workloadRole
      );
      return normalized ? [normalized] : [];
    })
    .sort((a, b) => compareCapacityCandidates(a, b, pool.strategy, placement.resolvedReservation));

  return {
    ...baseSelection,
    poolSnapshot,
    candidates,
  };
}

function normalizeCapacityCandidate(
  pool: CapacityPoolDto,
  candidate: CapacityPoolCandidateDto,
  source: CapacitySourceIdentity,
  placement: TaskStartPlacement,
  workloadRole: CapacityWorkloadRole
): TaskStartCapacityCandidate | null {
  if (!isActiveCapacityPlacementOption(pool, source, candidate)) return null;
  if (candidate.workloadRole !== workloadRole) return null;
  if (candidate.runtime && candidate.runtime !== placement.runtime.executionRuntime) return null;
  if (source.sourceKind !== 'cloud-provider-credential') return null;
  if (!candidate.provider || !isValidProvider(candidate.provider)) return null;
  if (!candidate.location || !isValidLocationForProvider(candidate.provider, candidate.location)) {
    return null;
  }
  const providerInstanceType = nonEmptyString(candidate.providerInstanceType);
  if (!providerInstanceType) return null;
  const providerInstanceVcpuCount = positiveInteger(candidate.providerInstanceVcpuCount);
  const providerInstanceMemoryMb = positiveInteger(candidate.providerInstanceMemoryMb);
  if (providerInstanceVcpuCount === null || providerInstanceMemoryMb === null) return null;
  const providerInstanceDiskGb = optionalPositiveInteger(candidate.providerInstanceDiskGb);
  if (
    !capacityCandidateSatisfiesReservation(
      {
        providerInstanceVcpuCount,
        providerInstanceMemoryMb,
        providerInstanceDiskGb,
      },
      placement.resolvedReservation
    )
  ) {
    return null;
  }
  // Keep the candidate aligned with the resolved placement: reject a candidate
  // whose provider differs from the resolved provider (credential/source may be
  // provider-specific), and reject a candidate whose location differs from an
  // explicitly requested vmLocation. When no location is explicitly requested,
  // preserve flexible location matching for the resolved provider.
  if (placement.provider && candidate.provider !== placement.provider) return null;
  if (placement.explicitVmLocation && candidate.location !== placement.vmLocation) return null;
  if (!isCredentialPlacementSource(source.credentialSource)) return null;

  const capacityPoolProjectId =
    pool.scope === 'project' ? (pool.ownerProjectId ?? placement.projectId) : null;
  const normalized: Omit<TaskStartCapacityCandidate, 'snapshot'> = {
    id: candidate.id,
    poolId: candidate.poolId,
    capacitySourceId: candidate.capacitySourceId,
    provider: candidate.provider,
    location: candidate.location as VMLocation,
    workloadRole: candidate.workloadRole,
    runtime: candidate.runtime,
    machineClass: candidate.machineClass,
    machineSize: normalizeLegacyVmSize(candidate.machineSize),
    providerInstanceType,
    providerInstanceVcpuCount,
    providerInstanceMemoryMb,
    providerInstanceDiskGb,
    providerInstancePriceDisplay: candidate.providerInstancePriceDisplay,
    providerInstancePriceCurrency: nonEmptyString(candidate.providerInstancePriceCurrency),
    providerInstancePriceMonthlyCents: nonNegativeInteger(
      candidate.providerInstancePriceMonthlyCents
    ),
    providerInstancePriceHourlyMicros: nonNegativeInteger(
      candidate.providerInstancePriceHourlyMicros
    ),
    priority: candidate.priority,
    candidateOrder: candidate.candidateOrder,
    credentialAttributionSource: source.credentialSource,
    placementCredentialSource: source.credentialSource,
    placementCredentialReference: source.credentialReference,
    placementCredentialVersion: source.credentialVersion,
    capacityPoolProjectId,
  };

  return {
    ...normalized,
    snapshot: {
      capacityPoolId: pool.id,
      capacityPoolScope: pool.scope,
      capacityPoolRevision: pool.revision,
      capacitySourceId: source.id,
      capacityPoolCandidateId: candidate.id,
      placementCredentialSource: source.credentialSource,
      placementCredentialReference: source.credentialReference,
      placementCredentialVersion: source.credentialVersion,
      capacityPoolProjectId,
      workloadRole: candidate.workloadRole,
      providerInstanceType,
      providerInstanceVcpuCount,
      providerInstanceMemoryMb,
      providerInstanceDiskGb,
      providerInstancePriceDisplay: candidate.providerInstancePriceDisplay,
      providerInstancePriceCurrency: nonEmptyString(candidate.providerInstancePriceCurrency),
      providerInstancePriceMonthlyCents: nonNegativeInteger(
        candidate.providerInstancePriceMonthlyCents
      ),
      providerInstancePriceHourlyMicros: nonNegativeInteger(
        candidate.providerInstancePriceHourlyMicros
      ),
      placementExplanationJson: buildCapacityPlacementExplanation(
        {
          poolId: pool.id,
          scope: pool.scope,
          revision: pool.revision,
          strategy: pool.strategy,
          capacityPoolProjectId,
          workloadRole,
        },
        normalized
      ),
    },
  };
}

function isActiveCapacityPlacementOption(
  pool: CapacityPoolDto,
  source: CapacitySourceIdentity,
  candidate: CapacityPoolCandidateDto
): boolean {
  return pool.status === 'active' && source.status === 'active' && candidate.status === 'active';
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
    if (!canSatisfyVmSize(node.vmSize, candidate.machineSize)) return false;
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
  return node.vmSize ? canSatisfyVmSize(node.vmSize, requestedVmSize) : false;
}

function compareCapacityCandidates(
  a: TaskStartCapacityCandidate,
  b: TaskStartCapacityCandidate,
  strategy: CapacityPoolStrategy,
  reservation: ResolvedResourceReservation
): number {
  const capacityDiff = compareOfferingCapacity(a, b);
  if (strategy === 'pack' && capacityDiff !== 0) return -capacityDiff;
  if (strategy === 'smallest-fit') {
    const fitDiff = compareOfferingFitSurplus(a, b, reservation);
    if (fitDiff !== 0) return fitDiff;
    const priceDiff = compareOfferingPrice(a, b);
    if (priceDiff !== 0) return priceDiff;
    if (capacityDiff !== 0) return capacityDiff;
  }
  if (a.priority !== b.priority) return a.priority - b.priority;
  const priceDiff = compareOfferingPrice(a, b);
  if (priceDiff !== 0) return priceDiff;
  if (strategy !== 'pack' && capacityDiff !== 0) return capacityDiff;
  if (a.candidateOrder !== b.candidateOrder) return a.candidateOrder - b.candidateOrder;
  return a.id.localeCompare(b.id);
}

function capacityCandidateSatisfiesReservation(
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

function compareOfferingCapacity(
  a: Pick<
    TaskStartCapacityCandidate,
    'providerInstanceVcpuCount' | 'providerInstanceMemoryMb' | 'providerInstanceDiskGb'
  >,
  b: Pick<
    TaskStartCapacityCandidate,
    'providerInstanceVcpuCount' | 'providerInstanceMemoryMb' | 'providerInstanceDiskGb'
  >
): number {
  const cpuDiff = a.providerInstanceVcpuCount - b.providerInstanceVcpuCount;
  if (cpuDiff !== 0) return cpuDiff;
  const memoryDiff = a.providerInstanceMemoryMb - b.providerInstanceMemoryMb;
  if (memoryDiff !== 0) return memoryDiff;
  return (a.providerInstanceDiskGb ?? 0) - (b.providerInstanceDiskGb ?? 0);
}

function compareOfferingFitSurplus(
  a: Pick<
    TaskStartCapacityCandidate,
    'providerInstanceVcpuCount' | 'providerInstanceMemoryMb' | 'providerInstanceDiskGb'
  >,
  b: Pick<
    TaskStartCapacityCandidate,
    'providerInstanceVcpuCount' | 'providerInstanceMemoryMb' | 'providerInstanceDiskGb'
  >,
  reservation: ResolvedResourceReservation
): number {
  return offeringFitSurplus(a, reservation) - offeringFitSurplus(b, reservation);
}

function offeringFitSurplus(
  candidate: Pick<
    TaskStartCapacityCandidate,
    'providerInstanceVcpuCount' | 'providerInstanceMemoryMb' | 'providerInstanceDiskGb'
  >,
  reservation: ResolvedResourceReservation
): number {
  const cpuBase = Math.max(1, reservation.cpuMillis);
  const memoryBase = Math.max(1, reservation.memoryMb);
  const diskBase = Math.max(1, reservation.diskMb);
  const cpuSurplus = Math.max(
    0,
    candidate.providerInstanceVcpuCount * 1000 - reservation.cpuMillis
  );
  const memorySurplus = Math.max(0, candidate.providerInstanceMemoryMb - reservation.memoryMb);
  const diskSurplus =
    candidate.providerInstanceDiskGb === null
      ? 0
      : Math.max(0, candidate.providerInstanceDiskGb * 1024 - reservation.diskMb);
  return cpuSurplus / cpuBase + memorySurplus / memoryBase + diskSurplus / diskBase;
}

function compareOfferingPrice(
  a: Pick<
    TaskStartCapacityCandidate,
    | 'providerInstancePriceCurrency'
    | 'providerInstancePriceMonthlyCents'
    | 'providerInstancePriceHourlyMicros'
  >,
  b: Pick<
    TaskStartCapacityCandidate,
    | 'providerInstancePriceCurrency'
    | 'providerInstancePriceMonthlyCents'
    | 'providerInstancePriceHourlyMicros'
  >
): number {
  const aPrice = comparablePriceMicros(a);
  const bPrice = comparablePriceMicros(b);
  if (aPrice === null && bPrice === null) return 0;
  if (aPrice === null) return 1;
  if (bPrice === null) return -1;
  if (aPrice.currency !== bPrice.currency) return 0;
  return aPrice.value - bPrice.value;
}

function comparablePriceMicros(
  candidate: Pick<
    TaskStartCapacityCandidate,
    | 'providerInstancePriceCurrency'
    | 'providerInstancePriceMonthlyCents'
    | 'providerInstancePriceHourlyMicros'
  >
): { currency: string; value: number } | null {
  const currency = nonEmptyString(candidate.providerInstancePriceCurrency);
  if (!currency) return null;
  const hourly = nonNegativeInteger(candidate.providerInstancePriceHourlyMicros);
  if (hourly !== null) return { currency, value: hourly };
  const monthly = nonNegativeInteger(candidate.providerInstancePriceMonthlyCents);
  if (monthly !== null) return { currency, value: monthly };
  return null;
}

function nonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function positiveInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function optionalPositiveInteger(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return positiveInteger(value);
}

function nonNegativeInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function normalizeLegacyVmSize(value: string | null): VMSize | null {
  switch (value) {
    case 'small':
    case 'medium':
    case 'large':
      return value;
    default:
      return null;
  }
}

function isCredentialPlacementSource(value: unknown): value is CredentialSource {
  return (
    isCapacityPlacementCredentialSource(value) &&
    (value === 'user' || value === 'project' || value === 'platform')
  );
}

function buildCapacityPlacementExplanation(
  selection: Pick<
    TaskStartCapacityPoolSelection,
    'poolId' | 'scope' | 'revision' | 'strategy' | 'capacityPoolProjectId' | 'workloadRole'
  >,
  candidate?: Pick<
    TaskStartCapacityCandidate,
    | 'id'
    | 'capacitySourceId'
    | 'provider'
    | 'location'
    | 'machineSize'
    | 'providerInstanceType'
    | 'providerInstanceVcpuCount'
    | 'providerInstanceMemoryMb'
    | 'providerInstanceDiskGb'
    | 'providerInstancePriceDisplay'
    | 'providerInstancePriceCurrency'
    | 'providerInstancePriceMonthlyCents'
    | 'providerInstancePriceHourlyMicros'
  >
): string {
  return JSON.stringify({
    kind: 'capacity_pool_default',
    poolId: selection.poolId,
    scope: selection.scope,
    revision: selection.revision,
    strategy: selection.strategy,
    capacityPoolProjectId: selection.capacityPoolProjectId,
    workloadRole: selection.workloadRole,
    capacitySourceId: candidate?.capacitySourceId ?? null,
    capacityPoolCandidateId: candidate?.id ?? null,
    provider: candidate?.provider ?? null,
    location: candidate?.location ?? null,
    machineSize: candidate?.machineSize ?? null,
    providerInstanceType: candidate?.providerInstanceType ?? null,
    providerInstanceVcpuCount: candidate?.providerInstanceVcpuCount ?? null,
    providerInstanceMemoryMb: candidate?.providerInstanceMemoryMb ?? null,
    providerInstanceDiskGb: candidate?.providerInstanceDiskGb ?? null,
    providerInstancePriceDisplay: candidate?.providerInstancePriceDisplay ?? null,
    providerInstancePriceCurrency: candidate?.providerInstancePriceCurrency ?? null,
    providerInstancePriceMonthlyCents: candidate?.providerInstancePriceMonthlyCents ?? null,
    providerInstancePriceHourlyMicros: candidate?.providerInstancePriceHourlyMicros ?? null,
    decidedAt: new Date().toISOString(),
  });
}
