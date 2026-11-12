/**
 * Public entry of the app-deployment module: compose rendering and publish,
 * release routing, volumes, custom domains, environment config and state,
 * publish jobs and image tag resolution. Scheduled sweeps are exported from
 * `./scheduled` so importing the services does not load them.
 *
 * The worker (apps/api) wires the ports in `src/app-deployment-ports/` and keeps
 * re-export files at the old `services/` and `scheduled/` paths.
 */
export type {
  ComposeImageArtifactDescriptor,
  ComposeImageArtifactDownload,
  ComposeImageArtifactPlatform,
  ComposeImageArtifactRequest,
  ComposeImageArtifactUpload,
} from './compose-image-artifacts';
export {
  buildComposeImageArtifactKey,
  buildLocalImageRef,
  COMPOSE_IMAGE_ARTIFACT_ARCHIVE_TYPE,
  COMPOSE_IMAGE_ARTIFACT_MEDIA_TYPE,
  createComposeImageArtifactDownloads,
  createComposeImageArtifactUploads,
  DEFAULT_COMPOSE_IMAGE_ARTIFACT_MAX_BYTES,
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
  parseJsonField,
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
export {
  matchesCustomDomainTarget,
  resolveHostnameTarget,
  verifyCustomDomainTarget,
} from './deployment-domain-verify';
export type { DeploymentInterpolationEnv } from './deployment-environment-config';
export {
  buildDeploymentEnvironmentConfigResponse,
  deleteDeploymentEnvironmentConfigVar,
  loadDeploymentBuildInterpolationEnv,
  loadDeploymentEnvironmentConfigRows,
  loadDeploymentInterpolationEnv,
  touchDeploymentConfigUpdatedAt,
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
  toReleaseSubmittedBy,
} from './deployment-environment-summary';
export { cancelDeploymentPublishJobOnVmBestEffort } from './deployment-publish-job-cancel';
export {
  DEFAULT_DEPLOY_PUBLISH_CALLBACK_GRACE_MS,
  DEFAULT_DEPLOY_PUBLISH_HEARTBEAT_INTERVAL_MS,
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
  assignRouteTargets,
  buildComposePublishRouteDiscovery,
  buildComposePublishRouteTargets,
  buildDeploymentRouteDiscovery,
  buildDeploymentRouteTargets,
  buildReleaseRouteDiscovery,
  buildReleaseRouteTargets,
  buildRouteHostname,
  buildRouteHostnamePattern,
  collectEnvironmentRouteHostnames,
  DEFAULT_DEPLOYMENT_ROUTE_PORT_BASE,
  DEFAULT_DEPLOYMENT_ROUTE_PORT_SPAN,
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
  NAMED_VOLUME_BIND_DATA_DIR,
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
export {
  authAppliesToRegistry,
  configFromOptions,
  DEFAULT_IMAGE_RESOLVE_MAX_CONCURRENT_FETCHES,
  DEFAULT_IMAGE_RESOLVE_MAX_FETCH_ATTEMPTS,
  DEFAULT_IMAGE_RESOLVE_MAX_REDIRECTS,
  DEFAULT_IMAGE_RESOLVE_MAX_SERVICES,
  DEFAULT_IMAGE_RESOLVE_REQUEST_TIMEOUT_MS,
  DEFAULT_IMAGE_RESOLVE_TOKEN_RESPONSE_MAX_BYTES,
  DEFAULT_IMAGE_RESOLVE_TOTAL_TIMEOUT_MS,
  fetchBearerToken,
  fetchValidated,
  getImageResolverConfig,
  manifestUrl,
  parseBearerChallenge,
  registryBaseUrl,
} from './image-resolver-outbound';
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
