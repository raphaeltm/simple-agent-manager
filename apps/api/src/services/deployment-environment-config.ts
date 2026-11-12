/** Re-export: this module moved to `src/app-deployment/deployment-environment-config.ts`. */
export type { DeploymentInterpolationEnv } from '../app-deployment';
export {
  buildDeploymentEnvironmentConfigResponse,
  deleteDeploymentEnvironmentConfigVar,
  loadDeploymentBuildInterpolationEnv,
  loadDeploymentEnvironmentConfigRows,
  loadDeploymentInterpolationEnv,
  touchDeploymentConfigUpdatedAt,
  upsertDeploymentEnvironmentConfigVar,
} from '../app-deployment';
