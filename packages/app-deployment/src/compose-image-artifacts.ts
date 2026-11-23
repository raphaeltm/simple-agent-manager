import { parsePositiveInt } from '@simple-agent-manager/worker-core';

import type { AppDeploymentEnv } from './env';
import type { ObjectUrlSigner } from './object-url-signer';

const DEFAULT_UPLOAD_EXPIRY_SECONDS = 900;
const DEFAULT_DOWNLOAD_EXPIRY_SECONDS = 900;
export const DEFAULT_COMPOSE_IMAGE_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const COMPOSE_IMAGE_ARTIFACT_ARCHIVE_TYPE = 'docker-save';
export const COMPOSE_IMAGE_ARTIFACT_MEDIA_TYPE = 'application/vnd.docker.image.rootfs.diff.tar';

export interface ComposeImageArtifactRequest {
  serviceName: string;
  sourceRef: string;
  localImageRef?: string;
  platform?: ComposeImageArtifactPlatform;
}

export interface ComposeImageArtifactPlatform {
  architecture?: string;
  os?: string;
  variant?: string;
}

export interface ComposeImageArtifactUpload {
  serviceName: string;
  sourceRef: string;
  localImageRef: string;
  r2Key: string;
  uploadUrl: string;
  expiresIn: number;
  maxBytes: number;
  archiveType: string;
  mediaType: string;
  platform?: ComposeImageArtifactPlatform;
}

export interface ComposeImageArtifactDescriptor {
  serviceName: string;
  sourceRef: string;
  localImageRef: string;
  r2Key: string;
  sizeBytes: number;
  archiveSha256: string;
  archiveType: string;
  mediaType: string;
  platform?: ComposeImageArtifactPlatform;
}

export interface ComposeImageArtifactDownload extends ComposeImageArtifactDescriptor {
  downloadUrl: string;
  downloadExpiresIn: number;
}

export function getComposeImageArtifactMaxBytes(env: AppDeploymentEnv): number {
  return parsePositiveInt(
    env.COMPOSE_IMAGE_ARTIFACT_MAX_BYTES,
    DEFAULT_COMPOSE_IMAGE_ARTIFACT_MAX_BYTES
  );
}

/**
 * The artifact size limit for uploads through `signer`: the configured maximum, lowered to the
 * signer's own per-request bound (a self-hosted box carries at most 1 GiB per request). The init
 * response reports it, so the VM agent refuses a larger archive before uploading it.
 */
export function composeImageArtifactMaxBytesFor(
  env: AppDeploymentEnv,
  signer: Pick<ObjectUrlSigner, 'maxPutBytes'>
): number {
  const configured = getComposeImageArtifactMaxBytes(env);
  return signer.maxPutBytes === undefined ? configured : Math.min(configured, signer.maxPutBytes);
}

function getUploadExpiry(env: AppDeploymentEnv): number {
  return parsePositiveInt(
    env.COMPOSE_IMAGE_ARTIFACT_UPLOAD_URL_TTL_SECONDS,
    DEFAULT_UPLOAD_EXPIRY_SECONDS
  );
}

function getDownloadExpiry(env: AppDeploymentEnv): number {
  return parsePositiveInt(
    env.COMPOSE_IMAGE_ARTIFACT_DOWNLOAD_URL_TTL_SECONDS,
    DEFAULT_DOWNLOAD_EXPIRY_SECONDS
  );
}

export function buildComposeImageArtifactKey(
  projectId: string,
  workspaceId: string,
  environmentId: string,
  uploadId: string,
  serviceName: string
): string {
  return [
    'compose-image-artifacts',
    safeKeyPart(projectId),
    safeKeyPart(environmentId),
    safeKeyPart(workspaceId),
    safeKeyPart(uploadId),
    `${safeKeyPart(serviceName)}.docker-save.tar`,
  ].join('/');
}

export function buildLocalImageRef(
  environmentId: string,
  releaseId: string,
  serviceName: string
): string {
  return `sam-${safeDockerPart(environmentId)}-${safeDockerPart(serviceName)}:${safeDockerPart(releaseId)}`;
}

export function validateComposeImageArtifactDescriptor(
  artifact: unknown,
  expected: { projectId: string; workspaceId?: string; environmentId: string; maxBytes: number }
): ComposeImageArtifactDescriptor {
  if (!artifact || typeof artifact !== 'object') {
    throw new Error('Artifact descriptor must be an object');
  }
  const value = artifact as Record<string, unknown>;
  const serviceName = requiredString(value.serviceName, 'serviceName');
  const sourceRef = requiredString(value.sourceRef, 'sourceRef');
  const localImageRef = requiredString(value.localImageRef, 'localImageRef');
  const r2Key = requiredString(value.r2Key, 'r2Key');
  const archiveSha256 = requiredString(value.archiveSha256, 'archiveSha256').toLowerCase();
  const archiveType = requiredString(value.archiveType, 'archiveType');
  const mediaType = requiredString(value.mediaType, 'mediaType');
  const sizeBytesRaw = value.sizeBytes;

  if (
    typeof sizeBytesRaw !== 'number' ||
    !Number.isSafeInteger(sizeBytesRaw) ||
    sizeBytesRaw <= 0
  ) {
    throw new Error(`Artifact ${serviceName} must declare a positive integer sizeBytes`);
  }
  const sizeBytes = sizeBytesRaw;
  if (sizeBytes > expected.maxBytes) {
    throw new Error(
      `Artifact ${serviceName} size ${sizeBytes} exceeds maximum ${expected.maxBytes} bytes`
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(archiveSha256)) {
    throw new Error(`Artifact ${serviceName} archiveSha256 must be sha256:<64 hex chars>`);
  }
  if (archiveType !== COMPOSE_IMAGE_ARTIFACT_ARCHIVE_TYPE) {
    throw new Error(`Artifact ${serviceName} archiveType ${archiveType} is not supported`);
  }
  if (mediaType !== COMPOSE_IMAGE_ARTIFACT_MEDIA_TYPE) {
    throw new Error(`Artifact ${serviceName} mediaType ${mediaType} is not supported`);
  }

  const requiredPrefix =
    [
      'compose-image-artifacts',
      safeKeyPart(expected.projectId),
      safeKeyPart(expected.environmentId),
    ].join('/') + '/';
  if (!r2Key.startsWith(requiredPrefix)) {
    throw new Error(`Artifact ${serviceName} R2 key is outside the project/environment scope`);
  }
  if (expected.workspaceId) {
    const workspaceSegment = `/${safeKeyPart(expected.workspaceId)}/`;
    if (!r2Key.includes(workspaceSegment)) {
      throw new Error(`Artifact ${serviceName} R2 key is outside the workspace scope`);
    }
  }

  const platform = normalizePlatform(value.platform);
  return {
    serviceName,
    sourceRef,
    localImageRef,
    r2Key,
    sizeBytes,
    archiveSha256,
    archiveType,
    mediaType,
    ...(platform ? { platform } : {}),
  };
}

export async function createComposeImageArtifactUploads(
  env: AppDeploymentEnv,
  input: {
    projectId: string;
    workspaceId: string;
    environmentId: string;
    uploadId: string;
    services: ComposeImageArtifactRequest[];
  },
  signer: ObjectUrlSigner
): Promise<ComposeImageArtifactUpload[]> {
  const expiresIn = getUploadExpiry(env);
  const maxBytes = composeImageArtifactMaxBytesFor(env, signer);

  return Promise.all(
    input.services.map(async (service) => {
      const serviceName = cleanString(service.serviceName);
      const sourceRef = cleanString(service.sourceRef);
      if (!serviceName || !sourceRef) {
        throw new Error('Artifact upload services must include serviceName and sourceRef');
      }
      const r2Key = buildComposeImageArtifactKey(
        input.projectId,
        input.workspaceId,
        input.environmentId,
        input.uploadId,
        serviceName
      );
      return {
        serviceName,
        sourceRef,
        localImageRef: cleanString(service.localImageRef) || sourceRef,
        r2Key,
        uploadUrl: await signer.putUrl(r2Key, {
          expiresIn,
          contentType: COMPOSE_IMAGE_ARTIFACT_MEDIA_TYPE,
          maxBytes,
          owner: { projectId: input.projectId, workspaceId: input.workspaceId },
        }),
        expiresIn,
        maxBytes,
        archiveType: COMPOSE_IMAGE_ARTIFACT_ARCHIVE_TYPE,
        mediaType: COMPOSE_IMAGE_ARTIFACT_MEDIA_TYPE,
        ...(service.platform ? { platform: service.platform } : {}),
      };
    })
  );
}

export async function validateCompletedComposeImageArtifacts(
  env: AppDeploymentEnv,
  artifacts: ComposeImageArtifactDescriptor[]
): Promise<void> {
  await Promise.all(
    artifacts.map(async (artifact) => {
      const object = await env.R2.head(artifact.r2Key);
      if (!object) {
        throw new Error(`Artifact ${artifact.serviceName} was not found in R2`);
      }
      if (object.size !== artifact.sizeBytes) {
        throw new Error(
          `Artifact ${artifact.serviceName} size mismatch: declared ${artifact.sizeBytes}, actual ${object.size}`
        );
      }
    })
  );
}

export async function createComposeImageArtifactDownloads(
  env: AppDeploymentEnv,
  artifacts: ComposeImageArtifactDescriptor[],
  signer: ObjectUrlSigner
): Promise<ComposeImageArtifactDownload[]> {
  const downloadExpiresIn = getDownloadExpiry(env);

  return Promise.all(
    artifacts.map(async (artifact) => ({
      ...artifact,
      downloadUrl: await signer.getUrl(artifact.r2Key, { expiresIn: downloadExpiresIn }),
      downloadExpiresIn,
    }))
  );
}

function requiredString(value: unknown, field: string): string {
  const cleaned = cleanString(value);
  if (!cleaned) {
    throw new Error(`Artifact descriptor is missing ${field}`);
  }
  return cleaned;
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePlatform(value: unknown): ComposeImageArtifactPlatform | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const platform: ComposeImageArtifactPlatform = {};
  for (const key of ['architecture', 'os', 'variant'] as const) {
    const cleaned = cleanString(raw[key]);
    if (cleaned) platform[key] = cleaned;
  }
  return Object.keys(platform).length > 0 ? platform : undefined;
}

function safeKeyPart(value: string): string {
  return cleanString(value).replace(/[^a-zA-Z0-9._=-]/g, '_') || 'unknown';
}

function safeDockerPart(value: string): string {
  const cleaned = cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-');
  return cleaned.replace(/^-+|-+$/g, '') || 'unknown';
}
