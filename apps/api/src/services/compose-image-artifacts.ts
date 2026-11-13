// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported so existing importers keep working. A vi.mock of this path does not reach
// imports made inside the package (see packages/app-deployment/AGENTS.md).
// The two URL-signing functions keep their original signatures here and bind the worker's shared
// R2 S3 client, which also serves attachments and session snapshots.
import {
  type ComposeImageArtifactDescriptor,
  type ComposeImageArtifactDownload,
  type ComposeImageArtifactUpload,
  createComposeImageArtifactDownloads as createDownloads,
  createComposeImageArtifactUploads as createUploads,
} from '@simple-agent-manager/app-deployment';

import type { Env } from '../env';
import { getR2PresignTarget } from './r2-s3-client';

export type {
  ComposeImageArtifactDescriptor,
  ComposeImageArtifactDownload,
  ComposeImageArtifactPlatform,
  ComposeImageArtifactRequest,
  ComposeImageArtifactUpload,
} from '@simple-agent-manager/app-deployment';
export {
  getComposeImageArtifactMaxBytes,
  validateCompletedComposeImageArtifacts,
  validateComposeImageArtifactDescriptor,
} from '@simple-agent-manager/app-deployment';

// Compose artifacts have always been signed with the SDK's default checksum behaviour.
export function createComposeImageArtifactUploads(
  env: Env,
  input: Parameters<typeof createUploads>[1]
): Promise<ComposeImageArtifactUpload[]> {
  return createUploads(env, input, getR2PresignTarget(env, 'SDK_DEFAULT'));
}

export function createComposeImageArtifactDownloads(
  env: Env,
  artifacts: ComposeImageArtifactDescriptor[]
): Promise<ComposeImageArtifactDownload[]> {
  return createDownloads(env, artifacts, getR2PresignTarget(env, 'SDK_DEFAULT'));
}
