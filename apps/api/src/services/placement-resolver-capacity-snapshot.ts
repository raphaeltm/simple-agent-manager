/** Placement snapshots and explanations persisted with a capacity-pool placement decision. */
import type { CapacityPlacementSnapshot } from '@simple-agent-manager/shared';

import { capacityPlacementAuthorityGeneration } from './capacity-pool-authority';
import { DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS } from './capacity-pool-placement-settings';
import type {
  TaskStartCapacityCandidate,
  TaskStartCapacityPoolSelection,
  TaskStartPlacement,
} from './placement-resolver-types';

export const CAPACITY_PLACEMENT_PLAN_VERSION = 1;

export function capacityPoolSnapshotForPool(
  selection: Pick<
    TaskStartCapacityPoolSelection,
    | 'poolId'
    | 'scope'
    | 'revision'
    | 'strategy'
    | 'explicitVmLocation'
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

/** Persist placement provenance even when no compute pool applies. */
export function directPlacementAuditSnapshot(
  placement: Pick<TaskStartPlacement, 'explicitVmLocation'>
): CapacityPlacementSnapshot {
  return {
    placementPlanVersion: CAPACITY_PLACEMENT_PLAN_VERSION,
    capacityPoolId: null,
    capacityPoolScope: null,
    capacityPoolRevision: null,
    capacitySourceId: null,
    capacitySourceGeneration: null,
    capacitySourceExternalRef: null,
    capacityPoolCandidateId: null,
    placementCredentialSource: null,
    placementCredentialReference: null,
    placementCredentialVersion: null,
    capacityPoolProjectId: null,
    workloadRole: null,
    placementExplanationJson: JSON.stringify({
      kind: 'direct_placement',
      explicitVmLocation: placement.explicitVmLocation === true,
    }),
  };
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
      providerInstanceBootDiskSizeGb: candidate.providerInstanceBootDiskSizeGb ?? null,
      providerInstanceImage: candidate.providerInstanceImage ?? null,
      providerInstanceArchitecture: candidate.providerInstanceArchitecture ?? null,
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

export function buildCapacityPlacementExplanation(
  selection: Pick<
    TaskStartCapacityPoolSelection,
    | 'poolId'
    | 'scope'
    | 'revision'
    | 'strategy'
    | 'explicitVmLocation'
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
    explicitVmLocation: selection.explicitVmLocation === true,
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
