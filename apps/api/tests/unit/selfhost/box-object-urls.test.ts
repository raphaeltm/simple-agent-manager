/**
 * Box object URLs (apps/api/src/selfhost/object-urls/): tokens, the signer the self-host build
 * installs, the shared resolver's choice between R2 presign and the box (rule 74), and the PUT/GET
 * route with its upload gate. The R2 fake enforces what celld's R2 binding enforces and the live
 * suite proves on the real runtime (scripts/selfhost/live/box-object-urls.live.test.ts):
 * create-only puts and sha256 verification. The gate is the real Durable Object class over SQLite.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  composeImageArtifactMaxBytesFor,
  createComposeImageArtifactDownloads,
  createComposeImageArtifactUploads,
  createBuildContextUpload,
} from '@simple-agent-manager/app-deployment';

import type { Env } from '../../../src/env';
import { requestLoggingMiddleware } from '../../../src/middleware/request-logging';
import { mintHostedGitToken } from '../../../src/selfhost/hosted-git/tokens';
import { BoxUploadGate } from '../../../src/selfhost/object-urls/gate';
import { CELLD_CONDITIONAL_PUT_MAX_BYTES } from '../../../src/selfhost/object-urls/route';
import { installBoxObjectUrls, mountBoxObjectRoute } from '../../../src/selfhost/object-urls';
import {
  BOX_OBJECT_ROUTE,
  CELLD_MAX_REQUEST_BODY_BYTES,
  createBoxObjectUrlSigner,
} from '../../../src/selfhost/object-urls/signer';
import {
  isSafeObjectKey,
  mintBoxObjectToken,
  verifyBoxObjectToken,
} from '../../../src/selfhost/object-urls/tokens';
import { generatePresignedUploadUrl } from '../../../src/services/attachment-upload';
import {
  getR2ObjectUrlSigner,
  installBoxObjectUrlSigner,
  resolveR2ObjectUrlSigner,
  resetR2S3ClientsForTests,
} from '../../../src/services/r2-s3-client';

const KEY = 'box-test-encryption-key-0123456789';
const DOMAIN = 'box.example.test';

// ── celld-faithful fakes ───────────────────────────────────────────────────────────────────────

/** workerd's FixedLengthStream: errors when the body is shorter or longer than declared. */
class TestFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(expected: number) {
    let seen = 0;
    super({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > expected) throw new Error('FixedLengthStream: too many bytes');
        controller.enqueue(chunk);
      },
      flush() {
        if (seen !== expected) throw new Error('FixedLengthStream: too few bytes');
      },
    });
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface Stored {
  bytes: Uint8Array;
  contentType?: string;
  customMetadata?: Record<string, string>;
  sha?: string;
}

/** Create-only puts and sha256 checks as celld's R2 binding does them (live-verified). */
function fakeR2() {
  const objects = new Map<string, Stored>();
  const bucket = {
    objects,
    async put(
      key: string,
      body: ReadableStream<Uint8Array> | Uint8Array,
      options: {
        onlyIf?: { etagDoesNotMatch?: string };
        httpMetadata?: { contentType?: string };
        customMetadata?: Record<string, string>;
        sha256?: string;
      } = {}
    ) {
      const bytes =
        body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
      if (options.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
      const sha = await sha256Hex(bytes);
      if (options.sha256 && options.sha256 !== sha) {
        throw new Error(`R2 put: the sha256 checksum of the body is ${sha}, not ${options.sha256}`);
      }
      objects.set(key, {
        bytes,
        contentType: options.httpMetadata?.contentType,
        customMetadata: options.customMetadata,
        sha,
      });
      return { size: bytes.byteLength, httpEtag: `"${sha.slice(0, 8)}"` };
    },
    async head(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      const checksum = Uint8Array.from(object.sha!.match(/../g)!, (h) => parseInt(h, 16));
      return {
        size: object.bytes.byteLength,
        customMetadata: object.customMetadata,
        checksums: { sha256: checksum.buffer },
      };
    },
    async get(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        size: object.bytes.byteLength,
        httpEtag: '"etag"',
        httpMetadata: { contentType: object.contentType },
        body: new Response(object.bytes).body,
      };
    },
  };
  return bucket;
}

/** `ctx.storage.sql` over better-sqlite3, for the real gate class. */
function sqliteStorage() {
  const db = new Database(':memory:');
  return {
    exec(query: string, ...params: unknown[]) {
      const statement = db.prepare(query);
      const rows = statement.reader ? (statement.all(...params) as unknown[]) : (statement.run(...params), []);
      return { one: () => rows[0], toArray: () => rows };
    },
  };
}

function gateNamespace(gate: BoxUploadGate) {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      acquire: async (id: string, limit: number, leaseMs: number) => gate.acquire(id, limit, leaseMs),
      release: async (id: string) => gate.release(id),
    }),
  };
}

function boxEnv(overrides: Partial<Record<string, unknown>> = {}) {
  const R2 = fakeR2();
  const gate = new BoxUploadGate({ storage: { sql: sqliteStorage() } } as never, {});
  const env = {
    BASE_DOMAIN: DOMAIN,
    ENCRYPTION_KEY: KEY,
    R2,
    BOX_UPLOAD_GATE: gateNamespace(gate),
    ...overrides,
  } as unknown as Env;
  return { env, R2, gate };
}

function routeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', requestLoggingMiddleware());
  mountBoxObjectRoute(app);
  return app;
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function putUrl(app: Hono<{ Bindings: Env }>, env: Env, url: string, body: Uint8Array, headers: Record<string, string> = {}) {
  const target = new URL(url);
  return app.request(
    `${target.pathname}${target.search}`,
    { method: 'PUT', body, headers: { 'content-length': String(body.byteLength), ...headers } },
    env
  );
}

beforeAll(() => {
  (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = TestFixedLengthStream;
});

afterEach(() => {
  installBoxObjectUrlSigner(null);
  resetR2S3ClientsForTests();
  vi.restoreAllMocks();
});

// ── tokens ─────────────────────────────────────────────────────────────────────────────────────

describe('box object tokens', () => {
  const env = { ENCRYPTION_KEY: KEY };
  const put = { op: 'put' as const, key: 'temp-uploads/u1/up1/a.txt', len: 5, expiresIn: 60 };

  it('round-trips the claims while unexpired', async () => {
    const token = await mintBoxObjectToken(env, put, 1_000_000);
    expect(await verifyBoxObjectToken(env, token, 1_000_000 + 59_000)).toMatchObject({
      op: 'put',
      key: put.key,
      len: 5,
    });
    expect(await verifyBoxObjectToken(env, token, 1_000_000 + 60_000)).toBeNull();
  });

  it('refuses a tampered payload, a tampered signature and another installation', async () => {
    const token = await mintBoxObjectToken(env, put);
    const [prefix, payload, signature] = token.split('.') as [string, string, string];
    const claims = JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/')));
    const forged = btoa(JSON.stringify({ ...claims, key: 'temp-uploads/u2/up/a.txt' }))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
    expect(await verifyBoxObjectToken(env, `${prefix}.${forged}.${signature}`)).toBeNull();
    expect(await verifyBoxObjectToken(env, `${prefix}.${payload}.${signature.slice(0, -2)}AA`)).toBeNull();
    expect(await verifyBoxObjectToken({ ENCRYPTION_KEY: 'another-installation-key' }, token)).toBeNull();
    // Control: the untouched token verifies.
    expect(await verifyBoxObjectToken(env, token)).not.toBeNull();
  });

  it('refuses a hosted-git token signed with the same ENCRYPTION_KEY (purpose separation)', async () => {
    const { token } = await mintHostedGitToken(env, { repo: 'repo-a', scope: 'write' });
    expect(await verifyBoxObjectToken(env, token)).toBeNull();
  });

  it('keeps tokens minted before a rotation valid through ENCRYPTION_KEY_PREVIOUS only', async () => {
    const token = await mintBoxObjectToken({ ENCRYPTION_KEY: 'old-key-0123456789abcdef' }, put);
    const rotated = { ENCRYPTION_KEY: 'new-key-0123456789abcdef', ENCRYPTION_KEY_PREVIOUS: 'old-key-0123456789abcdef' };
    expect(await verifyBoxObjectToken(rotated, token)).not.toBeNull();
    expect(await verifyBoxObjectToken({ ENCRYPTION_KEY: rotated.ENCRYPTION_KEY }, token)).toBeNull();
  });

  it('refuses unsafe keys, unbounded PUTs and GET tokens carrying upload fields', async () => {
    for (const key of ['../secrets', 'a/../b', '/abs', 'a//b', 'a\\b', 'a/\u0000']) {
      expect(isSafeObjectKey(key)).toBe(false);
      await expect(mintBoxObjectToken(env, { ...put, key })).rejects.toThrow('invalid');
    }
    expect(isSafeObjectKey(put.key)).toBe(true);
    await expect(
      mintBoxObjectToken(env, { op: 'put', key: put.key, expiresIn: 60 })
    ).rejects.toThrow('invalid');
    await expect(
      mintBoxObjectToken(env, { op: 'get', key: put.key, max: 5, expiresIn: 60 })
    ).rejects.toThrow('invalid');
  });
});

// ── the resolver's choice (rule 74) ────────────────────────────────────────────────────────────

describe('which URL a caller gets', () => {
  const cloudflare = {
    CF_ACCOUNT_ID: 'acct',
    R2_ACCESS_KEY_ID: 'AKID',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_BUCKET_NAME: 'bucket',
  };

  it('Cloudflare (no box signer installed) presigns, even without a key it cannot box', async () => {
    const signer = getR2ObjectUrlSigner({ ...cloudflare, BASE_DOMAIN: DOMAIN, ENCRYPTION_KEY: KEY } as Env);
    expect(signer.kind).toBe('presign');
    expect(new URL(await signer.putUrl('k', { expiresIn: 60 })).host).toMatch(/acct\.r2\.cloudflarestorage\.com$/);
    // Divergence: a keyless Env on Cloudflare has no signer; it does not fall through to a box URL.
    expect(resolveR2ObjectUrlSigner(boxEnv().env)).toBeNull();
  });

  it('a keyless box resolves to the box route', async () => {
    installBoxObjectUrls();
    const signer = getR2ObjectUrlSigner(boxEnv().env);
    expect(signer.kind).toBe('box');
    const url = new URL(await signer.putUrl('k', { expiresIn: 60, contentLength: 3 }));
    expect(`${url.origin}${url.pathname}`).toBe(`https://api.${DOMAIN}${BOX_OBJECT_ROUTE}`);
    expect(url.searchParams.get('token')).toMatch(/^samobj1\./);
  });

  it('convergence: a box that still has a store key keeps direct presigned uploads', async () => {
    installBoxObjectUrls();
    const { env } = boxEnv(cloudflare);
    expect(getR2ObjectUrlSigner(env).kind).toBe('presign');
  });

  it('nothing configured is a 503 naming the settings, not a 500', () => {
    try {
      getR2ObjectUrlSigner({} as Env);
      expect.unreachable();
    } catch (error) {
      expect((error as { statusCode: number }).statusCode).toBe(503);
      expect((error as Error).message).toContain('R2_ACCESS_KEY_ID');
    }
  });
});

// ── callers through the box signer ─────────────────────────────────────────────────────────────

describe('callers on a keyless box', () => {
  it('compose init reports the box limit and gives box URLs for upload and download', async () => {
    const { env } = boxEnv();
    const signer = createBoxObjectUrlSigner(env)!;
    expect(composeImageArtifactMaxBytesFor(env, signer)).toBe(CELLD_MAX_REQUEST_BODY_BYTES);
    const [upload] = await createComposeImageArtifactUploads(
      env,
      { projectId: 'p1', workspaceId: 'w1', environmentId: 'e1', uploadId: 'u1', services: [{ serviceName: 'web', sourceRef: 'web' }] },
      signer
    );
    expect(upload!.maxBytes).toBe(CELLD_MAX_REQUEST_BODY_BYTES);
    const claims = await verifyBoxObjectToken(env, new URL(upload!.uploadUrl).searchParams.get('token')!);
    expect(claims).toMatchObject({ op: 'put', key: upload!.r2Key, max: CELLD_MAX_REQUEST_BODY_BYTES, sub: { p: 'p1', w: 'w1' } });
    const [download] = await createComposeImageArtifactDownloads(
      env,
      [{ serviceName: 'web', sourceRef: 'web', localImageRef: 'web', r2Key: upload!.r2Key, sizeBytes: 3, archiveType: 'docker-save', mediaType: 'x' } as never],
      signer
    );
    const getClaims = await verifyBoxObjectToken(env, new URL(download!.downloadUrl).searchParams.get('token')!);
    expect(getClaims).toMatchObject({ op: 'get', key: upload!.r2Key });
  });

  it('build-context uploads bind length, sha256 and its metadata into the token', async () => {
    const { env } = boxEnv();
    const sha = 'a'.repeat(64);
    const slot = await createBuildContextUpload(
      { id: 'job', projectId: 'p1', workspaceId: 'w1', requestedBy: 'u1', environmentId: 'e1', attempt: 1 },
      { sizeBytes: 9, sha256: sha },
      60,
      createBoxObjectUrlSigner(env)!
    );
    const claims = await verifyBoxObjectToken(env, new URL(slot.uploadUrl).searchParams.get('token')!);
    expect(claims).toMatchObject({ key: slot.r2Key, len: 9, sha, md: { sha256: sha } });
  });

  it('a single upload over 1 GiB is refused when the URL is requested', async () => {
    const signer = createBoxObjectUrlSigner(boxEnv().env)!;
    await expect(
      signer.putUrl('k', { expiresIn: 60, contentLength: CELLD_MAX_REQUEST_BODY_BYTES + 1 })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('attachment keys come from the authenticated user, so user B cannot get a URL for user A', async () => {
    installBoxObjectUrls();
    const { env } = boxEnv();
    const options = { uploadId: 'up1', filename: 'a.txt', size: 5, contentType: 'text/plain' };
    const a = await generatePresignedUploadUrl(env, { ...options, userId: 'user-a' });
    const b = await generatePresignedUploadUrl(env, { ...options, userId: 'user-b' });
    const claimsB = await verifyBoxObjectToken(env, new URL(b.uploadUrl).searchParams.get('token')!);
    expect(claimsB!.key).toBe(b.r2Key);
    expect(claimsB!.key.startsWith('temp-uploads/user-b/')).toBe(true);
    expect(a.r2Key.startsWith('temp-uploads/user-a/')).toBe(true);
  });
});

// ── the route ──────────────────────────────────────────────────────────────────────────────────

describe('PUT/GET /api/box-objects', () => {
  async function upload(env: Env, key: string, extra: Partial<Parameters<typeof mintBoxObjectToken>[1]> = {}) {
    const signer = createBoxObjectUrlSigner(env)!;
    return signer.putUrl(key, { expiresIn: 60, contentType: 'text/plain', ...extra });
  }

  it('streams the body into R2 and serves it back with a GET token', async () => {
    const { env, R2 } = boxEnv();
    const app = routeApp();
    const url = await upload(env, 'temp-uploads/u1/up/a.txt', { contentLength: 5 });
    expect((await putUrl(app, env, url, bytes('hello'))).status).toBe(200);
    expect(new TextDecoder().decode(R2.objects.get('temp-uploads/u1/up/a.txt')!.bytes)).toBe('hello');
    expect(R2.objects.get('temp-uploads/u1/up/a.txt')!.contentType).toBe('text/plain');

    const getUrl = new URL(await createBoxObjectUrlSigner(env)!.getUrl('temp-uploads/u1/up/a.txt', { expiresIn: 60 }));
    const response = await app.request(`${getUrl.pathname}${getUrl.search}`, {}, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello');
  });

  it('attack: a token writes only its own key; an extra key parameter is ignored (owner control writes)', async () => {
    const { env, R2 } = boxEnv();
    const app = routeApp();
    const url = new URL(await upload(env, 'temp-uploads/user-a/up/a.txt', { contentLength: 5 }));
    url.searchParams.set('key', 'temp-uploads/user-b/up/a.txt');
    expect((await putUrl(app, env, url.toString(), bytes('owned'))).status).toBe(200);
    expect(R2.objects.has('temp-uploads/user-b/up/a.txt')).toBe(false);
    expect(R2.objects.has('temp-uploads/user-a/up/a.txt')).toBe(true);
  });

  it('refuses forged, expired, wrong-operation and missing tokens without writing', async () => {
    const { env, R2 } = boxEnv();
    const app = routeApp();
    const getToken = await mintBoxObjectToken(env, { op: 'get', key: 'k', expiresIn: 60 });
    const expired = await mintBoxObjectToken(env, { op: 'put', key: 'k', len: 1, expiresIn: 1 }, Date.now() - 10_000);
    const forged = await mintBoxObjectToken({ ENCRYPTION_KEY: 'another-installation-key' }, { op: 'put', key: 'k', len: 1, expiresIn: 60 });
    for (const token of [getToken, expired, forged, '']) {
      const response = await putUrl(app, env, `https://x${BOX_OBJECT_ROUTE}?token=${encodeURIComponent(token)}`, bytes('x'));
      expect(response.status).toBe(403);
    }
    expect(R2.objects.size).toBe(0);
  });

  it('bounds size: over the maximum is 413, a length other than the issued one 400, none 411', async () => {
    const { env, R2 } = boxEnv();
    const app = routeApp();
    const bounded = await upload(env, 'k1', { maxBytes: 4 });
    expect((await putUrl(app, env, bounded, bytes('12345'))).status).toBe(413);
    const exact = await upload(env, 'k2', { contentLength: 4 });
    expect((await putUrl(app, env, exact, bytes('123'))).status).toBe(400);
    const target = new URL(exact);
    const noLength = await app.request(`${target.pathname}${target.search}`, { method: 'PUT' }, env);
    expect(noLength.status).toBe(411);
    expect(R2.objects.size).toBe(0);
    // Control: within bounds is written.
    expect((await putUrl(app, env, bounded, bytes('1234'))).status).toBe(200);
  });

  it('is create-only: a second write is 412 and the object stays', async () => {
    const { env, R2 } = boxEnv();
    const app = routeApp();
    const url = await upload(env, 'k', { contentLength: 5 });
    expect((await putUrl(app, env, url, bytes('first'))).status).toBe(200);
    // Same length, other bytes: without a bound digest the route cannot tell, so it refuses.
    expect((await putUrl(app, env, url, bytes('other'))).status).toBe(412);
    expect((await putUrl(app, env, url, bytes('first'))).status).toBe(412);
    expect(new TextDecoder().decode(R2.objects.get('k')!.bytes)).toBe('first');
  });

  it('above celld conditional-put size it checks for an existing object instead of onlyIf', async () => {
    const { env, R2 } = boxEnv();
    const app = routeApp();
    const putSpy = vi.spyOn(R2, 'put');
    const big = new Uint8Array(CELLD_CONDITIONAL_PUT_MAX_BYTES + 1).fill(7);
    const url = await upload(env, 'big', { contentLength: big.byteLength });
    expect((await putUrl(app, env, url, big)).status).toBe(200);
    expect(putSpy.mock.calls[0]![2]).not.toHaveProperty('onlyIf');
    expect((await putUrl(app, env, url, big.fill(8))).status).toBe(412);
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(R2.objects.get('big')!.bytes[0]).toBe(7);
  });

  it('a retried PUT with a bound sha256 that already succeeded is 200 and replaces nothing', async () => {
    const { env, R2 } = boxEnv();
    const app = routeApp();
    const body = bytes('first');
    const url = await upload(env, 'k', { contentLength: 5, sha256: await sha256Hex(body) });
    expect((await putUrl(app, env, url, body)).status).toBe(200);
    expect((await putUrl(app, env, url, body)).status).toBe(200);
    // Other bytes: 400 if the digest is checked first, 200 if the create-only check is (the stored
    // object is exactly what the token describes). Either way nothing is replaced.
    expect([200, 400]).toContain((await putUrl(app, env, url, bytes('other'))).status);
    expect(new TextDecoder().decode(R2.objects.get('k')!.bytes)).toBe('first');
  });

  it('verifies a bound sha256: wrong bytes are 400 and nothing is stored', async () => {
    const { env, R2 } = boxEnv();
    const app = routeApp();
    const body = bytes('context');
    const url = await upload(env, 'ctx', { contentLength: body.byteLength, sha256: await sha256Hex(body) });
    expect((await putUrl(app, env, url, bytes('CONTEXT'))).status).toBe(400);
    expect(R2.objects.has('ctx')).toBe(false);
    expect((await putUrl(app, env, url, body)).status).toBe(200);
  });

  it('refuses with 503 and Retry-After while the box limit is in use, then admits once a slot frees', async () => {
    const { env, R2, gate } = boxEnv();
    const app = routeApp();
    // Settings storage is unavailable in this env, so the default limit (4) applies.
    for (let i = 0; i < 4; i++) gate.acquire(`held-${i}`, 4, 60_000);
    const url = await upload(env, 'busy', { contentLength: 4 });
    const refused = await putUrl(app, env, url, bytes('busy'));
    expect(refused.status).toBe(503);
    expect(Number(refused.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(R2.objects.has('busy')).toBe(false);
    gate.release('held-0');
    expect((await putUrl(app, env, url, bytes('busy'))).status).toBe(200);
    // The upload released its own lease: three held, one free.
    expect(gate.acquire('probe', 4, 60_000)).toEqual({ granted: true });
  });

  it('an expired lease frees its slot (a handler that died without releasing)', () => {
    const { gate } = boxEnv();
    gate.acquire('dead', 1, 1_000, 0);
    expect(gate.acquire('next', 1, 1_000, 500).granted).toBe(false);
    expect(gate.acquire('next', 1, 1_000, 1_000).granted).toBe(true);
  });

  it('never logs the token: the request log and the route log carry the path only', async () => {
    const { env } = boxEnv();
    const app = routeApp();
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
      });
    }
    const url = await upload(env, 'logged', { contentLength: 2 });
    const token = new URL(url).searchParams.get('token')!;
    expect((await putUrl(app, env, url, bytes('ok'))).status).toBe(200);
    await putUrl(app, env, `https://x${BOX_OBJECT_ROUTE}?token=${token}x`, bytes('ok'));
    // Liveness: the request log and the route's own events were written.
    expect(lines.some((line) => line.includes('http.request') && line.includes(BOX_OBJECT_ROUTE))).toBe(true);
    expect(lines.some((line) => line.includes('box_objects.uploaded'))).toBe(true);
    expect(lines.some((line) => line.includes('box_objects.token_refused'))).toBe(true);
    const signature = token.split('.')[2]!;
    expect(lines.filter((line) => line.includes(signature) || line.includes('token='))).toEqual([]);
  });
});
