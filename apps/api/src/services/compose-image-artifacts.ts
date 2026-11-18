// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported so existing importers keep working. A vi.mock of this path does not reach
// imports made inside the package (see packages/app-deployment/AGENTS.md).
export type {
  ComposeImageArtifactDescriptor,
  ComposeImageArtifactDownload,
  ComposeImageArtifactPlatform,
  ComposeImageArtifactRequest,
  ComposeImageArtifactUpload,
} from '@simple-agent-manager/app-deployment';
export {
  createComposeImageArtifactDownloads,
  createComposeImageArtifactUploads,
  getComposeImageArtifactMaxBytes,
  validateCompletedComposeImageArtifacts,
  validateComposeImageArtifactDescriptor,
} from '@simple-agent-manager/app-deployment';
