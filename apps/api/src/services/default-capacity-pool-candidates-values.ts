import { getProviderInstanceOfferings } from '@simple-agent-manager/providers';
import type {
  CapacityPoolStatus,
  CapacityWorkloadRole,
  CredentialProvider,
  ProviderInstanceOffering,
  VMSize,
} from '@simple-agent-manager/shared';
import { isCapacityPoolStatus } from '@simple-agent-manager/shared';

import type * as schema from '../db/schema';
import { capacityCandidateAuthorityGeneration } from './capacity-pool-authority';
import {
  capacityCandidateIdForRole,
  PRIMARY_CAPACITY_WORKLOAD_ROLE,
} from './capacity-pool-workload-roles';
import { type providerInstanceOfferingDbValues } from './default-capacity-pool-candidate-values';
import {
  ACTIVE_STATUS,
  DEFAULT_MACHINE_CLASS,
  DEFAULT_RUNTIME,
  DELETED_STATUS,
  DISABLED_STATUS,
  type ExistingCandidateRecord,
} from './default-capacity-pool-candidates-common';
import { legacyDefaultCandidateId } from './default-capacity-pool-helpers';

export function candidateValueForOffering(input: {
  id: string;
  poolId: string;
  sourceId: string;
  provider: CredentialProvider;
  offering: ProviderInstanceOffering;
  role: CapacityWorkloadRole;
  legacyVmSize: VMSize | null;
  status: CapacityPoolStatus;
  providerValues: ReturnType<typeof providerInstanceOfferingDbValues>;
  persisted: ExistingCandidateRecord | undefined;
  candidateOrder: number;
  now: string;
  sourceGeneration: number | undefined;
  sourceAuthorityGeneration: number | undefined;
}): schema.NewCapacityPoolCandidate {
  // Provider catalogs do not carry boot disk / image / architecture; they are explicit
  // operator configuration. A refresh must therefore PRESERVE what is persisted instead of
  // publishing NULL over it (which also kept flipping the candidate authority generation).
  const providerInstanceBootDiskSizeGb = input.persisted?.providerInstanceBootDiskSizeGb ?? null;
  const providerInstanceImage = input.persisted?.providerInstanceImage ?? null;
  const providerInstanceArchitecture = input.persisted?.providerInstanceArchitecture ?? null;

  return {
    id: input.id,
    poolId: input.poolId,
    capacitySourceId: input.sourceId,
    provider: input.provider,
    location: input.offering.location,
    workloadRole: input.role,
    runtime: DEFAULT_RUNTIME,
    machineClass: DEFAULT_MACHINE_CLASS,
    machineSize: input.legacyVmSize,
    ...input.providerValues,
    providerInstanceBootDiskSizeGb,
    providerInstanceImage,
    providerInstanceArchitecture,
    catalogAvailability: 'available',
    catalogUnavailableAt: null,
    catalogReturnedAt: input.now,
    catalogGeneration: input.sourceGeneration ?? 0,
    authorityGeneration: capacityCandidateAuthorityGeneration({
      sourceAuthorityGeneration: input.sourceAuthorityGeneration ?? 0,
      id: input.id,
      poolId: input.poolId,
      capacitySourceId: input.sourceId,
      provider: input.provider,
      location: input.offering.location,
      workloadRole: input.role,
      runtime: DEFAULT_RUNTIME,
      machineClass: DEFAULT_MACHINE_CLASS,
      machineSize: input.legacyVmSize,
      providerInstanceType: input.providerValues.providerInstanceType ?? null,
      providerInstanceSku: input.providerValues.providerInstanceSku ?? null,
      providerInstanceVcpuCount: input.providerValues.providerInstanceVcpuCount ?? null,
      providerInstanceMemoryMb: input.providerValues.providerInstanceMemoryMb ?? null,
      providerInstanceDiskGb: input.providerValues.providerInstanceDiskGb ?? null,
      providerInstanceBootDiskSizeGb,
      providerInstanceImage,
      providerInstanceArchitecture,
      providerInstancePriceCurrency: input.providerValues.providerInstancePriceCurrency ?? null,
      providerInstancePriceMonthlyCents:
        input.providerValues.providerInstancePriceMonthlyCents ?? null,
      providerInstancePriceHourlyMicros:
        input.providerValues.providerInstancePriceHourlyMicros ?? null,
      providerInstanceCatalogSource: input.providerValues.providerInstanceCatalogSource,
      catalogAvailability: 'available',
      status: input.status,
    }),
    priority: input.candidateOrder,
    candidateOrder: input.candidateOrder,
    status: input.status,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function isCurrentlySelectableOffering(offering: ProviderInstanceOffering): boolean {
  return offering.available !== false && !offering.stale;
}

/**
 * Default pools discover the full provider-native catalog, but first creation only
 * selects concrete offerings that map to SAM's legacy supported sizes.
 *
 * Status priority:
 * 1. Existing concrete row status: explicit user additions/removals win.
 * 2. Legacy small/medium/large migration status: preserves old removals.
 * 3. Legacy metadata match: old supported concrete SKU starts active.
 * 4. New non-legacy catalog row: visible in editor, disabled for placement.
 */
export function initialStatusForProviderOffering(
  existingConcreteStatus: string | null | undefined,
  legacyMigrationStatus: string | null | undefined,
  legacyVmSize: VMSize | null
): CapacityPoolStatus {
  const concreteStatus = normalizeCapacityPoolStatus(existingConcreteStatus);
  if (concreteStatus) return concreteStatus;

  const legacyStatus = normalizeCapacityPoolStatus(legacyMigrationStatus);
  if (legacyStatus === DISABLED_STATUS || legacyStatus === DELETED_STATUS) return legacyStatus;
  if (legacyStatus === ACTIVE_STATUS) return ACTIVE_STATUS;

  return legacyVmSize ? ACTIVE_STATUS : DISABLED_STATUS;
}

export function normalizeCapacityPoolStatus(
  value: string | null | undefined
): CapacityPoolStatus | null {
  return isCapacityPoolStatus(value) ? value : null;
}

export function legacyStatusForOffering(
  existingStatuses: ReadonlyMap<string, string>,
  poolId: string,
  sourceId: string,
  provider: CredentialProvider,
  offering: ProviderInstanceOffering,
  legacyVmSize: VMSize | null
): string | null {
  if (!legacyVmSize) return null;
  return (
    existingStatuses.get(
      capacityCandidateIdForRole(
        legacyDefaultCandidateId(poolId, sourceId, provider, offering.location, legacyVmSize),
        PRIMARY_CAPACITY_WORKLOAD_ROLE
      )
    ) ?? null
  );
}

export function legacyVmSizeHintForOffering(
  provider: CredentialProvider,
  offering: ProviderInstanceOffering
): VMSize | null {
  if (isLegacyVmSize(offering.machineSize)) return offering.machineSize;

  const staticMatch = getProviderInstanceOfferings(provider).find(
    (legacyOffering) =>
      legacyOffering.instanceType === offering.providerInstanceType ||
      (legacyOffering.instanceSku !== null &&
        legacyOffering.instanceSku === offering.providerInstanceSku)
  );
  return staticMatch?.legacyVmSize ?? null;
}

export function isLegacyVmSize(value: unknown): value is VMSize {
  return value === 'small' || value === 'medium' || value === 'large';
}
