// =============================================================================
// Capacity Pool Core Types
// =============================================================================

import type { ProviderInstanceCatalogSource } from './provider';
import type { ResourceRequirements } from './resource';
import type { CredentialProvider } from './user';
import type { VMSize } from './workspace';

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

export const CAPACITY_POOL_CONFIGURATION_STATES = [
  'configured-ready',
  'configured-empty',
  'source-disabled',
  'catalog-unavailable',
  'migration-pending',
] as const;
export type CapacityPoolConfigurationState = (typeof CAPACITY_POOL_CONFIGURATION_STATES)[number];

export const DEFAULT_CAPACITY_POOL_EFFECTIVE_STATES = [
  'unconfigured',
  ...CAPACITY_POOL_CONFIGURATION_STATES,
] as const;
export type DefaultCapacityPoolEffectiveState =
  (typeof DEFAULT_CAPACITY_POOL_EFFECTIVE_STATES)[number];

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
  /** Stable semantic source authority. This is not the refresh-order source_generation fence. */
  authorityGeneration?: number;
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
  configurationState?: CapacityPoolConfigurationState;
  strategy: CapacityPoolStrategy;
  exhaustionPolicy: CapacityExhaustionPolicy;
  lastReconciledAt?: string | null;
  migrationVersion?: string | null;
  migrationState?: string | null;
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
  /** Backward-compatible preset that seeded/requested this offering. Not candidate identity. */
  machineSize: string | null;
  /** Provider-native instance type, plan, flavor, machine type, or SKU. */
  providerInstanceType: string | null;
  /** Optional provider-native SKU when distinct from the instance type. */
  providerInstanceSku?: string | null;
  /** Human-readable provider-native offering label. */
  providerInstanceDisplayName?: string | null;
  /** Normalized concrete offering capacity. */
  providerInstanceVcpuCount: number | null;
  providerInstanceMemoryMb: number | null;
  providerInstanceDiskGb: number | null;
  providerInstanceBootDiskSizeGb?: number | null;
  providerInstanceImage?: string | null;
  providerInstanceArchitecture?: string | null;
  providerInstancePriceDisplay: string | null;
  providerInstancePriceCurrency: string | null;
  providerInstancePriceMonthlyCents: number | null;
  providerInstancePriceHourlyMicros: number | null;
  providerInstanceCatalogSource?: ProviderInstanceCatalogSource | null;
  providerInstanceCatalogLastSeenAt?: string | null;
  catalogAvailability?: 'available' | 'last-known-unavailable';
  catalogUnavailableAt?: string | null;
  catalogReturnedAt?: string | null;
  /** Stable semantic candidate authority. This is not the refresh-order catalog_generation fence. */
  authorityGeneration?: number;
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
  placementPlanVersion?: number;
  capacityPoolId: string | null;
  capacityPoolScope: CapacityPoolScope | null;
  capacityPoolRevision: number | null;
  capacitySourceId: string | null;
  /** Source row generation used to detect source/attachment drift after placement. */
  capacitySourceGeneration?: number | null;
  /** Non-secret source attachment/reference snapshot, e.g. a composable attachment ref. */
  capacitySourceExternalRef?: string | null;
  capacityPoolCandidateId: string | null;
  placementCredentialSource: CapacityPlacementCredentialSource | null;
  placementCredentialReference: string | null;
  placementCredentialVersion: number | null;
  capacityPoolProjectId: string | null;
  workloadRole: CapacityWorkloadRole | null;
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
  exhaustionPolicy?: CapacityExhaustionPolicy | null;
  effectivePoolState?: DefaultCapacityPoolEffectiveState | null;
  selectionSettingsVersion?: number | null;
  /** Stable semantic authority for the selected pool/source/candidate/settings plan. */
  capacityAuthorityGeneration?: number | null;
  /** Backward-compatible alias for capacityAuthorityGeneration in pre-rename consumers. */
  sourceGeneration?: number | null;
  placementExplanationJson?: string | null;
}

export interface CapacityPoolSelectionWeights {
  priority: number;
  price: number;
  fit: number;
  capacity: number;
  candidateOrder: number;
}

export interface CapacityPoolPlacementSettings {
  version: number;
  /** Monotonic/fingerprinted generation of the effective settings source. */
  sourceGeneration: number;
  legacyWorkloadAdapterVersion: number;
  selectionWeights: CapacityPoolSelectionWeights;
  rolloutCohortPercent: number;
  source: {
    legacyWorkloadMapping: 'persisted' | 'environment' | 'default';
    platformDefaults: 'persisted' | 'environment' | 'default';
    selection: 'persisted' | 'environment' | 'default';
  };
  diagnostics: string[];
}

export interface SafeCapacityPoolPlacementSettingsSummary {
  version: number;
  /** Fingerprint of the selected behavior-affecting settings. */
  sourceGeneration: number;
  legacyWorkloadAdapterVersion: number;
  selectionWeights: CapacityPoolSelectionWeights;
  rolloutCohortPercent: number;
  source: {
    legacyWorkloadMapping: 'persisted' | 'environment' | 'default';
    platformDefaults: 'persisted' | 'environment' | 'default';
    selection: 'persisted' | 'environment' | 'default';
  };
  resourceDefaults: {
    legacyWorkloadMapping: Record<VMSize, Required<ResourceRequirements>>;
    platformDefaults: Required<ResourceRequirements>;
  };
}

// =============================================================================
// Capacity Pool API Response Types
// =============================================================================

export const SAFE_EFFECTIVE_CAPACITY_POOL_REASONS = [
  'no-capacity-pool-configured',
  'configured-default-pool-has-no-active-candidates',
  'configured-default-pool-sources-disabled',
  'configured-default-pool-catalog-last-known-unavailable',
  'configured-default-pool-migration-pending',
] as const;
export type SafeEffectiveCapacityPoolReason = (typeof SAFE_EFFECTIVE_CAPACITY_POOL_REASONS)[number];

export interface SafeEffectiveCapacityPoolSummary {
  scope: CapacityPoolScope | null;
  state: DefaultCapacityPoolEffectiveState;
  strategy: CapacityPoolStrategy | null;
  exhaustionPolicy: CapacityExhaustionPolicy | null;
  availableCandidateCount: number;
  /** Eligible VM choices without pool, source, credential or owner identifiers. */
  nativeOfferings?: Array<{
    provider: CredentialProvider;
    location: string;
    providerInstanceType: string;
    displayName: string;
    vcpu: number | null;
    memoryMb: number | null;
    diskGb: number | null;
    price: string | null;
  }>;
  reason?: SafeEffectiveCapacityPoolReason;
}

export interface DefaultCapacityPoolSummary {
  pool: CapacityPool;
  sources: CapacitySourceIdentity[];
  candidates: CapacityPoolCandidate[];
  activeCandidateCount: number;
  availableCandidateCount?: number;
  effectiveState?: DefaultCapacityPoolEffectiveState;
  diagnostics?: string[];
}

export interface DefaultCapacityPoolScopeSummary {
  scope: CapacityPoolScope;
  visibility: 'visible' | 'hidden';
  visibilityReason: string;
  canReconcile: boolean;
  effectiveState?: DefaultCapacityPoolEffectiveState;
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

export interface DefaultCapacityPoolCandidateCatalogAddition {
  sourceId: string;
  provider: CredentialProvider;
  location: string;
  providerInstanceType: string;
  providerInstanceSku?: string | null;
}

export interface DefaultCapacityPoolUpdateRequest {
  policy?: DefaultCapacityPoolPolicyUpdate;
  candidates?: DefaultCapacityPoolCandidateStatusUpdate[];
  catalogAdditions?: DefaultCapacityPoolCandidateCatalogAddition[];
}

export interface ProjectDefaultCapacityPoolsResponse {
  effective: DefaultCapacityPoolSummary | null;
  effectiveScope: CapacityPoolScope | null;
  effectiveState?: DefaultCapacityPoolEffectiveState;
  effectiveSummary?: SafeEffectiveCapacityPoolSummary;
  defaults: DefaultCapacityPoolScopeSummary[];
  precedence: CapacityPoolScope[];
  reconciledScopes: CapacityPoolScope[];
  policyMutationSupported: boolean;
  placementSettings?: SafeCapacityPoolPlacementSettingsSummary;
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

export function isCapacityPoolConfigurationState(
  value: unknown
): value is CapacityPoolConfigurationState {
  return (
    typeof value === 'string' &&
    (CAPACITY_POOL_CONFIGURATION_STATES as readonly string[]).includes(value)
  );
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
