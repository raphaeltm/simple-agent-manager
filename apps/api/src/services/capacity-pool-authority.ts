import type {
  CapacityCredentialSource,
  CapacityPoolScope,
  CapacityPoolStatus,
  CapacitySourceKind,
  CapacityWorkloadRole,
  CredentialProvider,
  ProviderInstanceCatalogSource,
  VMSize,
} from '@simple-agent-manager/shared';

export const UNKNOWN_CAPACITY_AUTHORITY_GENERATION = 0;

export interface CapacitySourceAuthorityInput {
  id: string;
  scope: CapacityPoolScope;
  ownerUserId: string | null;
  ownerProjectId: string | null;
  sourceKind: CapacitySourceKind;
  provider: CredentialProvider | string | null;
  credentialSource: CapacityCredentialSource | null;
  credentialId: string | null;
  platformCredentialId: string | null;
  credentialReference: string | null;
  credentialVersion: number | null;
  credentialContentFingerprint?: string | null;
  externalSourceRef: string | null;
  status: CapacityPoolStatus;
}

export interface CapacityCandidateAuthorityInput {
  sourceAuthorityGeneration: number;
  id: string;
  poolId: string;
  capacitySourceId: string;
  provider: CredentialProvider | string | null;
  location: string | null;
  workloadRole: CapacityWorkloadRole | string;
  runtime: string | null;
  machineClass: string | null;
  machineSize: VMSize | string | null;
  providerInstanceType: string | null;
  providerInstanceSku?: string | null;
  providerInstanceVcpuCount: number | null;
  providerInstanceMemoryMb: number | null;
  providerInstanceDiskGb: number | null;
  providerInstanceBootDiskSizeGb?: number | null;
  providerInstanceImage?: string | null;
  providerInstanceArchitecture?: string | null;
  /**
   * Price fields are part of candidate authority because compareCapacityCandidates ranks on
   * them: a price-only catalog change reorders selection, so a plan authorized against the
   * old prices must not stay authoritative.
   */
  providerInstancePriceCurrency?: string | null;
  providerInstancePriceMonthlyCents?: number | null;
  providerInstancePriceHourlyMicros?: number | null;
  providerInstanceCatalogSource?: ProviderInstanceCatalogSource | string | null;
  catalogAvailability?: 'available' | 'last-known-unavailable' | string | null;
  status: CapacityPoolStatus | string;
}

export interface CapacityPlacementAuthorityInput {
  poolRevision: number | null | undefined;
  selectionSettingsGeneration: number | null | undefined;
  sourceAuthorityGeneration: number | null | undefined;
  candidateAuthorityGeneration: number | null | undefined;
}

export function capacitySourceAuthorityGeneration(input: CapacitySourceAuthorityInput): number {
  return stablePositiveHash([
    'capacity-source-authority:v1',
    input.id,
    input.scope,
    input.ownerUserId,
    input.ownerProjectId,
    input.sourceKind,
    input.provider,
    input.credentialSource,
    input.credentialId,
    input.platformCredentialId,
    input.credentialReference,
    input.credentialVersion,
    input.credentialContentFingerprint ?? null,
    input.externalSourceRef,
    input.status,
  ]);
}

export function capacityCandidateAuthorityGeneration(
  input: CapacityCandidateAuthorityInput
): number {
  return stablePositiveHash([
    'capacity-candidate-authority:v2',
    normalizeCapacityAuthorityGeneration(input.sourceAuthorityGeneration),
    input.id,
    input.poolId,
    input.capacitySourceId,
    input.provider,
    input.location,
    input.workloadRole,
    input.runtime,
    input.machineClass,
    input.machineSize,
    input.providerInstanceType,
    input.providerInstanceSku ?? null,
    input.providerInstanceVcpuCount,
    input.providerInstanceMemoryMb,
    input.providerInstanceDiskGb,
    input.providerInstanceBootDiskSizeGb ?? null,
    input.providerInstanceImage ?? null,
    input.providerInstanceArchitecture ?? null,
    input.providerInstancePriceCurrency ?? null,
    input.providerInstancePriceMonthlyCents ?? null,
    input.providerInstancePriceHourlyMicros ?? null,
    input.providerInstanceCatalogSource ?? null,
    input.catalogAvailability ?? null,
    input.status,
  ]);
}

export function capacityPlacementAuthorityGeneration(
  input: CapacityPlacementAuthorityInput
): number {
  return stablePositiveHash([
    'capacity-placement-authority:v1',
    normalizeCapacityAuthorityGeneration(input.poolRevision),
    normalizeCapacityAuthorityGeneration(input.selectionSettingsGeneration),
    normalizeCapacityAuthorityGeneration(input.sourceAuthorityGeneration),
    normalizeCapacityAuthorityGeneration(input.candidateAuthorityGeneration),
  ]);
}

export function normalizeCapacityAuthorityGeneration(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : UNKNOWN_CAPACITY_AUTHORITY_GENERATION;
}

function stablePositiveHash(parts: readonly unknown[]): number {
  const value = JSON.stringify(parts);
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 1;
}
