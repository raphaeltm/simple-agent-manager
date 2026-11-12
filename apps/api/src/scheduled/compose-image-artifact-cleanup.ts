// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported here so existing importers and vi.mock paths stay unchanged.
export type {
  ComposeImageArtifactCleanupStats,
} from '@simple-agent-manager/app-deployment/scheduled';
export {
  COMPOSE_IMAGE_ARTIFACT_PREFIX,
  runComposeImageArtifactCleanup,
  runScheduledComposeImageArtifactCleanup,
} from '@simple-agent-manager/app-deployment/scheduled';
