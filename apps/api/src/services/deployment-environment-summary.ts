// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported here so existing importers and vi.mock paths stay unchanged.
export type { DeploymentReleaseSubmittedBy } from '@simple-agent-manager/app-deployment';
export {
  buildDeploymentEnvironmentResponse,
  listRoutedCustomDomainHostnames,
  parseReleaseSubmittedByJson,
  toReleaseSubmittedBy,
} from '@simple-agent-manager/app-deployment';
