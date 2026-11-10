import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import {
  buildComposeImageArtifactKey,
  COMPOSE_IMAGE_ARTIFACT_ARCHIVE_TYPE,
  COMPOSE_IMAGE_ARTIFACT_MEDIA_TYPE,
  type ComposeImageArtifactDescriptor,
  createComposeImageArtifactDownloads,
  createComposeImageArtifactUploads,
} from '../../../src/services/compose-image-artifacts';
import { resetR2S3ClientsForTests } from '../../../src/services/r2-s3-client';

// Real AWS presigner and real S3Client: nothing between the service and the signed URL is mocked.

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
    R2_S3_ENDPOINT: 'https://s3.example.test',
    R2_S3_BUCKET: 'celld-fleet',
    R2_S3_KEY_PREFIX: 'r2/sam-assets/',
    ...overrides,
  } as Env;
}

const UPLOAD_INPUT = {
  projectId: 'proj-1',
  workspaceId: 'ws-1',
  environmentId: 'env-1',
  uploadId: 'upload-1',
  services: [
    { serviceName: 'web', sourceRef: 'workspace-web' },
    {
      serviceName: 'api',
      sourceRef: 'workspace-api',
      localImageRef: 'sam-env-1-api:rel-1',
      platform: { architecture: 'arm64', os: 'linux' },
    },
  ],
};

const WEB_KEY = buildComposeImageArtifactKey('proj-1', 'ws-1', 'env-1', 'upload-1', 'web');
const API_KEY = buildComposeImageArtifactKey('proj-1', 'ws-1', 'env-1', 'upload-1', 'api');

function descriptor(
  r2Key: string,
  serviceName = 'web'
): ComposeImageArtifactDescriptor {
  return {
    serviceName,
    sourceRef: `workspace-${serviceName}`,
    localImageRef: `sam-env-1-${serviceName}:rel-1`,
    r2Key,
    sizeBytes: 42,
    archiveSha256: `sha256:${'a'.repeat(64)}`,
    archiveType: COMPOSE_IMAGE_ARTIFACT_ARCHIVE_TYPE,
    mediaType: COMPOSE_IMAGE_ARTIFACT_MEDIA_TYPE,
  };
}

afterEach(() => resetR2S3ClientsForTests());

describe('createComposeImageArtifactUploads', () => {
  it('Cloudflare: signs a virtual-host URL for the unprefixed key in the auto region', async () => {
    const uploads = await createComposeImageArtifactUploads(cloudflareEnv(), UPLOAD_INPUT);

    expect(uploads).toHaveLength(2);
    const url = new URL(uploads[0]!.uploadUrl);
    // Pre-T3 shape: SDK default addressing against https://<acct>.r2.cloudflarestorage.com.
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('sam-assets.acct123.r2.cloudflarestorage.com');
    expect(url.pathname).toBe(`/${WEB_KEY}`);
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(
      /^AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
  });

  it('Cloudflare: returns the unprefixed r2Key and the full upload metadata for every service', async () => {
    const uploads = await createComposeImageArtifactUploads(
      cloudflareEnv({ COMPOSE_IMAGE_ARTIFACT_UPLOAD_URL_TTL_SECONDS: '120' }),
      UPLOAD_INPUT
    );

    expect(uploads.map((u) => [u.serviceName, u.r2Key, u.localImageRef, u.expiresIn])).toEqual([
      ['web', WEB_KEY, 'workspace-web', 120],
      ['api', API_KEY, 'sam-env-1-api:rel-1', 120],
    ]);
    expect(uploads[1]).toMatchObject({
      archiveType: COMPOSE_IMAGE_ARTIFACT_ARCHIVE_TYPE,
      mediaType: COMPOSE_IMAGE_ARTIFACT_MEDIA_TYPE,
      platform: { architecture: 'arm64', os: 'linux' },
    });
    expect(new URL(uploads[1]!.uploadUrl).pathname).toBe(`/${API_KEY}`);
    expect(new URL(uploads[1]!.uploadUrl).searchParams.get('X-Amz-Expires')).toBe('120');
  });

  it('operator store: signs a path-style URL at <bucket>/<prefix><key> on the operator host', async () => {
    const uploads = await createComposeImageArtifactUploads(operatorStoreEnv(), UPLOAD_INPUT);

    const url = new URL(uploads[0]!.uploadUrl);
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('s3.example.test');
    expect(url.pathname).toBe(`/celld-fleet/r2/sam-assets/${WEB_KEY}`);
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(
      /^AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/
    );
    // The descriptor handed back to the caller stays the binding's key, not the store key.
    expect(uploads[0]!.r2Key).toBe(WEB_KEY);
    expect(new URL(uploads[1]!.uploadUrl).pathname).toBe(`/celld-fleet/r2/sam-assets/${API_KEY}`);
  });

  it('operator store: honours the configured region in the credential scope', async () => {
    const uploads = await createComposeImageArtifactUploads(
      operatorStoreEnv({ R2_S3_REGION: 'us-east-1' }),
      UPLOAD_INPUT
    );
    expect(new URL(uploads[0]!.uploadUrl).searchParams.get('X-Amz-Credential')).toMatch(
      /\/us-east-1\/s3\/aws4_request$/
    );
  });

  it.each([
    ['no credentials at all', { R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '' }],
    ['no CF_ACCOUNT_ID on Cloudflare', { CF_ACCOUNT_ID: '' }],
    ['no R2_BUCKET_NAME on Cloudflare', { R2_BUCKET_NAME: '' }],
    ['an operator-store bucket without its endpoint', { R2_S3_BUCKET: 'celld-fleet' }],
  ])('refuses to sign when presigning is not configured (%s)', async (_, change) => {
    await expect(
      createComposeImageArtifactUploads(cloudflareEnv(change as Partial<Env>), UPLOAD_INPUT)
    ).rejects.toThrow(/R2 S3 credentials not configured/);
  });

  it('operator store: an endpoint without bucket or prefix never falls back to Cloudflare', async () => {
    await expect(
      createComposeImageArtifactUploads(
        cloudflareEnv({ R2_S3_ENDPOINT: 'https://s3.example.test' }),
        UPLOAD_INPUT
      )
    ).rejects.toThrow(/R2 S3 credentials not configured/);
  });

  it('operator store: a service name cannot climb out of the prefix (key is server-derived and sanitised)', async () => {
    const uploads = await createComposeImageArtifactUploads(operatorStoreEnv(), {
      ...UPLOAD_INPUT,
      services: [{ serviceName: '../../deploy/x', sourceRef: 'workspace-web' }],
    });
    const path = new URL(uploads[0]!.uploadUrl).pathname;
    expect(path.startsWith('/celld-fleet/r2/sam-assets/compose-image-artifacts/')).toBe(true);
    expect(path).not.toContain('/../');
  });
});

describe('Cloudflare parity with the pre-T3 client', () => {
  // Pre-T3 (origin/sam/selfhost-pass-2) built exactly this client inline.
  function preT3Client(): S3Client {
    return new S3Client({
      region: 'auto',
      endpoint: 'https://acct123.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-example' },
    });
  }

  function shape(raw: string) {
    const url = new URL(raw);
    return {
      host: url.host,
      pathname: url.pathname,
      // Same set of signed query parameters; only the time-derived values may differ.
      params: [...url.searchParams.keys()].sort(),
      signedHeaders: url.searchParams.get('X-Amz-SignedHeaders'),
      scope: url.searchParams.get('X-Amz-Credential')?.replace(/\/\d{8}\//, '/DATE/'),
    };
  }

  it('upload URL has the same host, path, signed parameters and credential scope', async () => {
    const [upload] = await createComposeImageArtifactUploads(cloudflareEnv(), {
      ...UPLOAD_INPUT,
      services: [UPLOAD_INPUT.services[0]!],
    });
    const legacy = await getSignedUrl(
      preT3Client(),
      new PutObjectCommand({
        Bucket: 'sam-assets',
        Key: WEB_KEY,
        ContentType: COMPOSE_IMAGE_ARTIFACT_MEDIA_TYPE,
      }),
      { expiresIn: 900 }
    );
    expect(shape(upload!.uploadUrl)).toEqual(shape(legacy));
  });

  it('download URL has the same host, path, signed parameters and credential scope', async () => {
    const [download] = await createComposeImageArtifactDownloads(cloudflareEnv(), [
      descriptor(WEB_KEY),
    ]);
    const legacy = await getSignedUrl(
      preT3Client(),
      new GetObjectCommand({ Bucket: 'sam-assets', Key: WEB_KEY }),
      { expiresIn: 900 }
    );
    expect(shape(download!.downloadUrl)).toEqual(shape(legacy));
  });
});

describe('createComposeImageArtifactDownloads', () => {
  it('Cloudflare: signs a virtual-host GET URL for the unprefixed key in the auto region', async () => {
    const downloads = await createComposeImageArtifactDownloads(cloudflareEnv(), [
      descriptor(WEB_KEY),
      descriptor(API_KEY, 'api'),
    ]);

    expect(downloads).toHaveLength(2);
    const url = new URL(downloads[0]!.downloadUrl);
    expect(url.host).toBe('sam-assets.acct123.r2.cloudflarestorage.com');
    expect(url.pathname).toBe(`/${WEB_KEY}`);
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(
      /^AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/
    );
    expect(url.searchParams.get('x-id')).toBe('GetObject');
    expect(downloads[0]).toMatchObject({ ...descriptor(WEB_KEY), downloadExpiresIn: 900 });
    expect(new URL(downloads[1]!.downloadUrl).pathname).toBe(`/${API_KEY}`);
  });

  it('Cloudflare: passes an unusual but legal key through unchanged (keys are opaque there)', async () => {
    const odd = 'compose-image-artifacts/proj-1/env-1/ws-1/up..load/web.docker-save.tar';
    const downloads = await createComposeImageArtifactDownloads(cloudflareEnv(), [
      descriptor(odd),
    ]);
    expect(new URL(downloads[0]!.downloadUrl).pathname).toBe(`/${odd}`);
  });

  it('Cloudflare: honours the configured download TTL', async () => {
    const downloads = await createComposeImageArtifactDownloads(
      cloudflareEnv({ COMPOSE_IMAGE_ARTIFACT_DOWNLOAD_URL_TTL_SECONDS: '60' }),
      [descriptor(WEB_KEY)]
    );
    expect(downloads[0]!.downloadExpiresIn).toBe(60);
    expect(new URL(downloads[0]!.downloadUrl).searchParams.get('X-Amz-Expires')).toBe('60');
  });

  it('operator store: signs a path-style GET URL at <bucket>/<prefix><key>', async () => {
    const downloads = await createComposeImageArtifactDownloads(operatorStoreEnv(), [
      descriptor(WEB_KEY),
    ]);

    const url = new URL(downloads[0]!.downloadUrl);
    expect(url.host).toBe('s3.example.test');
    expect(url.pathname).toBe(`/celld-fleet/r2/sam-assets/${WEB_KEY}`);
    expect(url.searchParams.get('x-id')).toBe('GetObject');
    expect(downloads[0]!.r2Key).toBe(WEB_KEY);
  });

  it.each([
    ['climbs out with ..', '../deploy/x'],
    ['climbs out mid-path', 'compose-image-artifacts/proj-1/../../deploy/manifest.json'],
    ['is absolute', '/deploy/manifest.json'],
    ['uses a backslash', 'compose-image-artifacts\\proj-1\\x'],
    ['has a dot segment', 'compose-image-artifacts/./proj-1/x'],
    ['has a control character', 'compose-image-artifacts/proj-1/x\u0000y'],
  ])(
    'operator store: refuses a descriptor whose r2Key %s, signing nothing',
    async (_, r2Key) => {
      await expect(
        createComposeImageArtifactDownloads(operatorStoreEnv(), [
          descriptor(WEB_KEY, 'api'),
          descriptor(r2Key),
        ])
      ).rejects.toThrow('R2 object key has an unsafe path segment');
    }
  );

  it('operator store: a legal key in the same call as the owner control still signs', async () => {
    // Control for the refusal cases above: the same fixture with a clean key succeeds.
    await expect(
      createComposeImageArtifactDownloads(operatorStoreEnv(), [descriptor(WEB_KEY)])
    ).resolves.toHaveLength(1);
  });

  it('Cloudflare: the same escaping key is NOT refused (no prefix to escape; pre-T3 behaviour)', async () => {
    const downloads = await createComposeImageArtifactDownloads(cloudflareEnv(), [
      descriptor('../deploy/x'),
    ]);
    expect(downloads).toHaveLength(1);
    expect(new URL(downloads[0]!.downloadUrl).host).toBe(
      'sam-assets.acct123.r2.cloudflarestorage.com'
    );
  });

  it.each([
    ['no credentials', { R2_SECRET_ACCESS_KEY: '' }],
    ['no CF_ACCOUNT_ID on Cloudflare', { CF_ACCOUNT_ID: '' }],
    ['no R2_BUCKET_NAME on Cloudflare', { R2_BUCKET_NAME: '' }],
  ])('refuses to sign when presigning is not configured (%s)', async (_, change) => {
    await expect(
      createComposeImageArtifactDownloads(cloudflareEnv(change as Partial<Env>), [
        descriptor(WEB_KEY),
      ])
    ).rejects.toThrow(/R2 S3 credentials not configured/);
  });
});
