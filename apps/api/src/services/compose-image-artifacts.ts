import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';

const DEFAULT_UPLOAD_EXPIRY_SECONDS = 900;
const DEFAULT_DOWNLOAD_EXPIRY_SECONDS = 900;
export const DEFAULT_COMPOSE_IMAGE_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const COMPOSE_IMAGE_ARTIFACT_ARCHIVE_TYPE = 'docker-save';
export const COMPOSE_IMAGE_ARTIFACT_MEDIA_TYPE = 'application/vnd.docker.image.rootfs.diff.tar';

let s3Client: S3Client | null = null;
let s3ClientKey = '';

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

export function getComposeImageArtifactMaxBytes(env: Env): number {
  return parsePositiveInt(
    env.COMPOSE_IMAGE_ARTIFACT_MAX_BYTES,
    DEFAULT_COMPOSE_IMAGE_ARTIFACT_MAX_BYTES
  );
}

function getUploadExpiry(env: Env): number {
  return parsePositiveInt(
    env.COMPOSE_IMAGE_ARTIFACT_UPLOAD_URL_TTL_SECONDS,
    DEFAULT_UPLOAD_EXPIRY_SECONDS
  );
}

function getDownloadExpiry(env: Env): number {
  return parsePositiveInt(
    env.COMPOSE_IMAGE_ARTIFACT_DOWNLOAD_URL_TTL_SECONDS,
    DEFAULT_DOWNLOAD_EXPIRY_SECONDS
  );
}

function getS3Client(env: Env): S3Client {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    throw new Error(
      'R2 S3 credentials not configured (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CF_ACCOUNT_ID required)'
    );
  }
  const key = `${env.CF_ACCOUNT_ID}:${env.R2_ACCESS_KEY_ID}`;
  if (!s3Client || s3ClientKey !== key) {
    s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
    s3ClientKey = key;
  }
  return s3Client;
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

  if (typeof sizeBytesRaw !== 'number' || !Number.isSafeInteger(sizeBytesRaw) || sizeBytesRaw <= 0) {
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

  const requiredPrefix = [
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
  env: Env,
  input: {
    projectId: string;
    workspaceId: string;
    environmentId: string;
    uploadId: string;
    services: ComposeImageArtifactRequest[];
  }
): Promise<ComposeImageArtifactUpload[]> {
  const bucket = env.R2_BUCKET_NAME;
  if (!bucket) {
    throw new Error('R2_BUCKET_NAME not configured');
  }
  const s3 = getS3Client(env);
  const expiresIn = getUploadExpiry(env);
  const maxBytes = getComposeImageArtifactMaxBytes(env);

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
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: r2Key,
        ContentType: COMPOSE_IMAGE_ARTIFACT_MEDIA_TYPE,
      });
      return {
        serviceName,
        sourceRef,
        localImageRef: cleanString(service.localImageRef) || sourceRef,
        r2Key,
        uploadUrl: await getSignedUrl(s3, command, { expiresIn }),
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
  env: Env,
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
  env: Env,
  artifacts: ComposeImageArtifactDescriptor[]
): Promise<ComposeImageArtifactDownload[]> {
  const bucket = env.R2_BUCKET_NAME;
  if (!bucket) {
    throw new Error('R2_BUCKET_NAME not configured');
  }
  const s3 = getS3Client(env);
  const downloadExpiresIn = getDownloadExpiry(env);

  return Promise.all(
    artifacts.map(async (artifact) => ({
      ...artifact,
      downloadUrl: await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: bucket, Key: artifact.r2Key }),
        { expiresIn: downloadExpiresIn }
      ),
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
  const cleaned = cleanString(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
  return cleaned.replace(/^-+|-+$/g, '') || 'unknown';
}
