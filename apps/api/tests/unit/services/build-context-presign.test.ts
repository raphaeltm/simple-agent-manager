import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders,request } from 'node:http';

import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { createBuildContextUpload } from '../../../src/services/build-context-upload';

const secret = 'fake-secret';
const env = {
  CF_ACCOUNT_ID: 'fake-account',
  R2_ACCESS_KEY_ID: 'fake-access',
  R2_SECRET_ACCESS_KEY: secret,
  R2_BUCKET_NAME: 'fake-bucket',
} as Env;

// Independent SigV4 verification, deliberately not the SDK signer under test.
// Only dummy credentials are used, and the HTTP destination is localhost.
function verifySignature(url: URL, headers: IncomingHttpHeaders): boolean {
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
    'PUT',
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
      env,
      {
        id: 'job',
        projectId: 'project',
        environmentId: 'env',
        workspaceId: 'ws',
        requestedBy: 'user',
        attempt: 3,
      },
      { sizeBytes: body.length, sha256 },
      300
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
