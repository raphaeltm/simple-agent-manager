import { afterEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import {
  createBuildContextDownload,
  createBuildContextUpload,
} from '../../../src/services/build-context-upload';
import { resetR2S3ClientsForTests } from '../../../src/services/r2-s3-client';

// Real AWS presigner and real S3Client through the worker shim: the build-context upload is signed
// by the shared R2 S3 client (getR2PresignTarget, WHEN_REQUIRED), as compose artifacts are.

const credentials = { R2_ACCESS_KEY_ID: 'AKIDEXAMPLE', R2_SECRET_ACCESS_KEY: 'secret-example' };

const OWNER = {
  id: 'job',
  projectId: 'project',
  environmentId: 'env',
  workspaceId: 'ws',
  requestedBy: 'user',
  attempt: 3,
};
const DESCRIPTOR = { sizeBytes: 42, sha256: 'a'.repeat(64) };
const KEY = 'compose-build-contexts/project/env/job/3.tar.zst';

afterEach(() => resetR2S3ClientsForTests());

describe('createBuildContextUpload (worker shim)', () => {
  it('Cloudflare: signs a virtual-host URL for the unprefixed key without checksum parameters', async () => {
    const env = { ...credentials, CF_ACCOUNT_ID: 'acct123', R2_BUCKET_NAME: 'sam-assets' } as Env;

    const slot = await createBuildContextUpload(env, OWNER, DESCRIPTOR, 300);

    const url = new URL(slot.uploadUrl);
    expect(url.host).toBe('sam-assets.acct123.r2.cloudflarestorage.com');
    expect(url.pathname).toBe(`/${KEY}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.has('x-amz-checksum-crc32')).toBe(false);
    expect(url.searchParams.has('x-amz-sdk-checksum-algorithm')).toBe(false);
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual([
      'content-length',
      'host',
      'x-amz-meta-sha256',
    ]);
    expect(slot.r2Key).toBe(KEY);
  });

  it('operator store: signs <bucket>/<prefix><key> on the operator host and returns the binding key', async () => {
    const env = {
      ...credentials,
      R2_BUCKET_NAME: 'sam-assets',
      R2_S3_ENDPOINT: 'https://s3.example.test',
      R2_S3_BUCKET: 'celld-fleet',
      R2_S3_KEY_PREFIX: 'r2/sam-assets/',
      // Required with R2_S3_ENDPOINT since L20 (r2-presign-config.ts).
      R2_S3_REGION: 'auto',
    } as Env;

    const slot = await createBuildContextUpload(env, OWNER, DESCRIPTOR, 300);

    const url = new URL(slot.uploadUrl);
    expect(url.host).toBe('s3.example.test');
    expect(url.pathname).toBe(`/celld-fleet/r2/sam-assets/${KEY}`);
    // verifyBuildContextObject heads this key through the R2 binding, so it stays unprefixed.
    expect(slot.r2Key).toBe(KEY);
  });

  it('rejects (does not throw synchronously) when R2 presigning is not configured', async () => {
    const env = { R2_BUCKET_NAME: 'sam-assets' } as Env;
    const result = createBuildContextUpload(env, OWNER, DESCRIPTOR, 300);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toThrow(/R2 S3 credentials not configured/);
  });
});

describe('createBuildContextDownload (worker shim)', () => {
  it.each([
    [
      { CF_ACCOUNT_ID: 'acct123', R2_BUCKET_NAME: 'sam-assets' },
      'sam-assets.acct123.r2.cloudflarestorage.com',
      `/${KEY}`,
    ],
    [
      {
        R2_BUCKET_NAME: 'sam-assets',
        R2_S3_ENDPOINT: 'https://s3.example.test',
        R2_S3_BUCKET: 'celld-fleet',
        R2_S3_KEY_PREFIX: 'r2/sam-assets/',
        R2_S3_REGION: 'auto',
      },
      's3.example.test',
      `/celld-fleet/r2/sam-assets/${KEY}`,
    ],
  ])('signs the download through the same store as the upload: %j', async (store, host, path) => {
    const env = { ...credentials, ...store } as Env;
    const upload = await createBuildContextUpload(env, OWNER, DESCRIPTOR, 300);
    const download = new URL(await createBuildContextDownload(env, upload.r2Key, 300));
    expect(download.host).toBe(host);
    expect(download.pathname).toBe(path);
    expect(download.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(download.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
  });
});
