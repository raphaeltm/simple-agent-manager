/**
 * Public entry of scheduler-core: the pure placement and capacity decisions of the scheduler.
 * Nothing here reads or writes storage. The worker supplies values read from D1 and keeps the
 * SQL and compare-and-swap reservations that act on these decisions.
 */
export {
  capacityCandidateAuthorityGeneration,
  capacityPlacementAuthorityGeneration,
  capacitySourceAuthorityGeneration,
  timestampVersion,
} from './capacity-pool-authority';
export {
  type EffectiveDefaultCapacityPoolScope,
  effectiveDefaultCapacityPoolScopeChain,
  type EffectiveDefaultCapacityPoolScopeInput,
  higherPrecedenceDefaultCapacityPoolScopes,
} from './capacity-pool-precedence';
export { DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS } from './capacity-pool-selection-defaults';
export {
  CAPACITY_POOL_MATERIALIZED_WORKLOAD_ROLES,
  capacityCandidateBaseId,
  capacityCandidateIdForRole,
  capacityCandidateRoleFromId,
  capacityCandidateSatisfiesWorkloadRole,
  isEditorVisibleCapacityCandidateRole,
  PRIMARY_CAPACITY_WORKLOAD_ROLE,
} from './capacity-pool-workload-roles';
export { type WorkspaceAdmissionEnv } from './env';
export { legacyNodeVcpuEstimate } from './legacy-node-pool-compatibility';
export {
  type ConcreteCapacitySnapshot,
  normalizeConcreteSnapshot,
} from './placement-authority-snapshot';
export {
  preferCapacityCandidatesInLocation,
  rankCapacityCandidatesForRuntime,
  type RankCapacityCandidatesInput,
} from './placement-capacity-ranking';
export {
  buildPlacementDecisionDiagnostics,
  type BuildPlacementDiagnosticsInput,
  type PlacementHostDiagnosticInput,
} from './placement-diagnostics';
export {
  inheritedCredentialAttributionForCaller,
  normalizeCredentialAttribution,
  resolveCredentialLookup,
  resolveDevcontainerConfigName,
  resolvePreferredVmLocation,
  resolveProvider,
  resolveTaskMode,
  resolveVmLocation,
  resolveVmSize,
  resolveVmSizeSource,
  resolveWorkloadRole,
  resolveWorkspaceProfile,
  validateResolvedLocation,
} from './placement-field-resolution';
export {
  emptyCapacityPoolMessage,
  noEligibleCapacityCandidateMessage,
  PlacementResolutionError,
} from './placement-resolution-error';
export {
  buildCapacityPoolSelection,
  capacityPoolNoCandidatesError,
  capacityPoolNoCandidatesMessage,
} from './placement-resolver-capacity';
export {
  hasNoCapacityPoolCandidates,
  resolveReusableNodeCapacitySnapshot,
} from './placement-resolver-capacity-reuse';
export {
  buildCapacityPlacementExplanation,
  capacityPlacementSnapshotForCandidate,
  capacityPlacementSnapshotForTaskStart,
  capacityPoolSnapshotForPool,
  directPlacementAuditSnapshot,
} from './placement-resolver-capacity-snapshot';
export {
  type CapacityAwareNodePlacementRow,
  type PlacementCredentialAttribution,
  type PlacementCredentialAttributionInput,
  type PlacementCredentialLookup,
  type PlacementCredentialProjectPolicy,
  type PlacementCredentialResolutionFailure,
  type PlacementCredentialSourceResult,
  type PlacementEntryPoint,
  type PlacementExplicitOverrides,
  type PlacementProfileDefaults,
  type PlacementProfileVmSizeSource,
  type PlacementProjectDefaults,
  type PlacementResolutionErrorCode,
  type PlacementRuntimeResolution,
  type PlacementTaskModeDefault,
  type TaskStartCapacityCandidate,
  type TaskStartCapacityPoolSelection,
  type TaskStartPlacement,
  type TaskStartPlacementInput,
  type TaskStartPlacementWithCredential,
} from './placement-resolver-types';
export {
  comparePlacementRolloutHosts,
  PLACEMENT_ROLLOUT_BASELINE_STRATEGY,
  resolvePlacementRollout,
} from './placement-rollout';
export {
  buildPlacementLocationInventory,
  comparePlacementHostsByStrategy,
  comparePlacementLocationsByStrategy,
  normalizePlacementHostSignals,
  type PlacementHostSignals,
  type PlacementLocationInventory,
  placementLocationKey,
} from './placement-strategy';
export {
  newProviderLimitWait,
  parseProviderLimitWait,
  PROVIDER_LIMIT_CONTINUATION,
  PROVIDER_LIMIT_POLICY,
  providerLimitNeedsImmediateSleep,
  type ProviderLimitWait,
} from './provider-limit-policy';
export {
  DEFAULT_PROVISIONING_ATTEMPTS_PER_PROVIDER_TIER,
  DEFAULT_WORKSPACE_BUILD_QUEUE_TIMEOUT_MINUTES,
  DEFAULT_WORKSPACE_PLACEMENT_BACKLOG_CONFLICT_RETRIES,
  DEFAULT_WORKSPACE_PLACEMENT_MAX_REJECTIONS,
} from './provisioning-attempt-limits';
export {
  collectStoredResourceRequirementLayers,
  createPersistedTaskResourcePlanJson,
  firstResourceRequirementLayer,
  firstResourceRequirementLayerJson,
  mergeResourceRequirementLayers,
  normalizeResourceRequirementsInput,
  parseLegacyVmSize,
  parseResourceRequirementsSource,
  parseStoredResolvedReservationJson,
  parseStoredResourceRequirementsJson,
  type PersistedTaskResourcePlanReadResult,
  readPersistedTaskResourcePlan,
  ResourceRequirementsValidationError,
  serializeModernResourceRequirementsInput,
  serializeResourceRequirementsInput,
} from './resource-requirements-input';
export {
  DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB,
  type PlacementAdmissionPolicy,
  resolveEffectiveNodeHostMemoryReserveMb,
  resolveWorkspaceAdmissionPolicy,
  type WorkspaceAdmissionPolicy,
} from './workspace-admission-policy';
export {
  type ActiveWorkspaceReservationUsage,
  addReservationUsage,
  aggregateWorkspaceReservationRows,
  emptyUsage,
  isResolvedResourceReservation,
  parseResolvedResourceReservation,
  parseTimestampMs,
  RESOURCE_REQUIREMENTS_SOURCES,
} from './workspace-reservation-usage';
export {
  cpuBudgetMillis,
  evaluateWorkspaceReservationCapacity,
  hasWorkspaceReservationCapacity,
  MEASURED_MEMORY_OVERRUN_REASON,
  normalizeLoadAverageToCpuPercent,
  parseWorkspaceAdmissionMetrics,
  resolveTrustedWorkspaceNodeCapacity,
  usableMemoryMb,
  type WorkspaceResourceNode,
} from './workspace-resource-capacity';
export {
  decideWorkspaceRuntime,
  type WorkspaceRuntimeDecision,
} from './workspace-runtime-decision';
