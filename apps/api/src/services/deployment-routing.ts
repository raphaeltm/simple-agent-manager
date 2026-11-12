// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported here so existing importers and vi.mock paths stay unchanged.
export type {
  DeploymentRouteDiscovery,
  DeploymentRouteInternalDiscovery,
  DeploymentRoutePublicDiscovery,
  DeploymentRouteTarget,
  DeploymentRouteTargetOptions,
  PublicRouteInput,
} from '@simple-agent-manager/app-deployment';
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
} from '@simple-agent-manager/app-deployment';
