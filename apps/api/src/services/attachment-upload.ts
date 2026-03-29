/**
 * Attachment Upload Service — R2 presigned URL generation and validation.
 *
 * Generates S3-compatible presigned PUT URLs for direct browser → R2 uploads,
 * and validates attachment existence/integrity on task submission via HEAD checks.
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ATTACHMENT_DEFAULTS, SAFE_FILENAME_REGEX } from '@simple-agent-manager/shared';
import type { TaskAttachment } from '@simple-agent-manager/shared';
import type { Env } from '../index';
import { log } from '../lib/logger';

// ---------------------------------------------------------------------------
// Configuration helpers (NaN-safe parseInt with fallback to defaults)
// ---------------------------------------------------------------------------

function parseIntOrDefault(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

function getMaxBytes(env: Env): number {
  return parseIntOrDefault(env.ATTACHMENT_UPLOAD_MAX_BYTES, ATTACHMENT_DEFAULTS.UPLOAD_MAX_BYTES);
}

function getBatchMaxBytes(env: Env): number {
  return parseIntOrDefault(env.ATTACHMENT_UPLOAD_BATCH_MAX_BYTES, ATTACHMENT_DEFAULTS.UPLOAD_BATCH_MAX_BYTES);
}

function getMaxFiles(env: Env): number {
  return parseIntOrDefault(env.ATTACHMENT_MAX_FILES, ATTACHMENT_DEFAULTS.MAX_FILES);
}

function getPresignExpiry(env: Env): number {
  return parseIntOrDefault(env.ATTACHMENT_PRESIGN_EXPIRY_SECONDS, ATTACHMENT_DEFAULTS.PRESIGN_EXPIRY_SECONDS);
}

// ---------------------------------------------------------------------------
// S3 Client (cached per credential set — Workers reuse isolates)
// ---------------------------------------------------------------------------

let _s3Client: S3Client | null = null;
let _s3ClientKey = '';

function getS3Client(env: Env): S3Client {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    throw new Error('R2 S3 credentials not configured (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CF_ACCOUNT_ID required)');
  }
  const key = `${env.CF_ACCOUNT_ID}:${env.R2_ACCESS_KEY_ID}`;
  if (!_s3Client || _s3ClientKey !== key) {
    _s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
    _s3ClientKey = key;
  }
  return _s3Client;
}

// ---------------------------------------------------------------------------
// R2 Key construction
// ---------------------------------------------------------------------------

/** Build the R2 object key for a task attachment. Scoped by userId for ownership validation. */
export function buildAttachmentR2Key(userId: string, uploadId: string, filename: string): string {
  return `temp-uploads/${userId}/${uploadId}/${filename}`;
}

// ---------------------------------------------------------------------------
// Presigned URL generation
// ---------------------------------------------------------------------------

export interface GeneratePresignedUploadOptions {
  userId: string;
  uploadId: string;
  filename: string;
  size: number;
  contentType: string;
}

/**
 * Generate a presigned PUT URL for direct browser → R2 upload.
 * Returns the URL and the R2 key.
 */
export async function generatePresignedUploadUrl(
  env: Env,
  options: GeneratePresignedUploadOptions,
): Promise<{ uploadUrl: string; r2Key: string; expiresIn: number }> {
  const { userId, uploadId, filename, size, contentType } = options;

  // Validate filename safety
  if (!SAFE_FILENAME_REGEX.test(filename)) {
    throw new Error('Unsafe filename: contains disallowed characters');
  }

  // Validate file size
  const maxBytes = getMaxBytes(env);
  if (size > maxBytes) {
    throw new Error(`File size ${size} exceeds maximum ${maxBytes} bytes`);
  }

  if (size <= 0) {
    throw new Error('File size must be positive');
  }

  const r2Key = buildAttachmentR2Key(userId, uploadId, filename);
  const bucketName = env.R2_BUCKET_NAME;
  if (!bucketName) {
    throw new Error('R2_BUCKET_NAME not configured');
  }

  const s3 = getS3Client(env);
  const expiresIn = getPresignExpiry(env);

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: r2Key,
    ContentLength: size,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn });

  log.info('attachment_upload.presigned_url_generated', {
    userId,
    uploadId,
    filename,
    size,
    r2Key,
    expiresIn,
  });

  return { uploadUrl, r2Key, expiresIn };
}

// ---------------------------------------------------------------------------
// Attachment validation (task submit time)
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate attachments at task submission time.
 *
 * Checks:
 * 1. Batch limits (file count, total size)
 * 2. Each file exists in R2 (HEAD check)
 * 3. File size matches declared size
 * 4. R2 key is scoped to the submitting userId (ownership check)
 */
export async function validateAttachments(
  env: Env,
  userId: string,
  attachments: TaskAttachment[],
): Promise<ValidationResult> {
  const errors: string[] = [];

  // Check count limit
  const maxFiles = getMaxFiles(env);
  if (attachments.length > maxFiles) {
    errors.push(`Too many attachments: ${attachments.length} exceeds maximum ${maxFiles}`);
    return { valid: false, errors };
  }

  // Check batch size
  const batchMaxBytes = getBatchMaxBytes(env);
  const totalSize = attachments.reduce((sum, a) => sum + a.size, 0);
  if (totalSize > batchMaxBytes) {
    errors.push(`Total attachment size ${totalSize} exceeds maximum ${batchMaxBytes} bytes`);
    return { valid: false, errors };
  }

  // Validate each attachment via R2 HEAD
  const headResults = await Promise.allSettled(
    attachments.map(async (attachment) => {
      const r2Key = buildAttachmentR2Key(userId, attachment.uploadId, attachment.filename);

      // Use the R2 binding (not S3) for HEAD checks — faster, no credentials needed
      const object = await env.R2.head(r2Key);
      if (!object) {
        throw new Error(`Attachment not found in R2: ${attachment.filename} (uploadId: ${attachment.uploadId})`);
      }

      // Verify size matches
      if (object.size !== attachment.size) {
        throw new Error(
          `Size mismatch for ${attachment.filename}: declared ${attachment.size}, actual ${object.size}`,
        );
      }
    }),
  );

  for (const result of headResults) {
    if (result.status === 'rejected') {
      errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Attachment cleanup (eager delete after successful transfer)
// ---------------------------------------------------------------------------

/**
 * Delete attachment objects from R2 after successful transfer to workspace.
 * Best-effort — failures are logged but don't block task execution.
 */
export async function cleanupAttachments(
  r2: R2Bucket,
  userId: string,
  attachments: TaskAttachment[],
): Promise<void> {
  const results = await Promise.allSettled(
    attachments.map(async (attachment) => {
      const r2Key = buildAttachmentR2Key(userId, attachment.uploadId, attachment.filename);
      await r2.delete(r2Key);
      log.info('attachment_upload.cleaned_up', { r2Key });
    }),
  );

  for (const result of results) {
    if (result.status === 'rejected') {
      log.error('attachment_upload.cleanup_failed', {
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
}

/**
 * Download an attachment from R2. Returns the body stream and content type.
 * Used by the Task Runner to transfer files to the workspace.
 */
export async function getAttachmentFromR2(
  r2: R2Bucket,
  userId: string,
  attachment: TaskAttachment,
): Promise<{ body: ReadableStream; contentType: string; size: number }> {
  const r2Key = buildAttachmentR2Key(userId, attachment.uploadId, attachment.filename);
  const object = await r2.get(r2Key);
  if (!object) {
    throw new Error(`Attachment not found in R2: ${r2Key}`);
  }
  return {
    body: object.body,
    contentType: object.httpMetadata?.contentType || attachment.contentType,
    size: object.size,
  };
}
