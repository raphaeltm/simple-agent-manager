import type {
  CapacityPool as CapacityPoolDto,
  CapacityPoolCandidate as CapacityPoolCandidateDto,
  CapacityPoolPlacementSettings,
  CapacitySourceIdentity,
  CapacityWorkloadRole,
  CredentialSource,
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
import { timestampVersion } from './default-capacity-pool-helpers';
import type { CapacityPoolSummary } from './default-capacity-pools';
import { normalizeLegacyPoolSize } from './legacy-node-pool-compatibility';
import { capacityCandidateWorkloadRoleEligible } from './placement-authority';
import {
  classifyCandidatePriceComparability,
  compareCapacityCandidates,
  defaultPlacementSettings,
  nonEmptyString,
  nonNegativeInteger,
} from './placement-capacity-ranking';
import {
  capacityCandidateSatisfiesReservation,
  optionalPositiveInteger,
  positiveInteger,
} from './placement-resolver-capacity-reuse';
import {
  buildCapacityPlacementExplanation,
  CAPACITY_PLACEMENT_PLAN_VERSION,
  capacityPoolSnapshotForPool,
} from './placement-resolver-capacity-snapshot';
import type {
  TaskStartCapacityCandidate,
  TaskStartCapacityPoolSelection,
  TaskStartPlacement,
} from './placement-resolver-types';
import { resolvePlacementRollout } from './placement-rollout';
import { DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB } from './workspace-resource-capacity';

export {
  rankCapacityCandidatesForRuntime,
  type RankCapacityCandidatesInput,
} from './placement-capacity-ranking';
export {
  hasNoCapacityPoolCandidates,
  resolveReusableNodeCapacitySnapshot,
} from './placement-resolver-capacity-reuse';
export {
  capacityPlacementSnapshotForCandidate,
  capacityPlacementSnapshotForTaskStart,
  capacityPoolSnapshotForPool,
  directPlacementAuditSnapshot,
} from './placement-resolver-capacity-snapshot';

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

export function buildCapacityPoolSelection(
  summary: CapacityPoolSummary,
  placement: TaskStartPlacement,
  workloadRole: CapacityWorkloadRole,
  settings: CapacityPoolPlacementSettings = defaultPlacementSettings(),
  hostMemoryReserveMb = DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB
): TaskStartCapacityPoolSelection | null {
  const pool = summary.pool;
  const strategy = workloadRole === 'deployment' ? pool.deploymentStrategy : pool.strategy;
  const rollout = resolvePlacementRollout({
    userId: placement.userId,
    poolId: pool.id,
    strategy,
    cohortPercent: settings.rolloutCohortPercent,
  });
  const sourceById = new Map(summary.sources.map((source) => [source.id, source]));
  const baseSelection: Omit<TaskStartCapacityPoolSelection, 'poolSnapshot' | 'candidates'> = {
    rollout,
    poolId: pool.id,
    scope: pool.scope,
    revision: pool.revision,
    strategy,
    exhaustionPolicy: pool.exhaustionPolicy,
    maxNodes: pool.maxNodes,
    explicitVmLocation: placement.explicitVmLocation === true,
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
              effectiveState,
              hostMemoryReserveMb
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
  effectiveState: TaskStartCapacityPoolSelection['effectiveState'],
  hostMemoryReserveMb: number
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
  // Provision only hardware that can pass the final workload reservation.
  // Provider memory includes the host reserve; workload memory does not.
  if (providerInstanceMemoryMb - hostMemoryReserveMb < placement.resolvedReservation.memoryMb) {
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
          strategy: workloadRole === 'deployment' ? pool.deploymentStrategy : pool.strategy,
          explicitVmLocation: placement.explicitVmLocation === true,
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

function isCredentialPlacementSource(value: unknown): value is CredentialSource {
  return (
    isCapacityPlacementCredentialSource(value) &&
    (value === 'user' || value === 'project' || value === 'platform')
  );
}
