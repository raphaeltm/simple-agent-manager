// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported so existing importers keep working. A vi.mock of this path does not reach
// imports made inside the package (see packages/app-deployment/AGENTS.md).
export type {
  DeploymentRouteDiscovery,
  DeploymentRouteInternalDiscovery,
  DeploymentRoutePublicDiscovery,
  DeploymentRouteTarget,
  DeploymentRouteTargetOptions,
  PublicRouteInput,
} from '@simple-agent-manager/app-deployment';
export {
  buildComposePublishRouteDiscovery,
  buildDeploymentRouteTargets,
  buildReleaseRouteDiscovery,
  collectEnvironmentRouteHostnames,
  environmentPortOffset,
  extractComposeRouteHints,
} from '@simple-agent-manager/app-deployment';
