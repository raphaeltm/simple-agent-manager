import type {
  CapacityPlacementSnapshot,
  CapacityPool as CapacityPoolDto,
  CapacityPoolCandidate as CapacityPoolCandidateDto,
  CapacityPoolPlacementSettings,
  CapacityPoolStrategy,
  CapacitySourceIdentity,
  CapacityWorkloadRole,
  CredentialSource,
  ResolvedResourceReservation,
  VMLocation,
} from '@simple-agent-manager/shared';
import {
  isCapacityPlacementCredentialSource,
  isValidLocationForProvider,
  isValidProvider,
  resolveApproximateBillingMonthHours,
} from '@simple-agent-manager/shared';

import { DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS } from './capacity-pool-placement-settings';
import type { CapacityPoolSummary } from './default-capacity-pools';
import {
  legacyReusableNodeMatches,
  normalizeLegacyPoolSize,
} from './legacy-node-pool-compatibility';
import type {
  CapacityAwareNodePlacementRow,
  TaskStartCapacityCandidate,
  TaskStartCapacityPoolSelection,
  TaskStartPlacement,
} from './placement-resolver-types';

const CAPACITY_PLACEMENT_PLAN_VERSION = 1;
const MAX_SCORE_WEIGHT = 1_000_000_000;

export function capacityPoolSnapshotForPool(
  selection: Pick<
    TaskStartCapacityPoolSelection,
    | 'poolId'
    | 'scope'
    | 'revision'
    | 'strategy'
    | 'exhaustionPolicy'
    | 'effectiveState'
    | 'selectionSettings'
    | 'capacityPoolProjectId'
    | 'workloadRole'
  >
): CapacityPlacementSnapshot {
  return {
    placementPlanVersion: CAPACITY_PLACEMENT_PLAN_VERSION,
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
    exhaustionPolicy: selection.exhaustionPolicy,
    effectivePoolState: selection.effectiveState,
    selectionSettingsVersion: selection.selectionSettings.sourceGeneration,
    sourceGeneration: selectionSourceGeneration(selection),
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
    | 'poolId'
    | 'scope'
    | 'revision'
    | 'strategy'
    | 'exhaustionPolicy'
    | 'effectiveState'
    | 'selectionSettings'
    | 'capacityPoolProjectId'
    | 'workloadRole'
  >,
  candidate: TaskStartCapacityCandidate
): CapacityPlacementSnapshot {
  return (
    candidate.snapshot ?? {
      placementPlanVersion: CAPACITY_PLACEMENT_PLAN_VERSION,
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
      exhaustionPolicy: selection.exhaustionPolicy,
      effectivePoolState: selection.effectiveState,
      selectionSettingsVersion: selection.selectionSettings.sourceGeneration,
      sourceGeneration: selectionSourceGeneration(selection, candidate),
      placementExplanationJson: buildCapacityPlacementExplanation(selection, candidate),
    }
  );
}

export function buildCapacityPoolSelection(
  summary: CapacityPoolSummary,
  placement: TaskStartPlacement,
  workloadRole: CapacityWorkloadRole,
  settings: CapacityPoolPlacementSettings = defaultPlacementSettings()
): TaskStartCapacityPoolSelection | null {
  const pool = summary.pool;
  const sourceById = new Map(summary.sources.map((source) => [source.id, source]));
  const baseSelection: Omit<TaskStartCapacityPoolSelection, 'poolSnapshot' | 'candidates'> = {
    poolId: pool.id,
    scope: pool.scope,
    revision: pool.revision,
    strategy: pool.strategy,
    exhaustionPolicy: pool.exhaustionPolicy,
    effectiveState: summary.effectiveState ?? 'configured-ready',
    selectionSettings: settings,
    capacityPoolProjectId:
      pool.scope === 'project' ? (pool.ownerProjectId ?? placement.projectId) : null,
    workloadRole,
  };
  const poolSnapshot = capacityPoolSnapshotForPool(baseSelection);

  const effectiveState = summary.effectiveState ?? 'configured-ready';
  const candidates =
    effectiveState === 'configured-ready'
      ? classifyCandidatePriceComparability(
          summary.candidates
    .flatMap((candidate) => {
      const source = sourceById.get(candidate.capacitySourceId);
      if (!source) return [];
      const normalized = normalizeCapacityCandidate(
        pool,
        candidate,
        source,
        placement,
        workloadRole,
        settings,
        effectiveState
      );
      return normalized ? [normalized] : [];
    })
        )
    .sort((a, b) =>
      compareCapacityCandidates(a, b, pool.strategy, placement.resolvedReservation, settings)
    )
      : [];

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
  workloadRole: CapacityWorkloadRole,
  settings: CapacityPoolPlacementSettings,
  effectiveState: TaskStartCapacityPoolSelection['effectiveState']
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
  const catalogAvailability =
    candidate.catalogAvailability === 'last-known-unavailable' ||
    candidate.providerInstanceCatalogSource === null
      ? 'last-known-unavailable'
      : 'available';
  if (catalogAvailability !== 'available') return null;
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
    machineSize: normalizeLegacyPoolSize(candidate.machineSize),
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
    priceComparability: 'unknown',
    catalogAvailability,
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
      placementPlanVersion: CAPACITY_PLACEMENT_PLAN_VERSION,
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
      exhaustionPolicy: pool.exhaustionPolicy,
      effectivePoolState: effectiveState,
      selectionSettingsVersion: settings.sourceGeneration,
      sourceGeneration: selectionSourceGeneration(
        {
          revision: pool.revision,
          selectionSettings: settings,
        },
        normalized
      ),
      placementExplanationJson: buildCapacityPlacementExplanation(
        {
          poolId: pool.id,
          scope: pool.scope,
          revision: pool.revision,
          strategy: pool.strategy,
          exhaustionPolicy: pool.exhaustionPolicy,
          effectiveState,
          selectionSettings: settings,
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

function compareCapacityCandidates(
  a: TaskStartCapacityCandidate,
  b: TaskStartCapacityCandidate,
  strategy: CapacityPoolStrategy,
  reservation: ResolvedResourceReservation,
  settings: CapacityPoolPlacementSettings = defaultPlacementSettings()
): number {
  const capacityDiff = compareOfferingCapacity(a, b);
  if (strategy === 'pack' && capacityDiff !== 0) return -capacityDiff;
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (strategy === 'smallest-fit') {
    const fitDiff = compareOfferingFitSurplus(a, b, reservation);
    if (fitDiff !== 0) return fitDiff;
    const priceDiff = compareOfferingPrice(a, b);
    if (priceDiff !== 0) return priceDiff;
    if (capacityDiff !== 0) return capacityDiff;
  }
  const weighted =
    weightedCandidateScore(a, strategy, reservation, settings) -
    weightedCandidateScore(b, strategy, reservation, settings);
  if (weighted !== 0) return weighted;
  const priceDiff = compareOfferingPrice(a, b);
  if (priceDiff !== 0) return priceDiff;
  if (strategy !== 'pack' && capacityDiff !== 0) return capacityDiff;
  if (a.candidateOrder !== b.candidateOrder) return a.candidateOrder - b.candidateOrder;
  return a.id.localeCompare(b.id);
}

function weightedCandidateScore(
  candidate: TaskStartCapacityCandidate,
  strategy: CapacityPoolStrategy,
  reservation: ResolvedResourceReservation,
  settings: CapacityPoolPlacementSettings
): number {
  const weights = settings.selectionWeights;
  const price = normalizedPriceScore(candidate);
  const fit = boundedScoreTerm(offeringFitSurplus(candidate, reservation));
  const capacity = compareOfferingCapacity(
    candidate,
    {
      providerInstanceVcpuCount: 0,
      providerInstanceMemoryMb: 0,
      providerInstanceDiskGb: 0,
    }
  );
  const capacityTerm = strategy === 'pack' ? -capacity : capacity;
  const score =
    price * boundedWeight(weights.price) +
    fit * boundedWeight(weights.fit) +
    boundedScoreTerm(capacityTerm) * boundedWeight(weights.capacity) +
    boundedScoreTerm(candidate.candidateOrder) * boundedWeight(weights.candidateOrder);
  return Number.isFinite(score) ? score : Number.MAX_SAFE_INTEGER;
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
  const aComparability = priceComparability(a);
  const bComparability = priceComparability(b);
  if (aComparability !== 'known' && bComparability !== 'known') return 0;
  if (aComparability !== 'known') return 1;
  if (bComparability !== 'known') return -1;
  const aPrice = comparablePriceMicros(a);
  const bPrice = comparablePriceMicros(b);
  if (aPrice === null && bPrice === null) return 0;
  if (aPrice === null) return 1;
  if (bPrice === null) return -1;
  if (aPrice.currency !== bPrice.currency) return 0;
  return aPrice.value - bPrice.value;
}

function classifyCandidatePriceComparability(
  candidates: TaskStartCapacityCandidate[]
): TaskStartCapacityCandidate[] {
  const pricedCurrencies = new Set(
    candidates.flatMap((candidate) => {
      const price = comparablePriceMicros(candidate);
      return price ? [price.currency] : [];
    })
  );
  const hasCurrencyMismatch = pricedCurrencies.size > 1;
  return candidates.map((candidate) => {
    const price = comparablePriceMicros(candidate);
    return {
      ...candidate,
      priceComparability: price ? (hasCurrencyMismatch ? 'currency-mismatch' : 'known') : 'unknown',
    };
  });
}

function priceComparability(
  candidate: Pick<
    TaskStartCapacityCandidate,
    | 'providerInstancePriceCurrency'
    | 'providerInstancePriceMonthlyCents'
    | 'providerInstancePriceHourlyMicros'
  >
): TaskStartCapacityCandidate['priceComparability'] {
  return 'priceComparability' in candidate &&
    (candidate.priceComparability === 'known' ||
      candidate.priceComparability === 'unknown' ||
      candidate.priceComparability === 'currency-mismatch')
    ? candidate.priceComparability
    : comparablePriceMicros(candidate)
      ? 'known'
      : 'unknown';
}

function normalizedPriceScore(candidate: TaskStartCapacityCandidate): number {
  if (candidate.priceComparability !== 'known') return 1_000_000;
  const price = comparablePriceMicros(candidate);
  if (!price) return 1_000_000;
  return Math.min(1_000_000, price.value / 1_000);
}

function boundedScoreTerm(value: number): number {
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER / MAX_SCORE_WEIGHT;
  return Math.max(-1_000_000_000, Math.min(1_000_000_000, value));
}

function boundedWeight(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, MAX_SCORE_WEIGHT);
}

function selectionSourceGeneration(
  selection: Pick<TaskStartCapacityPoolSelection, 'revision' | 'selectionSettings'>,
  candidate?: Pick<TaskStartCapacityCandidate, 'placementCredentialVersion'> | null
): number {
  return Math.max(
    selection.revision,
    selection.selectionSettings.sourceGeneration ?? selection.selectionSettings.version,
    candidate?.placementCredentialVersion ?? 0
  );
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
  if (monthly !== null) {
    return {
      currency,
      value: Math.round((monthly * 10_000) / resolveApproximateBillingMonthHours(null)),
    };
  }
  return null;
}

function defaultPlacementSettings(): CapacityPoolPlacementSettings {
  return {
    ...DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS,
    source: {
      legacyWorkloadMapping: 'default',
      selection: 'default',
    },
    diagnostics: [],
  };
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

function isCredentialPlacementSource(value: unknown): value is CredentialSource {
  return (
    isCapacityPlacementCredentialSource(value) &&
    (value === 'user' || value === 'project' || value === 'platform')
  );
}

function buildCapacityPlacementExplanation(
  selection: Pick<
    TaskStartCapacityPoolSelection,
    | 'poolId'
    | 'scope'
    | 'revision'
    | 'strategy'
    | 'exhaustionPolicy'
    | 'effectiveState'
    | 'selectionSettings'
    | 'capacityPoolProjectId'
    | 'workloadRole'
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
    placementPlanVersion: CAPACITY_PLACEMENT_PLAN_VERSION,
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
    exhaustionPolicy: selection.exhaustionPolicy,
    effectivePoolState: selection.effectiveState,
    selectionSettingsVersion: selection.selectionSettings.sourceGeneration,
    sourceGeneration: selectionSourceGeneration(selection, candidate),
    decidedAt: new Date().toISOString(),
  });
}
