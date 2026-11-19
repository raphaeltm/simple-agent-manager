/**
 * Cloudflare pin for the shared R2 presign client (services/r2-s3-client.ts).
 *
 * Before L20 the worker signed R2 URLs with two clients: `getR2S3Client` (attachments, session
 * snapshots; `requestChecksumCalculation: 'WHEN_REQUIRED'`) and app-deployment's `getS3Client`
 * (compose image artifacts with `WHEN_SUPPORTED`, build contexts with `WHEN_REQUIRED`). Each test
 * here rebuilds the former client exactly as main configured it, signs the same command at the
 * same instant, and requires the URL the production entry point returns to be byte-identical.
 * The env is production's shape (2026-11-18 script settings): R2_ACCESS_KEY_ID and
 * R2_SECRET_ACCESS_KEY secrets, CF_ACCOUNT_ID, R2_BUCKET_NAME, and no R2_S3_* variable.
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { generatePresignedUploadUrl } from '../../../src/services/attachment-upload';
import {
  createBuildContextDownload,
  createBuildContextUpload,
} from '../../../src/services/build-context-upload';
import {
  createComposeImageArtifactDownloads,
  createComposeImageArtifactUploads,
} from '../../../src/services/compose-image-artifacts';
import { resetR2S3ClientsForTests } from '../../../src/services/r2-s3-client';
import { generateSessionSnapshotDirectUploadUrl } from '../../../src/services/session-snapshot-direct-upload';

const ACCOUNT = 'acct123';
const BUCKET = 'sam-prod-assets';

function productionEnv(): Env {
  return {
    CF_ACCOUNT_ID: ACCOUNT,
    R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    R2_SECRET_ACCESS_KEY: 'secret-example',
    R2_BUCKET_NAME: BUCKET,
  } as Env;
}

/** The client main built, keyed by the checksum mode each caller used. */
function formerClient(requestChecksumCalculation: 'WHEN_REQUIRED' | 'WHEN_SUPPORTED') {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    requestChecksumCalculation,
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-example' },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  resetR2S3ClientsForTests();
});

describe('shared R2 presign client on Cloudflare', () => {
  it('signs attachment uploads exactly as before', async () => {
    const result = await generatePresignedUploadUrl(productionEnv(), {
      userId: 'u1',
      uploadId: 'up1',
      filename: 'report.pdf',
      size: 10,
      contentType: 'application/pdf',
    });
    const expected = await getSignedUrl(
      formerClient('WHEN_REQUIRED'),
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: result.r2Key,
        ContentLength: 10,
        ContentType: 'application/pdf',
      }),
      { expiresIn: result.expiresIn }
    );
    expect(result.uploadUrl).toBe(expected);
    expect(new URL(result.uploadUrl).host).toBe(`${BUCKET}.${ACCOUNT}.r2.cloudflarestorage.com`);
  });

  it('signs session snapshot uploads exactly as before, with and without the checksum header', async () => {
    const input = {
      key: 'session-snapshots/p1/s1/a.tar.zst',
      sizeBytes: 2048,
      sha256: 'a'.repeat(64),
      contentType: 'application/zstd',
    };
    for (const checksumHeader of [false, true]) {
      const actual = await generateSessionSnapshotDirectUploadUrl(productionEnv(), {
        ...input,
        checksumHeader,
      });
      const command = new PutObjectCommand({
        Bucket: BUCKET,
        Key: input.key,
        ContentLength: input.sizeBytes,
        ContentType: input.contentType,
        ChecksumSHA256: btoa(String.fromCharCode(...new Uint8Array(32).fill(0xaa))),
      });
      const expected = await getSignedUrl(formerClient('WHEN_REQUIRED'), command, {
        expiresIn: 15 * 60,
        ...(checksumHeader ? { unhoistableHeaders: new Set(['x-amz-checksum-sha256']) } : {}),
      });
      expect(actual, `checksumHeader=${checksumHeader}`).toBe(expected);
    }
  });

  it('signs compose image artifact uploads and downloads with the SDK default checksum mode, as before', async () => {
    const uploads = await createComposeImageArtifactUploads(productionEnv(), {
      projectId: 'p1',
      workspaceId: 'w1',
      environmentId: 'e1',
      uploadId: 'up1',
      services: [{ serviceName: 'web', sourceRef: 'nginx:1' }],
    });
    const [upload] = uploads;
    expect(upload).toBeDefined();
    const expectedUpload = await getSignedUrl(
      formerClient('WHEN_SUPPORTED'),
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: upload!.r2Key,
        ContentType: 'application/vnd.docker.image.rootfs.diff.tar',
      }),
      { expiresIn: upload!.expiresIn }
    );
    expect(upload!.uploadUrl).toBe(expectedUpload);

    const [download] = await createComposeImageArtifactDownloads(productionEnv(), [
      {
        serviceName: 'web',
        sourceRef: 'nginx:1',
        localImageRef: 'nginx:1',
        r2Key: upload!.r2Key,
        sizeBytes: 10,
        archiveSha256: 'b'.repeat(64),
        archiveType: 'docker-save',
        mediaType: 'application/vnd.docker.image.rootfs.diff.tar',
      } as never,
    ]);
    const expectedDownload = await getSignedUrl(
      formerClient('WHEN_SUPPORTED'),
      new GetObjectCommand({ Bucket: BUCKET, Key: upload!.r2Key }),
      { expiresIn: download!.downloadExpiresIn }
    );
    expect(download!.downloadUrl).toBe(expectedDownload);
  });

  it('signs build context uploads and downloads exactly as before', async () => {
    const owner = {
      id: 'job1',
      projectId: 'p1',
      environmentId: 'e1',
      workspaceId: 'w1',
      requestedBy: 'u1',
      attempt: 1,
    };
    const descriptor = { sizeBytes: 4096, sha256: 'c'.repeat(64) };
    const upload = await createBuildContextUpload(productionEnv(), owner, descriptor, 600);
    const expectedUpload = await getSignedUrl(
      formerClient('WHEN_REQUIRED'),
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: upload.r2Key,
        ContentLength: descriptor.sizeBytes,
        ContentType: 'application/zstd',
        Metadata: { sha256: descriptor.sha256 },
      }),
      { expiresIn: 600, unhoistableHeaders: new Set(['x-amz-meta-sha256']) }
    );
    expect(upload.uploadUrl).toBe(expectedUpload);

    const download = await createBuildContextDownload(productionEnv(), upload.r2Key, 300);
    const expectedDownload = await getSignedUrl(
      formerClient('WHEN_REQUIRED'),
      new GetObjectCommand({ Bucket: BUCKET, Key: upload.r2Key }),
      { expiresIn: 300 }
    );
    expect(download).toBe(expectedDownload);
  });

  it('still rejects with a configuration error when the bucket name is missing', async () => {
    await expect(
      createComposeImageArtifactUploads({ ...productionEnv(), R2_BUCKET_NAME: undefined } as Env, {
        projectId: 'p1',
        workspaceId: 'w1',
        environmentId: 'e1',
        uploadId: 'up1',
        services: [{ serviceName: 'web', sourceRef: 'nginx:1' }],
      })
    ).rejects.toThrow(/R2_BUCKET_NAME/);
  });
});
