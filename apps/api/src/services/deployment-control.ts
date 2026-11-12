// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported here so existing importers and vi.mock paths stay unchanged.
export type {
  CreateAgentDeploymentEnvironmentResult,
  DeploymentAgentPolicy,
  DeploymentHeartbeatState,
  DeploymentMcpCaller,
  DeploymentReleaseStatusTransition,
  ObservedDeploymentState,
} from '@simple-agent-manager/app-deployment';
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
} from '@simple-agent-manager/app-deployment';
