// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported here so existing importers and vi.mock paths stay unchanged.
export type {
  ComposeImageArtifactDescriptor,
  ComposeImageArtifactDownload,
  ComposeImageArtifactPlatform,
  ComposeImageArtifactRequest,
  ComposeImageArtifactUpload,
} from '@simple-agent-manager/app-deployment';
export {
  buildComposeImageArtifactKey,
  buildLocalImageRef,
  COMPOSE_IMAGE_ARTIFACT_ARCHIVE_TYPE,
  COMPOSE_IMAGE_ARTIFACT_MEDIA_TYPE,
  createComposeImageArtifactDownloads,
  createComposeImageArtifactUploads,
  DEFAULT_COMPOSE_IMAGE_ARTIFACT_MAX_BYTES,
  getComposeImageArtifactMaxBytes,
  validateCompletedComposeImageArtifacts,
  validateComposeImageArtifactDescriptor,
} from '@simple-agent-manager/app-deployment';
