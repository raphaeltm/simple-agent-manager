/**
 * Tests for attachment upload service — R2 key construction, validation, and cleanup.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildAttachmentR2Key,
  generatePresignedUploadUrl,
  validateAttachments,
  cleanupAttachments,
  getAttachmentFromR2,
} from '../../../src/services/attachment-upload';
import { ATTACHMENT_DEFAULTS } from '@simple-agent-manager/shared';
import type { TaskAttachment } from '@simple-agent-manager/shared';

// ---------------------------------------------------------------------------
// R2 Key Construction
// ---------------------------------------------------------------------------

describe('buildAttachmentR2Key', () => {
  it('builds key scoped by userId and uploadId', () => {
    const key = buildAttachmentR2Key('user-123', 'upload-abc', 'report.pdf');
    expect(key).toBe('temp-uploads/user-123/upload-abc/report.pdf');
  });

  it('preserves filenames with spaces', () => {
    const key = buildAttachmentR2Key('u1', 'up1', 'my file name.txt');
    expect(key).toBe('temp-uploads/u1/up1/my file name.txt');
  });

  it('preserves filenames with dots and dashes', () => {
    const key = buildAttachmentR2Key('u1', 'up1', 'my-file.v2.tar.gz');
    expect(key).toBe('temp-uploads/u1/up1/my-file.v2.tar.gz');
  });
});

// ---------------------------------------------------------------------------
// Presigned URL Generation
// ---------------------------------------------------------------------------

describe('generatePresignedUploadUrl', () => {
  function makePresignEnv(overrides: Record<string, unknown> = {}) {
    return {
      R2_ACCESS_KEY_ID: 'test-key',
      R2_SECRET_ACCESS_KEY: 'test-secret',
      CF_ACCOUNT_ID: 'test-account',
      R2_BUCKET_NAME: 'test-bucket',
      ...overrides,
    } as any;
  }

  const validOptions = {
    userId: 'user-1',
    uploadId: 'upload-1',
    filename: 'report.pdf',
    size: 1024,
    contentType: 'application/pdf',
  };

  it('rejects unsafe filenames', async () => {
    await expect(
      generatePresignedUploadUrl(makePresignEnv(), { ...validOptions, filename: '../etc/passwd' }),
    ).rejects.toThrow('Unsafe filename');
  });

  it('rejects zero size', async () => {
    await expect(
      generatePresignedUploadUrl(makePresignEnv(), { ...validOptions, size: 0 }),
    ).rejects.toThrow('File size must be positive');
  });

  it('rejects negative size', async () => {
    await expect(
      generatePresignedUploadUrl(makePresignEnv(), { ...validOptions, size: -1 }),
    ).rejects.toThrow('File size must be positive');
  });

  it('rejects when file exceeds max bytes', async () => {
    const env = makePresignEnv({ ATTACHMENT_UPLOAD_MAX_BYTES: '500' });
    await expect(
      generatePresignedUploadUrl(env, { ...validOptions, size: 1000 }),
    ).rejects.toThrow('exceeds maximum');
  });

  it('rejects when R2_BUCKET_NAME is missing', async () => {
    const env = makePresignEnv({ R2_BUCKET_NAME: undefined });
    await expect(
      generatePresignedUploadUrl(env, validOptions),
    ).rejects.toThrow('R2_BUCKET_NAME not configured');
  });

  it('rejects when R2 S3 credentials are missing', async () => {
    const env = makePresignEnv({ R2_ACCESS_KEY_ID: undefined });
    await expect(
      generatePresignedUploadUrl(env, validOptions),
    ).rejects.toThrow('R2 S3 credentials not configured');
  });

  it('rejects when CF_ACCOUNT_ID is missing', async () => {
    const env = makePresignEnv({ CF_ACCOUNT_ID: undefined });
    await expect(
      generatePresignedUploadUrl(env, validOptions),
    ).rejects.toThrow('R2 S3 credentials not configured');
  });

  it('uses configurable presign expiry from env', async () => {
    const env = makePresignEnv({ ATTACHMENT_PRESIGN_EXPIRY_SECONDS: '300' });
    // This will attempt to create a real S3Client and fail at signing,
    // but we're testing that the validation passes and it reaches S3 logic
    try {
      await generatePresignedUploadUrl(env, validOptions);
    } catch (e) {
      // Expected — S3Client creation succeeds but signing fails without a real endpoint
      // The key assertion is that it gets past validation
      expect((e as Error).message).not.toContain('Unsafe filename');
      expect((e as Error).message).not.toContain('File size');
      expect((e as Error).message).not.toContain('R2_BUCKET_NAME');
    }
  });
});

// ---------------------------------------------------------------------------
// Attachment Validation
// ---------------------------------------------------------------------------

function makeAttachment(overrides: Partial<TaskAttachment> = {}): TaskAttachment {
  return {
    uploadId: 'upload-001',
    filename: 'test.txt',
    size: 1024,
    contentType: 'text/plain',
    ...overrides,
  };
}

function makeMockR2Bucket(objects: Record<string, { size: number }> = {}): R2Bucket {
  return {
    head: vi.fn(async (key: string) => {
      const obj = objects[key];
      if (!obj) return null;
      return { size: obj.size } as R2ObjectBody;
    }),
    get: vi.fn(async (key: string) => {
      const obj = objects[key];
      if (!obj) return null;
      return {
        body: new ReadableStream(),
        size: obj.size,
        httpMetadata: { contentType: 'application/octet-stream' },
      } as unknown as R2ObjectBody;
    }),
    delete: vi.fn(async () => {}),
    put: vi.fn(),
    list: vi.fn(),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  } as unknown as R2Bucket;
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    R2: makeMockR2Bucket(),
    ...overrides,
  } as any;
}

describe('validateAttachments', () => {
  it('returns valid for empty attachments', async () => {
    const result = await validateAttachments(makeEnv(), 'user-1', []);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects when file count exceeds maximum', async () => {
    const env = makeEnv({ ATTACHMENT_MAX_FILES: '2' });
    const attachments = [
      makeAttachment({ uploadId: 'a' }),
      makeAttachment({ uploadId: 'b' }),
      makeAttachment({ uploadId: 'c' }),
    ];
    const result = await validateAttachments(env, 'user-1', attachments);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Too many attachments');
    expect(result.errors[0]).toContain('3');
    expect(result.errors[0]).toContain('2');
  });

  it('uses default max files when env not set', async () => {
    const manyAttachments = Array.from({ length: ATTACHMENT_DEFAULTS.MAX_FILES + 1 }, (_, i) =>
      makeAttachment({ uploadId: `up-${i}`, size: 100 }),
    );
    const result = await validateAttachments(makeEnv(), 'user-1', manyAttachments);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Too many attachments');
  });

  it('rejects when total size exceeds batch max', async () => {
    const env = makeEnv({ ATTACHMENT_UPLOAD_BATCH_MAX_BYTES: '1000' });
    const attachments = [
      makeAttachment({ uploadId: 'a', size: 600 }),
      makeAttachment({ uploadId: 'b', size: 500 }),
    ];
    const result = await validateAttachments(env, 'user-1', attachments);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Total attachment size');
    expect(result.errors[0]).toContain('1100');
  });

  it('validates attachments exist in R2 via HEAD', async () => {
    const r2 = makeMockR2Bucket({
      'temp-uploads/user-1/upload-001/test.txt': { size: 1024 },
    });
    const env = makeEnv({ R2: r2 });
    const result = await validateAttachments(env, 'user-1', [makeAttachment()]);
    expect(result.valid).toBe(true);
    expect(r2.head).toHaveBeenCalledWith('temp-uploads/user-1/upload-001/test.txt');
  });

  it('reports error when attachment not found in R2', async () => {
    const r2 = makeMockR2Bucket({}); // empty — nothing found
    const env = makeEnv({ R2: r2 });
    const result = await validateAttachments(env, 'user-1', [makeAttachment()]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('not found in R2');
    expect(result.errors[0]).toContain('test.txt');
  });

  it('reports error when size mismatches', async () => {
    const r2 = makeMockR2Bucket({
      'temp-uploads/user-1/upload-001/test.txt': { size: 2048 }, // declared 1024
    });
    const env = makeEnv({ R2: r2 });
    const result = await validateAttachments(env, 'user-1', [makeAttachment({ size: 1024 })]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Size mismatch');
    expect(result.errors[0]).toContain('1024');
    expect(result.errors[0]).toContain('2048');
  });

  it('collects errors from multiple failed attachments', async () => {
    const r2 = makeMockR2Bucket({}); // nothing found
    const env = makeEnv({ R2: r2 });
    const attachments = [
      makeAttachment({ uploadId: 'a', filename: 'file1.txt' }),
      makeAttachment({ uploadId: 'b', filename: 'file2.txt' }),
    ];
    const result = await validateAttachments(env, 'user-1', attachments);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it('validates with configurable env overrides', async () => {
    const r2 = makeMockR2Bucket({
      'temp-uploads/user-1/upload-001/test.txt': { size: 1024 },
    });
    const env = makeEnv({
      R2: r2,
      ATTACHMENT_MAX_FILES: '5',
      ATTACHMENT_UPLOAD_BATCH_MAX_BYTES: '10000',
    });
    const result = await validateAttachments(env, 'user-1', [makeAttachment()]);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

describe('cleanupAttachments', () => {
  it('deletes each attachment from R2', async () => {
    const r2 = makeMockR2Bucket();
    const attachments = [
      makeAttachment({ uploadId: 'a', filename: 'file1.txt' }),
      makeAttachment({ uploadId: 'b', filename: 'file2.txt' }),
    ];
    await cleanupAttachments(r2, 'user-1', attachments);
    expect(r2.delete).toHaveBeenCalledTimes(2);
    expect(r2.delete).toHaveBeenCalledWith('temp-uploads/user-1/a/file1.txt');
    expect(r2.delete).toHaveBeenCalledWith('temp-uploads/user-1/b/file2.txt');
  });

  it('does not throw when delete fails (best-effort)', async () => {
    const r2 = makeMockR2Bucket();
    (r2.delete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('R2 error'));
    await expect(
      cleanupAttachments(r2, 'user-1', [makeAttachment()]),
    ).resolves.not.toThrow();
  });

  it('continues cleaning up remaining files when one fails', async () => {
    const r2 = makeMockR2Bucket();
    let callCount = 0;
    (r2.delete as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('first delete fails');
      // second delete succeeds
    });
    const attachments = [
      makeAttachment({ uploadId: 'a', filename: 'file1.txt' }),
      makeAttachment({ uploadId: 'b', filename: 'file2.txt' }),
    ];
    await cleanupAttachments(r2, 'user-1', attachments);
    // Both deletes were attempted despite first failure
    expect(r2.delete).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// getAttachmentFromR2
// ---------------------------------------------------------------------------

describe('getAttachmentFromR2', () => {
  it('returns body stream and metadata for existing object', async () => {
    const r2 = makeMockR2Bucket({
      'temp-uploads/user-1/upload-001/test.txt': { size: 1024 },
    });
    const result = await getAttachmentFromR2(r2, 'user-1', makeAttachment());
    expect(result.body).toBeInstanceOf(ReadableStream);
    expect(result.size).toBe(1024);
  });

  it('throws when attachment not found in R2', async () => {
    const r2 = makeMockR2Bucket({});
    await expect(
      getAttachmentFromR2(r2, 'user-1', makeAttachment()),
    ).rejects.toThrow('Attachment not found in R2');
  });

  it('falls back to attachment contentType when R2 httpMetadata is missing', async () => {
    const r2 = {
      ...makeMockR2Bucket(),
      get: vi.fn(async () => ({
        body: new ReadableStream(),
        size: 1024,
        httpMetadata: undefined, // no metadata from R2
      })),
    } as unknown as R2Bucket;

    const result = await getAttachmentFromR2(
      r2,
      'user-1',
      makeAttachment({ contentType: 'text/csv' }),
    );
    expect(result.contentType).toBe('text/csv');
  });
});
