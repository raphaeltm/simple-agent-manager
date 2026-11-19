// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported so existing importers keep working. A vi.mock of this path does not reach
// imports made inside the package (see packages/app-deployment/AGENTS.md).
export type { DeploymentInterpolationEnv } from '@simple-agent-manager/app-deployment';
export {
  buildDeploymentEnvironmentConfigResponse,
  deleteDeploymentEnvironmentConfigVar,
  loadDeploymentBuildInterpolationEnv,
  loadDeploymentEnvironmentConfigRows,
  loadDeploymentInterpolationEnv,
  upsertDeploymentEnvironmentConfigVar,
} from '@simple-agent-manager/app-deployment';
