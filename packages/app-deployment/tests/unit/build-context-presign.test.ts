import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, request } from 'node:http';

import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import {
  createBuildContextDownload,
  createBuildContextUpload,
} from '../../src/build-context-upload';
import {
  COMPOSE_IMAGE_ARTIFACT_MEDIA_TYPE,
  type ComposeImageArtifactPresignTarget,
  createComposeImageArtifactDownloads,
  createComposeImageArtifactUploads,
} from '../../src/compose-image-artifacts';
import type { AppDeploymentEnv } from '../../src/env';

const secret = 'fake-secret';
// The worker's shared R2 client (apps/api/src/services/r2-s3-client.ts) as it is configured on
// Cloudflare for build contexts: WHEN_REQUIRED checksums, the account endpoint, unprefixed keys.
const target: ComposeImageArtifactPresignTarget = {
  client: new S3Client({
    region: 'auto',
    endpoint: 'https://fake-account.r2.cloudflarestorage.com',
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: 'fake-access', secretAccessKey: secret },
  }),
  bucket: 'fake-bucket',
  objectKey: (key) => key,
};

// Independent SigV4 verification, deliberately not the SDK signer under test.
// Only dummy credentials are used, and the HTTP destination is localhost.
function verifySignature(
  url: URL,
  headers: IncomingHttpHeaders,
  method: 'PUT' | 'GET' = 'PUT'
): boolean {
  const encode = (value: string) =>
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    );
  const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders')!;
  const canonicalHeaders = signedHeaders
    .split(';')
    .map((name) => {
      const value = headers[name];
      return `${name}:${String(value ?? '')
        .trim()
        .replace(/\s+/g, ' ')}\n`;
    })
    .join('');
  const query = [...url.searchParams]
    .filter(([key]) => key !== 'X-Amz-Signature')
    .map(([key, value]) => [encode(key), encode(value)])
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const canonical = [
    method,
    url.pathname,
    query,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const [, date, region, service, terminator] = url.searchParams
    .get('X-Amz-Credential')!
    .split('/');
  const scope = [date, region, service, terminator].join('/');
  const toSign = [
    'AWS4-HMAC-SHA256',
    url.searchParams.get('X-Amz-Date'),
    scope,
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n');
  let key = Buffer.from(`AWS4${secret}`);
  for (const part of [date, region, service, terminator]) {
    key = Buffer.from(createHmac('sha256', key).update(part).digest());
  }
  return (
    createHmac('sha256', key).update(toSign).digest('hex') ===
    url.searchParams.get('X-Amz-Signature')
  );
}

describe('real SDK context presigner', () => {
  it('verifies the actual upload headers and binds size and SHA metadata without empty-body checksums', async () => {
    const body = Buffer.from('nonempty compressed-context stand-in');
    const sha256 = createHash('sha256').update(body).digest('hex');
    const slot = await createBuildContextUpload(
      {
        id: 'job',
        projectId: 'project',
        environmentId: 'env',
        workspaceId: 'ws',
        requestedBy: 'user',
        attempt: 3,
      },
      { sizeBytes: body.length, sha256 },
      300,
      target
    );
    const url = new URL(slot.uploadUrl);
    expect(url.pathname).toContain('/compose-build-contexts/project/env/job/3.tar.zst');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.has('x-amz-checksum-crc32')).toBe(false);
    expect(url.searchParams.has('x-amz-sdk-checksum-algorithm')).toBe(false);
    expect(url.searchParams.has('x-amz-meta-sha256')).toBe(false);
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual([
      'content-length',
      'host',
      'x-amz-meta-sha256',
    ]);

    let captured: IncomingHttpHeaders | undefined;
    let received = Buffer.alloc(0);
    const server = createServer(async (req, res) => {
      captured = req.headers;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received = Buffer.concat(chunks);
      res.writeHead(verifySignature(url, req.headers) ? 200 : 403).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing localhost listener');
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const upload = request(
          {
            hostname: '127.0.0.1',
            port: address.port,
            method: 'PUT',
            path: url.pathname + url.search,
            headers: {
              host: url.host,
              'content-length': body.length,
              'content-type': 'application/zstd',
              'x-amz-meta-sha256': sha256,
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          }
        );
        upload.on('error', reject);
        upload.end(body);
      });
      expect(status).toBe(200);
      expect(received).toEqual(body);
      expect(verifySignature(url, captured!)).toBe(true);
      expect(verifySignature(url, { ...captured, 'x-amz-meta-sha256': 'b'.repeat(64) })).toBe(
        false
      );
      const missing = { ...captured };
      delete missing['x-amz-meta-sha256'];
      expect(verifySignature(url, missing)).toBe(false);
      expect(verifySignature(url, { ...captured, 'content-length': String(body.length + 1) })).toBe(
        false
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });
});

// Use the real client and presigner together: mocks would miss the dependency/type split.
describe('real SDK download and artifact presigners', () => {
  it('signs a prefixed build-context GET and refuses a changed key or method', async () => {
    const prefixed = {
      ...target,
      client: new S3Client({
        region: 'auto',
        endpoint: 'https://operator-store.example',
        forcePathStyle: true,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        credentials: { accessKeyId: 'fake-access', secretAccessKey: secret },
      }),
      objectKey: (key: string) => `installation/${key}`,
    };
    const key = 'compose-build-contexts/project/env/job/3.tar.zst';
    const url = new URL(await createBuildContextDownload(key, 123, prefixed));
    expect(url.pathname).toBe(`/fake-bucket/installation/${key}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('123');
    expect(verifySignature(url, { host: url.host }, 'GET')).toBe(true);
    expect(verifySignature(url, { host: url.host }, 'PUT')).toBe(false);
    url.pathname = url.pathname.replace('/project/', '/other-project/');
    expect(verifySignature(url, { host: url.host }, 'GET')).toBe(false);
  });

  it('independently verifies upload and download signatures for distinct artifact services', async () => {
    // Match the worker compose-artifact boundary: SDK_DEFAULT, an operator prefix,
    // and dummy credentials only. No network call or real credential is needed to sign.
    const artifactsTarget: ComposeImageArtifactPresignTarget = {
      client: new S3Client({
        region: 'auto',
        endpoint: 'https://operator-store.example',
        forcePathStyle: true,
        credentials: { accessKeyId: 'fake-access', secretAccessKey: secret },
      }),
      bucket: 'fake-bucket',
      objectKey: (key) => `installation/${key}`,
    };
    // These functions read only TTL/size settings from the otherwise unused Worker env.
    const env = {
      COMPOSE_IMAGE_ARTIFACT_UPLOAD_URL_TTL_SECONDS: '321',
      COMPOSE_IMAGE_ARTIFACT_DOWNLOAD_URL_TTL_SECONDS: '123',
    } as AppDeploymentEnv;
    const uploads = await createComposeImageArtifactUploads(
      env,
      {
        projectId: 'project',
        environmentId: 'env',
        workspaceId: 'workspace',
        uploadId: 'upload',
        services: [
          { serviceName: 'web', sourceRef: 'web:latest' },
          { serviceName: 'worker', sourceRef: 'worker:latest' },
        ],
      },
      artifactsTarget
    );
    expect(uploads).toHaveLength(2);
    expect(new Set(uploads.map((upload) => upload.r2Key)).size).toBe(2);
    for (const upload of uploads) {
      const url = new URL(upload.uploadUrl);
      expect(url.pathname).toBe(`/fake-bucket/installation/${upload.r2Key}`);
      expect(upload.r2Key).toBe(
        `compose-image-artifacts/project/env/workspace/upload/${upload.serviceName}.docker-save.tar`
      );
      expect(upload.mediaType).toBe(COMPOSE_IMAGE_ARTIFACT_MEDIA_TYPE);
      expect(url.searchParams.get('X-Amz-Expires')).toBe('321');
      expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^fake-access\//);
      expect(verifySignature(url, { host: url.host }, 'PUT')).toBe(true);
      expect(verifySignature(url, { host: url.host }, 'GET')).toBe(false);
    }
    const downloads = await createComposeImageArtifactDownloads(
      env,
      uploads.map((upload) => ({
        ...upload,
        sizeBytes: 42,
        archiveSha256: `sha256:${'a'.repeat(64)}`,
      })),
      artifactsTarget
    );
    expect(downloads.map((download) => download.r2Key)).toEqual(
      uploads.map((upload) => upload.r2Key)
    );
    for (const download of downloads) {
      const url = new URL(download.downloadUrl);
      expect(url.pathname).toBe(`/fake-bucket/installation/${download.r2Key}`);
      expect(url.searchParams.get('X-Amz-Expires')).toBe('123');
      expect(verifySignature(url, { host: url.host }, 'GET')).toBe(true);
      url.searchParams.set('X-Amz-Expires', '999');
      expect(verifySignature(url, { host: url.host }, 'GET')).toBe(false);
    }
  });
});
