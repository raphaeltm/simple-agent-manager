// =============================================================================
// Capacity Pool Core Types
// =============================================================================

export const CAPACITY_POOL_SCOPES = ['installation', 'user', 'project'] as const;
export type CapacityPoolScope = (typeof CAPACITY_POOL_SCOPES)[number];

export const CAPACITY_SOURCE_KINDS = [
  'cloud-provider-credential',
  'registered-runner',
  'instant-runtime',
] as const;
export type CapacitySourceKind = (typeof CAPACITY_SOURCE_KINDS)[number];

export const CAPACITY_CREDENTIAL_SOURCES = ['user', 'project', 'platform'] as const;
export type CapacityCredentialSource = (typeof CAPACITY_CREDENTIAL_SOURCES)[number];

export const CAPACITY_POOL_STATUSES = ['active', 'disabled', 'deleted'] as const;
export type CapacityPoolStatus = (typeof CAPACITY_POOL_STATUSES)[number];

export const CAPACITY_POOL_STRATEGIES = ['balanced', 'pack', 'spread', 'smallest-fit'] as const;
export type CapacityPoolStrategy = (typeof CAPACITY_POOL_STRATEGIES)[number];

export const CAPACITY_EXHAUSTION_POLICIES = ['queue', 'fail', 'fallback-chain'] as const;
export type CapacityExhaustionPolicy = (typeof CAPACITY_EXHAUSTION_POLICIES)[number];

export const CAPACITY_WORKLOAD_ROLES = ['workspace', 'deployment'] as const;
export type CapacityWorkloadRole = (typeof CAPACITY_WORKLOAD_ROLES)[number];

export const CAPACITY_PLACEMENT_CREDENTIAL_SOURCES = [
  'user',
  'project',
  'platform',
  'self-hosted',
] as const;
export type CapacityPlacementCredentialSource =
  (typeof CAPACITY_PLACEMENT_CREDENTIAL_SOURCES)[number];

export interface CapacitySourceIdentity {
  id: string;
  scope: CapacityPoolScope;
  ownerUserId: string | null;
  ownerProjectId: string | null;
  sourceKind: CapacitySourceKind;
  provider: string | null;
  credentialSource: CapacityCredentialSource | null;
  credentialId: string | null;
  platformCredentialId: string | null;
  credentialReference: string | null;
  credentialVersion: number | null;
  externalSourceRef: string | null;
  status: CapacityPoolStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CapacityPool {
  id: string;
  scope: CapacityPoolScope;
  ownerUserId: string | null;
  ownerProjectId: string | null;
  name: string;
  isDefault: boolean;
  revision: number;
  status: CapacityPoolStatus;
  strategy: CapacityPoolStrategy;
  exhaustionPolicy: CapacityExhaustionPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface CapacityPoolCandidate {
  id: string;
  poolId: string;
  capacitySourceId: string;
  provider: string | null;
  location: string | null;
  workloadRole: CapacityWorkloadRole;
  runtime: string | null;
  machineClass: string | null;
  machineSize: string | null;
  priority: number;
  candidateOrder: number;
  status: CapacityPoolStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CapacityPoolFallback {
  poolId: string;
  fallbackPoolId: string;
  fallbackOrder: number;
  condition: string | null;
  createdAt: string;
}

export interface CapacityPlacementSnapshot {
  capacityPoolId: string | null;
  capacityPoolScope: CapacityPoolScope | null;
  capacityPoolRevision: number | null;
  capacitySourceId: string | null;
  capacityPoolCandidateId: string | null;
  placementCredentialSource: CapacityPlacementCredentialSource | null;
  placementCredentialReference: string | null;
  placementCredentialVersion: number | null;
  capacityPoolProjectId: string | null;
  workloadRole: CapacityWorkloadRole | null;
  placementExplanationJson?: string | null;
}

// =============================================================================
// Capacity Pool API Response Types
// =============================================================================

export interface DefaultCapacityPoolSummary {
  pool: CapacityPool;
  sources: CapacitySourceIdentity[];
  candidates: CapacityPoolCandidate[];
  activeCandidateCount: number;
}

export interface DefaultCapacityPoolScopeSummary {
  scope: CapacityPoolScope;
  visibility: 'visible' | 'hidden';
  visibilityReason: string;
  canReconcile: boolean;
  summary: DefaultCapacityPoolSummary | null;
}

export interface DefaultCapacityPoolPolicyUpdate {
  strategy?: CapacityPoolStrategy;
  exhaustionPolicy?: CapacityExhaustionPolicy;
}

export interface DefaultCapacityPoolCandidateStatusUpdate {
  id: string;
  status: CapacityPoolStatus;
}

export interface DefaultCapacityPoolUpdateRequest {
  policy?: DefaultCapacityPoolPolicyUpdate;
  candidates?: DefaultCapacityPoolCandidateStatusUpdate[];
}

export interface ProjectDefaultCapacityPoolsResponse {
  effective: DefaultCapacityPoolSummary | null;
  effectiveScope: CapacityPoolScope | null;
  defaults: DefaultCapacityPoolScopeSummary[];
  precedence: CapacityPoolScope[];
  reconciledScopes: CapacityPoolScope[];
  policyMutationSupported: boolean;
}

export function isCapacityPoolScope(value: unknown): value is CapacityPoolScope {
  return typeof value === 'string' && (CAPACITY_POOL_SCOPES as readonly string[]).includes(value);
}

export function isCapacitySourceKind(value: unknown): value is CapacitySourceKind {
  return typeof value === 'string' && (CAPACITY_SOURCE_KINDS as readonly string[]).includes(value);
}

export function isCapacityCredentialSource(value: unknown): value is CapacityCredentialSource {
  return (
    typeof value === 'string' && (CAPACITY_CREDENTIAL_SOURCES as readonly string[]).includes(value)
  );
}

export function isCapacityPoolStatus(value: unknown): value is CapacityPoolStatus {
  return typeof value === 'string' && (CAPACITY_POOL_STATUSES as readonly string[]).includes(value);
}

export function isCapacityPoolStrategy(value: unknown): value is CapacityPoolStrategy {
  return (
    typeof value === 'string' && (CAPACITY_POOL_STRATEGIES as readonly string[]).includes(value)
  );
}

export function isCapacityExhaustionPolicy(value: unknown): value is CapacityExhaustionPolicy {
  return (
    typeof value === 'string' && (CAPACITY_EXHAUSTION_POLICIES as readonly string[]).includes(value)
  );
}

export function isCapacityWorkloadRole(value: unknown): value is CapacityWorkloadRole {
  return (
    typeof value === 'string' && (CAPACITY_WORKLOAD_ROLES as readonly string[]).includes(value)
  );
}

export function isCapacityPlacementCredentialSource(
  value: unknown
): value is CapacityPlacementCredentialSource {
  return (
    typeof value === 'string' &&
    (CAPACITY_PLACEMENT_CREDENTIAL_SOURCES as readonly string[]).includes(value)
  );
}
