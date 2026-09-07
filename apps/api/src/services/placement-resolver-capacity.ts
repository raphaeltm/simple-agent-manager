import type {
  CapacityPlacementSnapshot,
  CapacityPool as CapacityPoolDto,
  CapacityPoolCandidate as CapacityPoolCandidateDto,
  CapacityPoolPlacementSettings,
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
} from '@simple-agent-manager/shared';

import {
  capacityPlacementAuthorityGeneration,
  normalizeCapacityAuthorityGeneration,
} from './capacity-pool-authority';
import { DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS } from './capacity-pool-placement-settings';
import { timestampVersion } from './default-capacity-pool-helpers';
import type { CapacityPoolSummary } from './default-capacity-pools';
import {
  legacyReusableNodeMatches,
  normalizeLegacyPoolSize,
} from './legacy-node-pool-compatibility';
import { capacityCandidateWorkloadRoleEligible } from './placement-authority';
import {
  classifyCandidatePriceComparability,
  compareCapacityCandidates,
  defaultPlacementSettings,
  nonEmptyString,
  nonNegativeInteger,
} from './placement-capacity-ranking';
import type {
  CapacityAwareNodePlacementRow,
  TaskStartCapacityCandidate,
  TaskStartCapacityPoolSelection,
  TaskStartPlacement,
} from './placement-resolver-types';
import { resolvePlacementRollout } from './placement-rollout';

export {
  rankCapacityCandidatesForRuntime,
  type RankCapacityCandidatesInput,
} from './placement-capacity-ranking';

const CAPACITY_PLACEMENT_PLAN_VERSION = 1;

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
    | 'rollout'
  >
): CapacityPlacementSnapshot {
  const authorityGeneration = selectionCapacityAuthorityGeneration(selection);
  return {
    placementPlanVersion: CAPACITY_PLACEMENT_PLAN_VERSION,
    capacityPoolId: selection.poolId,
    capacityPoolScope: selection.scope,
    capacityPoolRevision: selection.revision,
    capacitySourceId: null,
    capacitySourceGeneration: null,
    capacitySourceExternalRef: null,
    capacityPoolCandidateId: null,
    placementCredentialSource: null,
    placementCredentialReference: null,
    placementCredentialVersion: null,
    capacityPoolProjectId: selection.capacityPoolProjectId,
    workloadRole: selection.workloadRole,
    exhaustionPolicy: selection.exhaustionPolicy,
    effectivePoolState: selection.effectiveState,
    selectionSettingsVersion: (
      selection.selectionSettings ?? DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS
    ).sourceGeneration,
    capacityAuthorityGeneration: authorityGeneration,
    sourceGeneration: authorityGeneration,
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
    | 'rollout'
  >,
  candidate: TaskStartCapacityCandidate
): CapacityPlacementSnapshot {
  const authorityGeneration =
    candidate.capacityAuthorityGeneration ??
    selectionCapacityAuthorityGeneration(selection, candidate);
  return (
    candidate.snapshot ?? {
      placementPlanVersion: CAPACITY_PLACEMENT_PLAN_VERSION,
      capacityPoolId: selection.poolId,
      capacityPoolScope: selection.scope,
      capacityPoolRevision: selection.revision,
      capacitySourceId: candidate.capacitySourceId,
      capacitySourceGeneration: candidate.capacitySourceGeneration,
      capacitySourceExternalRef: candidate.capacitySourceExternalRef,
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
      selectionSettingsVersion: (
        selection.selectionSettings ?? DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS
      ).sourceGeneration,
      capacityAuthorityGeneration: authorityGeneration,
      sourceGeneration: authorityGeneration,
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
  const rollout = resolvePlacementRollout({
    userId: placement.userId,
    poolId: pool.id,
    strategy: pool.strategy,
    cohortPercent: settings.rolloutCohortPercent,
  });
  const sourceById = new Map(summary.sources.map((source) => [source.id, source]));
  const baseSelection: Omit<TaskStartCapacityPoolSelection, 'poolSnapshot' | 'candidates'> = {
    rollout,
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
          summary.candidates.flatMap((candidate) => {
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
        ).sort((a, b) =>
          compareCapacityCandidates(
            a,
            b,
            rollout.appliedStrategy,
            placement.resolvedReservation,
            settings
          )
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
  if (!capacityCandidateWorkloadRoleEligible(candidate.workloadRole, workloadRole)) return null;
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
  const sourceAuthorityGeneration = normalizeCapacityAuthorityGeneration(
    source.authorityGeneration
  );
  // Refresh epochs fence catalog writers; only semantic authority changes invalidate placement.
  const capacitySourceGeneration =
    sourceAuthorityGeneration || timestampVersion(source.updatedAt ?? source.createdAt);
  const candidateAuthorityGeneration = normalizeCapacityAuthorityGeneration(
    candidate.authorityGeneration
  );
  const authorityGeneration = capacityPlacementAuthorityGeneration({
    poolRevision: pool.revision,
    selectionSettingsGeneration: settings.sourceGeneration,
    sourceAuthorityGeneration,
    candidateAuthorityGeneration,
  });
  const normalized: Omit<TaskStartCapacityCandidate, 'snapshot'> = {
    id: candidate.id,
    poolId: candidate.poolId,
    capacitySourceId: candidate.capacitySourceId,
    capacitySourceGeneration,
    capacitySourceExternalRef: source.externalSourceRef,
    provider: candidate.provider,
    location: candidate.location as VMLocation,
    workloadRole,
    runtime: candidate.runtime,
    machineClass: candidate.machineClass,
    machineSize: normalizeLegacyPoolSize(candidate.machineSize),
    providerInstanceType,
    providerInstanceVcpuCount,
    providerInstanceMemoryMb,
    providerInstanceDiskGb,
    providerInstanceBootDiskSizeGb: optionalPositiveInteger(
      candidate.providerInstanceBootDiskSizeGb
    ),
    providerInstanceImage: candidate.providerInstanceImage,
    providerInstanceArchitecture: candidate.providerInstanceArchitecture,
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
    sourceAuthorityGeneration,
    candidateAuthorityGeneration,
    capacityAuthorityGeneration: authorityGeneration,
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
      capacitySourceGeneration,
      capacitySourceExternalRef: source.externalSourceRef,
      capacityPoolCandidateId: candidate.id,
      placementCredentialSource: source.credentialSource,
      placementCredentialReference: source.credentialReference,
      placementCredentialVersion: source.credentialVersion,
      capacityPoolProjectId,
      workloadRole,
      providerInstanceType,
      providerInstanceVcpuCount,
      providerInstanceMemoryMb,
      providerInstanceDiskGb,
      providerInstanceBootDiskSizeGb: optionalPositiveInteger(
        candidate.providerInstanceBootDiskSizeGb
      ),
      providerInstanceImage: candidate.providerInstanceImage,
      providerInstanceArchitecture: candidate.providerInstanceArchitecture,
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
      capacityAuthorityGeneration: authorityGeneration,
      sourceGeneration: authorityGeneration,
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

function selectionCapacityAuthorityGeneration(
  selection: Pick<TaskStartCapacityPoolSelection, 'revision' | 'selectionSettings'>,
  candidate?: Pick<
    TaskStartCapacityCandidate,
    'sourceAuthorityGeneration' | 'candidateAuthorityGeneration'
  > | null
): number {
  return capacityPlacementAuthorityGeneration({
    poolRevision: selection.revision,
    selectionSettingsGeneration:
      (selection.selectionSettings ?? DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS).sourceGeneration ??
      (selection.selectionSettings ?? DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS).version,
    sourceAuthorityGeneration: candidate?.sourceAuthorityGeneration ?? 0,
    candidateAuthorityGeneration: candidate?.candidateAuthorityGeneration ?? 0,
  });
}

function positiveInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function optionalPositiveInteger(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return positiveInteger(value);
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
    | 'rollout'
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
    | 'placementCredentialVersion'
    | 'sourceAuthorityGeneration'
    | 'candidateAuthorityGeneration'
    | 'capacityAuthorityGeneration'
  >
): string {
  const authorityGeneration =
    candidate?.capacityAuthorityGeneration ??
    selectionCapacityAuthorityGeneration(selection, candidate);
  return JSON.stringify({
    kind: 'capacity_pool_default',
    rollout: selection.rollout,
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
    selectionSettingsVersion: (
      selection.selectionSettings ?? DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS
    ).sourceGeneration,
    sourceAuthorityGeneration: candidate?.sourceAuthorityGeneration ?? null,
    candidateAuthorityGeneration: candidate?.candidateAuthorityGeneration ?? null,
    capacityAuthorityGeneration: authorityGeneration,
    sourceGeneration: authorityGeneration,
    decidedAt: new Date().toISOString(),
  });
}
