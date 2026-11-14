/**
 * Public entry of the app-deployment module: compose rendering and publish,
 * release routing, volumes, custom domains, environment config and state,
 * publish jobs and image tag resolution. Scheduled sweeps are exported from
 * `./scheduled` so importing the services does not load them.
 *
 * Values are exported only when the worker uses them; all types are exported. The
 * worker (apps/api) wires the ports in `src/app-deployment-ports/` and keeps
 * re-export files at the old `services/` and `scheduled/` paths.
 */
export { collectBuildContextOnSource } from './build-context-collection';
export * from './build-context-defaults';
export { scheduleBuildContextShadow } from './build-context-shadow';
export type { BuildContextDescriptor,BuildContextOwner } from './build-context-state';
export { buildContextKey, completeBuildContext,reserveBuildContext } from './build-context-state';
export { createBuildContextUpload, verifyBuildContextObject } from './build-context-upload';
export type {
  ComposeImageArtifactDescriptor,
  ComposeImageArtifactDownload,
  ComposeImageArtifactPlatform,
  ComposeImageArtifactRequest,
  ComposeImageArtifactUpload,
} from './compose-image-artifacts';
export {
  createComposeImageArtifactDownloads,
  createComposeImageArtifactUploads,
  getComposeImageArtifactMaxBytes,
  validateCompletedComposeImageArtifacts,
  validateComposeImageArtifactDescriptor,
} from './compose-image-artifacts';
export type {
  ComposePublishApplyOptions,
  ComposePublishApplyResult,
  ComposePublishSubmission,
  ComposePublishWarning,
} from './compose-publish-apply';
export {
  buildComposePublishApplyPayload,
  DEFAULT_COMPOSE_PUBLISH_LOG_MAX_FILE,
  DEFAULT_COMPOSE_PUBLISH_LOG_MAX_SIZE,
  DEFAULT_COMPOSE_PUBLISH_MEMORY_LIMIT_MB,
  extractComposePublishVolumeDeclarations,
} from './compose-publish-apply';
export type { ComposeApplyRenderResult, ComposeRenderContext } from './compose-renderer';
export { collectSecretNames, renderCompose, renderComposeForApply } from './compose-renderer';
export type {
  CreateAgentDeploymentEnvironmentResult,
  DeploymentAgentPolicy,
  DeploymentHeartbeatState,
  DeploymentMcpCaller,
  DeploymentReleaseStatusTransition,
  ObservedDeploymentState,
} from './deployment-control';
export {
  AGENT_DEPLOYABLE_ENVIRONMENT_STATUSES,
  assertAgentDeploymentAllowed,
  assertAgentDeploymentAllowedForProfile,
  buildObservedDeploymentUpdate,
  createAgentDeploymentEnvironment,
  DEPLOYMENT_ENVIRONMENT_NAME_RE,
  encodeAllowedDeployProfileIds,
  getTaskAgentProfileId,
  isDeploymentPolicyAllowedForProfile,
  parseAllowedDeployProfileIds,
  reconcileDeploymentReleaseStatuses,
  toDeploymentAgentPolicy,
  toObservedDeploymentState,
  uniqueDeployProfileIds,
  validateAllowedDeployProfiles,
} from './deployment-control';
export type {
  CustomDomainDesiredState,
  CustomDomainLifecycleEventInput,
  CustomDomainRoutingStatus,
} from './deployment-custom-domains';
export {
  buildVerifiedCustomRouteTargets,
  customDomainExpectedTargetChanged,
  findRouteTargetForDomain,
  getEnvironmentPublicRouteTargets,
  reconcileCustomDomainRoutingObservation,
  recordCustomDomainEvent,
  requestRoutingRevision,
  routeTargetOptions,
} from './deployment-custom-domains';
export type { ResolvedHostnameTarget } from './deployment-domain-verify';
export { verifyCustomDomainTarget } from './deployment-domain-verify';
export type { DeploymentInterpolationEnv } from './deployment-environment-config';
export {
  buildDeploymentEnvironmentConfigResponse,
  deleteDeploymentEnvironmentConfigVar,
  loadDeploymentBuildInterpolationEnv,
  loadDeploymentEnvironmentConfigRows,
  loadDeploymentInterpolationEnv,
  upsertDeploymentEnvironmentConfigVar,
} from './deployment-environment-config';
export {
  DEPLOYMENT_RELOCATION_CLAIM_FIELD,
  NO_DEPLOYMENT_RELOCATION_CLAIM_SQL,
  RECOVER_ERRORED_ENVIRONMENT_SET_SQL,
} from './deployment-environment-state';
export type { DeploymentReleaseSubmittedBy } from './deployment-environment-summary';
export {
  buildDeploymentEnvironmentResponse,
  listRoutedCustomDomainHostnames,
  parseReleaseSubmittedByJson,
} from './deployment-environment-summary';
export { cancelDeploymentPublishJobOnVmBestEffort } from './deployment-publish-job-cancel';
export {
  DEFAULT_DEPLOY_PUBLISH_JOB_CANCEL_TIMEOUT_MS,
  DEFAULT_DEPLOY_PUBLISH_JOB_DEADLINE_MARGIN_MS,
  DEFAULT_DEPLOY_PUBLISH_JOB_DEADLINE_MS,
  DEFAULT_DEPLOY_PUBLISH_JOB_STALL_MS,
  DEFAULT_DEPLOY_PUBLISH_JOB_SWEEP_LIMIT,
  MIN_DEPLOY_PUBLISH_JOB_STALL_MS,
} from './deployment-publish-job-defaults';
export { getDeploymentPublishJobSettings } from './deployment-publish-job-settings';
export type {
  AppendDeploymentPublishJobEventInput,
  CreateDeploymentPublishJobInput,
} from './deployment-publish-jobs';
export {
  appendDeploymentPublishJobEvent,
  cancelDeploymentPublishJob,
  createDeploymentPublishJob,
  failExpiredDeploymentPublishJobs,
  getDeploymentPublishJobForMcp,
  PUBLISH_JOB_TERMINAL_STATUSES,
  sanitizePublishEventText,
  visiblePublishJobPredicate,
} from './deployment-publish-jobs';
export type {
  AppendDeploymentReleaseEventInput,
  DeploymentReleaseEventView,
  ListDeploymentReleaseEventsInput,
} from './deployment-release-events';
export {
  appendDeploymentReleaseEvent,
  listDeploymentReleaseEvents,
} from './deployment-release-events';
export {
  markDeploymentReleasePlacementFailed,
  recordStrandedDeploymentReleasePlacement,
} from './deployment-release-failure';
export type {
  DeploymentRouteDiscovery,
  DeploymentRouteInternalDiscovery,
  DeploymentRoutePublicDiscovery,
  DeploymentRouteTarget,
  DeploymentRouteTargetOptions,
  PublicRouteInput,
} from './deployment-routing';
export {
  buildComposePublishRouteDiscovery,
  buildDeploymentRouteTargets,
  buildReleaseRouteDiscovery,
  collectEnvironmentRouteHostnames,
  environmentPortOffset,
  extractComposeRouteHints,
} from './deployment-routing';
export type {
  CreateVolumeOptions,
  LinkedDeploymentNodeVolumeTarget,
  VolumeMountDescriptor,
} from './deployment-volumes';
export {
  attachEnvironmentVolumes,
  attachEnvironmentVolumesToLinkedNode,
  buildVolumeMountDescriptors,
  createEnvironmentVolume,
  createMissingDeclaredVolumes,
  createMissingManifestVolumes,
  deleteEnvironmentVolume,
  detachEnvironmentVolumes,
  detachEnvironmentVolumesFromLinkedNode,
  listEnvironmentVolumes,
  markDeploymentReleaseVolumeAttachFailed,
  resolveLinkedDeploymentNodeVolumeTarget,
  resolveNamedVolumeBindSource,
  resolveNamedVolumeMountRoot,
  resolveVolumeMountRoot,
} from './deployment-volumes';
export type { AppDeploymentEnv } from './env';
export type {
  ImageResolver,
  ImageResolverConfig,
  ImageResolverEnv,
  ImageResolverOptions,
  RegistryAuth,
} from './image-resolver';
export { createImageResolver, ImageResolveError } from './image-resolver';
export type { ResolverRuntimeOptions } from './image-resolver-outbound';
export { getImageResolverConfig } from './image-resolver-outbound';
export type {
  DeploymentLifecyclePort,
  DeploymentProviderPort,
  DeploymentPublishJobLifecycleEvent,
  DeploymentPublishJobPorts,
  DeploymentPublishJobSettingName,
  DeploymentPublishVmPort,
  DeploymentSecretCipher,
  DeploymentSettingsPort,
} from './ports';
export type { BuildContextCollectionPorts, BuildContextInterpolation } from './ports';
