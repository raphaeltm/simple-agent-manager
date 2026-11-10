import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { generatePresignedUploadUrl } from '../../../src/services/attachment-upload';
import { resolveR2PresignConfig } from '../../../src/services/r2-presign-config';
import {
  getR2PresignTarget,
  hasR2S3Credentials,
  resetR2S3ClientsForTests,
} from '../../../src/services/r2-s3-client';

const credentials = { R2_ACCESS_KEY_ID: 'AKIDEXAMPLE', R2_SECRET_ACCESS_KEY: 'secret-example' };

function cloudflareEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...credentials,
    CF_ACCOUNT_ID: 'acct123',
    R2_BUCKET_NAME: 'sam-assets',
    ...overrides,
  } as Env;
}

/** celld keeps the R2 binding's objects at r2/<bucket_name>/<key> in its fleet bucket. */
function operatorStoreEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...credentials,
    R2_BUCKET_NAME: 'sam-assets',
    R2_S3_ENDPOINT: 'http://127.0.0.1:9000',
    R2_S3_BUCKET: 'celld-fleet',
    R2_S3_KEY_PREFIX: 'r2/sam-assets/',
    R2_S3_REGION: 'us-east-1',
    ...overrides,
  } as Env;
}

afterEach(() => resetR2S3ClientsForTests());

describe('resolveR2PresignConfig', () => {
  it('targets Cloudflare R2 exactly as before when no operator store is configured', () => {
    expect(resolveR2PresignConfig(cloudflareEnv())).toEqual({
      endpoint: 'https://acct123.r2.cloudflarestorage.com',
      bucket: 'sam-assets',
      keyPrefix: '',
      region: 'auto',
      forcePathStyle: undefined,
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret-example',
    });
  });

  it('targets the operator store with prefix, path style and region', () => {
    expect(resolveR2PresignConfig(operatorStoreEnv())).toMatchObject({
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'celld-fleet',
      keyPrefix: 'r2/sam-assets/',
      region: 'us-east-1',
      forcePathStyle: true,
    });
  });

  it('allows virtual-host addressing on an operator store when asked', () => {
    expect(
      resolveR2PresignConfig(operatorStoreEnv({ R2_S3_FORCE_PATH_STYLE: 'false' }))?.forcePathStyle
    ).toBe(false);
  });

  it.each([
    ['no bucket', { R2_S3_BUCKET: '' }],
    ['no key prefix', { R2_S3_KEY_PREFIX: '' }],
    ['absolute key prefix', { R2_S3_KEY_PREFIX: '/r2/sam-assets/' }],
    ['escaping key prefix', { R2_S3_KEY_PREFIX: 'r2/../deploy/' }],
    ['non-HTTP endpoint', { R2_S3_ENDPOINT: 'ftp://store' }],
    ['endpoint with credentials', { R2_S3_ENDPOINT: 'https://user:pass@store.example.com' }],
  ])('refuses a partial operator store (%s) instead of falling back to Cloudflare', (_, change) => {
    // CF_ACCOUNT_ID is present: a fallback would sign store keys for Cloudflare R2.
    const env = operatorStoreEnv({ CF_ACCOUNT_ID: 'acct123', ...change });
    expect(resolveR2PresignConfig(env)).toBeNull();
    expect(hasR2S3Credentials(env)).toBe(false);
  });

  it('needs both halves of the credential in either mode', () => {
    expect(resolveR2PresignConfig(cloudflareEnv({ R2_SECRET_ACCESS_KEY: '' }))).toBeNull();
    expect(resolveR2PresignConfig(operatorStoreEnv({ R2_ACCESS_KEY_ID: '' }))).toBeNull();
  });
});

describe('presigned URLs address the object the R2 binding reads', () => {
  it('maps an R2 key to <prefix><key> in the store bucket, path style', async () => {
    const target = getR2PresignTarget(operatorStoreEnv());
    const url = new URL(
      await getSignedUrl(
        target.client,
        new PutObjectCommand({
          Bucket: target.bucket,
          Key: target.objectKey('attachments/u1/up1/report.pdf'),
          ContentType: 'application/pdf',
        }),
        { expiresIn: 60 }
      )
    );
    expect(url.origin).toBe('http://127.0.0.1:9000');
    expect(url.pathname).toBe('/celld-fleet/r2/sam-assets/attachments/u1/up1/report.pdf');
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/us-east-1/s3/aws4_request');
  });

  it('keeps the Cloudflare URL shape: bucket host, unprefixed key', async () => {
    const target = getR2PresignTarget(cloudflareEnv());
    const url = new URL(
      await getSignedUrl(
        target.client,
        new GetObjectCommand({ Bucket: target.bucket, Key: target.objectKey('a/b.txt') }),
        { expiresIn: 60 }
      )
    );
    expect(url.host).toBe('sam-assets.acct123.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/a/b.txt');
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/auto/s3/aws4_request');
  });

  it('attachment uploads return the binding key while the URL carries the store key', async () => {
    const result = await generatePresignedUploadUrl(operatorStoreEnv(), {
      userId: 'u1',
      uploadId: 'up1',
      filename: 'report.pdf',
      size: 10,
      contentType: 'application/pdf',
    });
    expect(result.r2Key).not.toMatch(/^r2\//);
    expect(new URL(result.uploadUrl).pathname).toBe(
      `/celld-fleet/r2/sam-assets/${result.r2Key}`
    );
  });
});
