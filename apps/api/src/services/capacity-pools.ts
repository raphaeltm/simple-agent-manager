import type {
  CapacityCredentialSource,
  CapacityExhaustionPolicy,
  CapacityPlacementCredentialSource,
  CapacityPlacementSnapshot,
  CapacityPool as CapacityPoolDto,
  CapacityPoolCandidate as CapacityPoolCandidateDto,
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
  isCapacityPoolScope,
  isCapacityPoolStatus,
  isCapacityPoolStrategy,
  isCapacitySourceKind,
  isCapacityWorkloadRole,
} from '@simple-agent-manager/shared';

import type * as schema from '../db/schema';

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
    strategy: expectPersistedValue<CapacityPoolStrategy>(
      'capacity_pools.strategy',
      row.strategy,
      isCapacityPoolStrategy
    ),
    exhaustionPolicy: expectPersistedValue<CapacityExhaustionPolicy>(
      'capacity_pools.exhaustion_policy',
      row.exhaustionPolicy,
      isCapacityExhaustionPolicy
    ),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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
  capacityPoolCandidateId: string | null;
  placementCredentialSource: string | null;
  placementCredentialReference: string | null;
  placementCredentialVersion: number | null;
  capacityPoolProjectId: string | null;
  workloadRole: string | null;
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
    capacityPoolCandidateId: row.capacityPoolCandidateId,
    placementCredentialSource: nullablePersistedValue<CapacityPlacementCredentialSource>(
      'placement_credential_source',
      row.placementCredentialSource,
      isCapacityPlacementCredentialSource
    ),
    placementCredentialReference: row.placementCredentialReference,
    placementCredentialVersion: row.placementCredentialVersion,
    capacityPoolProjectId: row.capacityPoolProjectId,
    workloadRole: nullablePersistedValue<CapacityWorkloadRole>(
      'workload_role',
      row.workloadRole,
      isCapacityWorkloadRole
    ),
    placementExplanationJson: row.placementExplanationJson ?? null,
  };
}
