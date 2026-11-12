// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported here so existing importers and vi.mock paths stay unchanged.
export type { DeploymentInterpolationEnv } from '@simple-agent-manager/app-deployment';
export {
  buildDeploymentEnvironmentConfigResponse,
  deleteDeploymentEnvironmentConfigVar,
  loadDeploymentBuildInterpolationEnv,
  loadDeploymentEnvironmentConfigRows,
  loadDeploymentInterpolationEnv,
  touchDeploymentConfigUpdatedAt,
  upsertDeploymentEnvironmentConfigVar,
} from '@simple-agent-manager/app-deployment';
