/** Re-export: this module moved to `src/app-deployment/deployment-routing.ts`. */
export type {
  DeploymentRouteDiscovery,
  DeploymentRouteInternalDiscovery,
  DeploymentRoutePublicDiscovery,
  DeploymentRouteTarget,
  DeploymentRouteTargetOptions,
  PublicRouteInput,
} from '../app-deployment';
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
} from '../app-deployment';
