// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported so existing importers keep working. A vi.mock of this path does not reach
// imports made inside the package (see packages/app-deployment/AGENTS.md).
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
  reconcileDeploymentReleaseStatuses,
  toDeploymentAgentPolicy,
  toObservedDeploymentState,
  uniqueDeployProfileIds,
  validateAllowedDeployProfiles,
} from '@simple-agent-manager/app-deployment';
