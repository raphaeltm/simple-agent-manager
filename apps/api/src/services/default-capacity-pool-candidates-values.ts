import { getProviderInstanceOfferings } from '@simple-agent-manager/providers';
import {
  capacityCandidateAuthorityGeneration,
} from '@simple-agent-manager/scheduler-core';
import type {
  CapacityPoolStatus,
  CapacityWorkloadRole,
  CredentialProvider,
  ProviderInstanceOffering,
  VMSize,
} from '@simple-agent-manager/shared';
import { isCapacityPoolStatus, providerLocationRegion } from '@simple-agent-manager/shared';

import type * as schema from '../db/schema';
import { type providerInstanceOfferingDbValues } from './default-capacity-pool-candidate-values';
import {
  ACTIVE_STATUS,
  DEFAULT_MACHINE_CLASS,
  DEFAULT_RUNTIME,
  DISABLED_STATUS,
  type ExistingCandidateRecord,
} from './default-capacity-pool-candidates-common';

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
 * Status for a pool row the pool has never had. Nothing joins a pool on its own: a newly
 * connected account, a new machine type and a new region all start unselected.
 *
 * 1. An existing row keeps its status: a person's additions and removals win.
 * 2. A new zone of a region the person picked joins it, because people pick regions and SAM
 *    places into any zone of a picked region (`providerLocationRegion`). Only an ACTIVE row of
 *    the same account, machine type and region counts; a removed or never-picked region stays out.
 * 3. Anything else starts `disabled`: listed in the editor, never placed.
 *
 * Legacy `small`/`medium`/`large` hints deliberately play no part. They used to switch new rows
 * on, which re-added machines and regions on every catalog refresh (2026-11-09).
 */
export function initialStatusForProviderOffering(
  existingConcreteStatus: string | null | undefined,
  pickedRegion: boolean
): CapacityPoolStatus {
  const concreteStatus = normalizeCapacityPoolStatus(existingConcreteStatus);
  if (concreteStatus) return concreteStatus;
  return pickedRegion ? ACTIVE_STATUS : DISABLED_STATUS;
}

export function normalizeCapacityPoolStatus(
  value: string | null | undefined
): CapacityPoolStatus | null {
  return isCapacityPoolStatus(value) ? value : null;
}

/** Key for "this machine type in this region" within one pool source. */
export function offeringRegionKey(
  provider: CredentialProvider,
  location: string,
  providerInstanceType: string | null,
  providerInstanceSku: string | null
): string | null {
  if (!providerInstanceType) return null;
  return JSON.stringify([
    providerLocationRegion(provider, location),
    providerInstanceType,
    providerInstanceSku ?? null,
  ]);
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
