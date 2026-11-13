import type {
  CapacityPlacementSnapshot,
  CapacityPoolScope,
  CapacityWorkloadRole,
} from '@simple-agent-manager/shared';

/**
 * A node's capacity snapshot with every field placement authority relies on validated. A snapshot
 * missing any of them cannot be matched to current pool state, so it normalizes to null.
 */
export function normalizeConcreteSnapshot(
  snapshot: CapacityPlacementSnapshot
): ConcreteCapacitySnapshot | null {
  const capacityPoolId = nonEmptyString(snapshot.capacityPoolId);
  if (!capacityPoolId) return null;

  const capacityPoolScope = snapshot.capacityPoolScope;
  if (!isCapacityPoolScope(capacityPoolScope)) return null;

  const capacityPoolRevision = positiveInteger(snapshot.capacityPoolRevision);
  if (capacityPoolRevision === null) return null;

  const capacitySourceId = nonEmptyString(snapshot.capacitySourceId);
  if (!capacitySourceId) return null;

  const capacitySourceGeneration = positiveInteger(snapshot.capacitySourceGeneration);
  if (capacitySourceGeneration === null) return null;

  const capacityPoolCandidateId = nonEmptyString(snapshot.capacityPoolCandidateId);
  if (!capacityPoolCandidateId) return null;

  const placementCredentialSource = snapshot.placementCredentialSource;
  if (
    placementCredentialSource !== 'user' &&
    placementCredentialSource !== 'project' &&
    placementCredentialSource !== 'platform'
  ) {
    return null;
  }

  const placementCredentialReference = nonEmptyString(snapshot.placementCredentialReference);
  if (!placementCredentialReference) return null;

  const placementCredentialVersion = positiveInteger(snapshot.placementCredentialVersion);
  if (placementCredentialVersion === null) return null;

  const capacityPoolProjectId =
    capacityPoolScope === 'project' ? nonEmptyString(snapshot.capacityPoolProjectId) : null;
  if (capacityPoolScope === 'project' && !capacityPoolProjectId) return null;
  if (capacityPoolScope !== 'project' && snapshot.capacityPoolProjectId !== null) return null;

  const workloadRole = snapshot.workloadRole;
  if (workloadRole !== 'workspace' && workloadRole !== 'deployment') return null;

  const providerInstanceType = nonEmptyString(snapshot.providerInstanceType);
  if (!providerInstanceType) return null;

  const providerInstanceVcpuCount = positiveInteger(snapshot.providerInstanceVcpuCount);
  if (providerInstanceVcpuCount === null) return null;

  const providerInstanceMemoryMb = positiveInteger(snapshot.providerInstanceMemoryMb);
  if (providerInstanceMemoryMb === null) return null;

  const providerInstanceDiskGb = nullableNonNegativeInteger(snapshot.providerInstanceDiskGb);
  if (providerInstanceDiskGb === undefined) return null;

  const providerInstanceBootDiskSizeGb = nullableNonNegativeInteger(
    snapshot.providerInstanceBootDiskSizeGb
  );
  if (providerInstanceBootDiskSizeGb === undefined) return null;

  return {
    capacityPoolId,
    capacityPoolScope,
    capacityPoolRevision,
    capacitySourceId,
    capacitySourceGeneration,
    capacitySourceExternalRef: snapshot.capacitySourceExternalRef ?? null,
    capacityPoolCandidateId,
    placementCredentialSource,
    placementCredentialReference,
    placementCredentialVersion,
    capacityPoolProjectId,
    workloadRole,
    providerInstanceType,
    providerInstanceVcpuCount,
    providerInstanceMemoryMb,
    providerInstanceDiskGb,
    providerInstanceBootDiskSizeGb,
    providerInstanceImage: snapshot.providerInstanceImage ?? null,
    providerInstanceArchitecture: snapshot.providerInstanceArchitecture ?? null,
  };
}
export interface ConcreteCapacitySnapshot {
  capacityPoolId: string;
  capacityPoolScope: CapacityPoolScope;
  capacityPoolRevision: number;
  capacitySourceId: string;
  capacitySourceGeneration: number;
  capacitySourceExternalRef: string | null;
  capacityPoolCandidateId: string;
  placementCredentialSource: 'user' | 'project' | 'platform';
  placementCredentialReference: string;
  placementCredentialVersion: number;
  capacityPoolProjectId: string | null;
  workloadRole: CapacityWorkloadRole;
  providerInstanceType: string;
  providerInstanceVcpuCount: number;
  providerInstanceMemoryMb: number;
  providerInstanceDiskGb: number | null;
  providerInstanceBootDiskSizeGb: number | null;
  providerInstanceImage: string | null;
  providerInstanceArchitecture: string | null;
}

function isCapacityPoolScope(value: unknown): value is CapacityPoolScope {
  return value === 'installation' || value === 'user' || value === 'project';
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function nullableNonNegativeInteger(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}
