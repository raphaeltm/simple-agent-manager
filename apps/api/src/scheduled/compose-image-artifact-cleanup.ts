// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported so existing importers keep working. A vi.mock of this path does not reach
// imports made inside the package (see packages/app-deployment/AGENTS.md).
export type { ComposeImageArtifactCleanupStats } from '@simple-agent-manager/app-deployment/scheduled';
export {
  COMPOSE_IMAGE_ARTIFACT_PREFIX,
  runComposeImageArtifactCleanup,
  runScheduledComposeImageArtifactCleanup,
} from '@simple-agent-manager/app-deployment/scheduled';
