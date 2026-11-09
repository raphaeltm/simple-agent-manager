import type {
  CapacityCredentialSource,
  CapacityExhaustionPolicy,
  CapacityPlacementCredentialSource,
  CapacityPlacementSnapshot,
  CapacityPool as CapacityPoolDto,
  CapacityPoolCandidate as CapacityPoolCandidateDto,
  CapacityPoolConfigurationState,
  CapacityPoolScope,
  CapacityPoolStatus,
  CapacityPoolStrategy,
  CapacitySourceIdentity,
  CapacitySourceKind,
  CapacityWorkloadRole,
} from '@simple-agent-manager/shared';
import {
  isCapacityCredentialSource,
  isCapacityExhaustionPolicy,
  isCapacityPlacementCredentialSource,
  isCapacityPoolConfigurationState,
  isCapacityPoolScope,
  isCapacityPoolStatus,
  isCapacityPoolStrategy,
  isCapacitySourceKind,
  isCapacityWorkloadRole,
  isProviderInstanceCatalogSource,
} from '@simple-agent-manager/shared';

import type * as schema from '../db/schema';
import { log } from '../lib/logger';

type StringGuard<T extends string> = (value: unknown) => value is T;

function expectPersistedValue<T extends string>(
  field: string,
  value: string,
  guard: StringGuard<T>
): T {
  if (guard(value)) return value;
  throw new Error(`Invalid persisted ${field}: ${value}`);
}

function nullablePersistedValue<T extends string>(
  field: string,
  value: string | null,
  guard: StringGuard<T>
): T | null {
  if (value === null) return null;
  return expectPersistedValue(field, value, guard);
}

export function toCapacitySourceIdentity(row: schema.CapacitySource): CapacitySourceIdentity {
  return {
    id: row.id,
    scope: expectPersistedValue<CapacityPoolScope>(
      'capacity_sources.scope',
      row.scope,
      isCapacityPoolScope
    ),
    ownerUserId: row.ownerUserId,
    ownerProjectId: row.ownerProjectId,
    sourceKind: expectPersistedValue<CapacitySourceKind>(
      'capacity_sources.source_kind',
      row.sourceKind,
      isCapacitySourceKind
    ),
    provider: row.provider,
    credentialSource: nullablePersistedValue<CapacityCredentialSource>(
      'capacity_sources.credential_source',
      row.credentialSource,
      isCapacityCredentialSource
    ),
    credentialId: row.credentialId,
    platformCredentialId: row.platformCredentialId,
    credentialReference: row.credentialReference,
    credentialVersion: row.credentialVersion,
    externalSourceRef: row.externalSourceRef,
    authorityGeneration: row.authorityGeneration,
    status: expectPersistedValue<CapacityPoolStatus>(
      'capacity_sources.status',
      row.status,
      isCapacityPoolStatus
    ),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toCapacityPool(row: schema.CapacityPool): CapacityPoolDto {
  return {
    id: row.id,
    scope: expectPersistedValue<CapacityPoolScope>(
      'capacity_pools.scope',
      row.scope,
      isCapacityPoolScope
    ),
    ownerUserId: row.ownerUserId,
    ownerProjectId: row.ownerProjectId,
    name: row.name,
    isDefault: row.isDefault,
    revision: row.revision,
    status: expectPersistedValue<CapacityPoolStatus>(
      'capacity_pools.status',
      row.status,
      isCapacityPoolStatus
    ),
    configurationState: expectPersistedValue<CapacityPoolConfigurationState>(
      'capacity_pools.configuration_state',
      row.configurationState,
      isCapacityPoolConfigurationState
    ),
    strategy: expectPersistedValue<CapacityPoolStrategy>(
      'capacity_pools.strategy',
      row.strategy,
      isCapacityPoolStrategy
    ),
    deploymentStrategy: expectPersistedValue<CapacityPoolStrategy>(
      'capacity_pools.deployment_strategy',
      row.deploymentStrategy,
      isCapacityPoolStrategy
    ),
    exhaustionPolicy: expectPersistedValue<CapacityExhaustionPolicy>(
      'capacity_pools.exhaustion_policy',
      row.exhaustionPolicy,
      isCapacityExhaustionPolicy
    ),
    maxNodes: row.maxNodes,
    sourceOrder: parseCapacityPoolSourceOrder(row.id, row.sourceOrderJson),
    excludedSourceIds: parseCapacityPoolExcludedSources(row.id, row.excludedSourceIdsJson),
    lastReconciledAt: row.lastReconciledAt,
    migrationVersion: row.migrationVersion,
    migrationState: row.migrationState,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The stored provider order, or null when unset. A malformed value reads as unset (every source
 * equal) rather than failing the pool read, and is logged so it can be fixed.
 */
export function parseCapacityPoolSourceOrder(
  poolId: string,
  raw: string | null | undefined
): string[] | null {
  const ids = parseSourceIdList(poolId, raw, 'capacity_pool.source_order_invalid');
  return ids && ids.length > 0 ? ids : null;
}

/**
 * Accounts switched off in this pool, or an empty list when none are. Reads the column the way
 * the placement authority SQL does (`json_each` in placement-authority.ts): every non-empty
 * string entry is an excluded id. The migration's CHECK only admits a JSON array, and the update
 * path only writes arrays of ids, so anything else is logged and skipped rather than failing
 * the pool read, which would stop every placement and not just this account's.
 */
export function parseCapacityPoolExcludedSources(
  poolId: string,
  raw: string | null | undefined
): string[] {
  if (raw === null || raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) {
    log.warn('capacity_pool.excluded_sources_invalid', { poolId });
    return [];
  }
  const ids = parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (ids.length !== parsed.length) {
    log.warn('capacity_pool.excluded_sources_invalid', {
      poolId,
      skipped: parsed.length - ids.length,
    });
  }
  return ids;
}

function parseSourceIdList(
  poolId: string,
  raw: string | null | undefined,
  invalidEvent: string
): string[] | null {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((id): id is string => typeof id === 'string' && id.length > 0)
    ) {
      return parsed;
    }
  } catch {
    // fall through to the warning below
  }
  log.warn(invalidEvent, { poolId });
  return null;
}

export function toCapacityPoolCandidate(
  row: schema.CapacityPoolCandidate
): CapacityPoolCandidateDto {
  return {
    id: row.id,
    poolId: row.poolId,
    capacitySourceId: row.capacitySourceId,
    provider: row.provider,
    location: row.location,
    workloadRole: expectPersistedValue<CapacityWorkloadRole>(
      'capacity_pool_candidates.workload_role',
      row.workloadRole,
      isCapacityWorkloadRole
    ),
    runtime: row.runtime,
    machineClass: row.machineClass,
    machineSize: row.machineSize,
    providerInstanceType: row.providerInstanceType,
    providerInstanceSku: row.providerInstanceSku,
    providerInstanceDisplayName: row.providerInstanceDisplayName,
    providerInstanceVcpuCount: row.providerInstanceVcpuCount,
    providerInstanceMemoryMb: row.providerInstanceMemoryMb,
    providerInstanceDiskGb: row.providerInstanceDiskGb,
    providerInstanceBootDiskSizeGb: row.providerInstanceBootDiskSizeGb,
    providerInstanceImage: row.providerInstanceImage,
    providerInstanceArchitecture: row.providerInstanceArchitecture,
    providerInstancePriceDisplay: row.providerInstancePriceDisplay,
    providerInstancePriceCurrency: row.providerInstancePriceCurrency,
    providerInstancePriceMonthlyCents: row.providerInstancePriceMonthlyCents,
    providerInstancePriceHourlyMicros: row.providerInstancePriceHourlyMicros,
    providerInstanceCatalogSource: nullablePersistedValue(
      'capacity_pool_candidates.provider_instance_catalog_source',
      row.providerInstanceCatalogSource ?? null,
      isProviderInstanceCatalogSource
    ),
    providerInstanceCatalogLastSeenAt: row.providerInstanceCatalogLastSeenAt ?? null,
    catalogAvailability: row.catalogAvailability as CapacityPoolCandidateDto['catalogAvailability'],
    catalogUnavailableAt: row.catalogUnavailableAt,
    catalogReturnedAt: row.catalogReturnedAt,
    authorityGeneration: row.authorityGeneration,
    priority: row.priority,
    candidateOrder: row.candidateOrder,
    status: expectPersistedValue<CapacityPoolStatus>(
      'capacity_pool_candidates.status',
      row.status,
      isCapacityPoolStatus
    ),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CapacityPlacementSnapshotRow {
  capacityPoolId: string | null;
  capacityPoolScope: string | null;
  capacityPoolRevision: number | null;
  capacitySourceId: string | null;
  capacitySourceGeneration?: number | null;
  capacitySourceExternalRef?: string | null;
  capacityPoolCandidateId: string | null;
  placementCredentialSource: string | null;
  placementCredentialReference: string | null;
  placementCredentialVersion: number | null;
  selectionSettingsVersion?: number | null;
  capacityAuthorityGeneration?: number | null;
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
}

export function toCapacityPlacementSnapshot(
  row: CapacityPlacementSnapshotRow
): CapacityPlacementSnapshot {
  return {
    capacityPoolId: row.capacityPoolId,
    capacityPoolScope: nullablePersistedValue<CapacityPoolScope>(
      'capacity_pool_scope',
      row.capacityPoolScope,
      isCapacityPoolScope
    ),
    capacityPoolRevision: row.capacityPoolRevision,
    capacitySourceId: row.capacitySourceId,
    capacitySourceGeneration: row.capacitySourceGeneration ?? null,
    capacitySourceExternalRef: row.capacitySourceExternalRef ?? null,
    capacityPoolCandidateId: row.capacityPoolCandidateId,
    placementCredentialSource: nullablePersistedValue<CapacityPlacementCredentialSource>(
      'placement_credential_source',
      row.placementCredentialSource,
      isCapacityPlacementCredentialSource
    ),
    placementCredentialReference: row.placementCredentialReference,
    placementCredentialVersion: row.placementCredentialVersion,
    selectionSettingsVersion: row.selectionSettingsVersion ?? null,
    capacityAuthorityGeneration: row.capacityAuthorityGeneration ?? null,
    sourceGeneration: row.capacityAuthorityGeneration ?? null,
    capacityPoolProjectId: row.capacityPoolProjectId,
    workloadRole: nullablePersistedValue<CapacityWorkloadRole>(
      'workload_role',
      row.workloadRole,
      isCapacityWorkloadRole
    ),
    providerInstanceType: row.providerInstanceType ?? null,
    providerInstanceVcpuCount: row.providerInstanceVcpuCount ?? null,
    providerInstanceMemoryMb: row.providerInstanceMemoryMb ?? null,
    providerInstanceDiskGb: row.providerInstanceDiskGb ?? null,
    providerInstanceBootDiskSizeGb: row.providerInstanceBootDiskSizeGb ?? null,
    providerInstanceImage: row.providerInstanceImage ?? null,
    providerInstanceArchitecture: row.providerInstanceArchitecture ?? null,
    providerInstancePriceDisplay: row.providerInstancePriceDisplay ?? null,
    providerInstancePriceCurrency: row.providerInstancePriceCurrency ?? null,
    providerInstancePriceMonthlyCents: row.providerInstancePriceMonthlyCents ?? null,
    providerInstancePriceHourlyMicros: row.providerInstancePriceHourlyMicros ?? null,
    placementExplanationJson: row.placementExplanationJson ?? null,
  };
}
