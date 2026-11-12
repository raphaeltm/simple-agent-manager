/** Re-export: this module moved to `src/app-deployment/deployment-control.ts`. */
export type {
  CreateAgentDeploymentEnvironmentResult,
  DeploymentAgentPolicy,
  DeploymentHeartbeatState,
  DeploymentMcpCaller,
  DeploymentReleaseStatusTransition,
  ObservedDeploymentState,
} from '../app-deployment';
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
} from '../app-deployment';
