// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported so existing importers keep working. A vi.mock of this path does not reach
// imports made inside the package (see packages/app-deployment/AGENTS.md).
// The two URL-signing functions keep their original signatures here and bind the worker's object
// URL signer (r2-s3-client.ts): the shared R2 S3 client, or on a self-hosted box its upload route.
import {
  type ComposeImageArtifactDescriptor,
  type ComposeImageArtifactDownload,
  type ComposeImageArtifactUpload,
  createComposeImageArtifactDownloads as createDownloads,
  createComposeImageArtifactUploads as createUploads,
} from '@simple-agent-manager/app-deployment';

import type { Env } from '../env';
import { getR2ObjectUrlSigner } from './r2-s3-client';

export type {
  ComposeImageArtifactDescriptor,
  ComposeImageArtifactDownload,
  ComposeImageArtifactPlatform,
  ComposeImageArtifactRequest,
  ComposeImageArtifactUpload,
} from '@simple-agent-manager/app-deployment';
export {
  buildComposeImageArtifactKey,
  COMPOSE_IMAGE_ARTIFACT_ARCHIVE_TYPE,
  COMPOSE_IMAGE_ARTIFACT_MEDIA_TYPE,
  composeImageArtifactMaxBytesFor,
  getComposeImageArtifactMaxBytes,
  validateCompletedComposeImageArtifacts,
  validateComposeImageArtifactDescriptor,
} from '@simple-agent-manager/app-deployment';

// Compose artifacts have always been signed with the SDK's default checksum behaviour. Async so a
// missing signer rejects the returned promise (a 503 naming the settings) instead of throwing.
export async function createComposeImageArtifactUploads(
  env: Env,
  input: Parameters<typeof createUploads>[1]
): Promise<ComposeImageArtifactUpload[]> {
  return createUploads(env, input, getR2ObjectUrlSigner(env, 'SDK_DEFAULT'));
}

export async function createComposeImageArtifactDownloads(
  env: Env,
  artifacts: ComposeImageArtifactDescriptor[]
): Promise<ComposeImageArtifactDownload[]> {
  return createDownloads(env, artifacts, getR2ObjectUrlSigner(env, 'SDK_DEFAULT'));
}
