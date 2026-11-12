/** Re-export: this module moved to `src/app-deployment/compose-image-artifacts.ts`. */
export type {
  ComposeImageArtifactDescriptor,
  ComposeImageArtifactDownload,
  ComposeImageArtifactPlatform,
  ComposeImageArtifactRequest,
  ComposeImageArtifactUpload,
} from '../app-deployment';
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
} from '../app-deployment';
