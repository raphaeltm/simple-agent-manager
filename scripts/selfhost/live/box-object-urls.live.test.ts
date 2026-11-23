/**
 * Box object URLs on the real runtime (task tasks/active/2026-11-23-selfhost-box-object-uploads.md):
 * the production route and upload gate from apps/api/src/selfhost/object-urls/, bundled by celld's
 * own deploy, served by the pinned celld over the pinned object store. The unit suite
 * (apps/api/tests/unit/selfhost/box-object-urls.test.ts) covers the logic with a fake bucket; this
 * proves what only celld can: the body streams through FixedLengthStream into the R2 binding,
 * create-only puts and sha256 checks hold, the gate Durable Object is reached over RPC, and a body
 * over celld's 1 GiB ingress cap never reaches the Worker.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureCelldBinary } from '../celld-binary.js';
import { celldNode, type ObjectStore, startObjectStore, writeProject } from './celld-lab';
import { LIVE_TMP, REPO_ROOT, type Running, skipWithoutDocker } from './harness';

const OBJECT_URLS = join(REPO_ROOT, 'apps/api/src/selfhost/object-urls');
/** The project sits outside the repository, so bare packages resolve from apps/api. */
const HONO = createRequire(join(REPO_ROOT, 'apps/api/package.json')).resolve('hono');

// The production route and gate, plus a mint endpoint standing in for the authenticated routes
// that mint URLs in SAM (attachments, compose, build context).
const WORKER = `
import { Hono } from ${JSON.stringify(HONO)};
import { mountBoxObjectRoute } from ${JSON.stringify(join(OBJECT_URLS, 'index.ts'))};
import { createBoxObjectUrlSigner } from ${JSON.stringify(join(OBJECT_URLS, 'signer.ts'))};
export { BoxUploadGate } from ${JSON.stringify(join(OBJECT_URLS, 'gate.ts'))};

const app = new Hono();
app.get('/', (c) => c.text('ok'));
app.post('/mint', async (c) => {
  const body = await c.req.json();
  const signer = createBoxObjectUrlSigner(c.env);
  const url = body.op === 'get'
    ? await signer.getUrl(body.key, { expiresIn: 300 })
    : await signer.putUrl(body.key, { expiresIn: 300, owner: { userId: 'live' }, ...body.options });
  return c.json({ url });
});
// The real gate over celld's Durable Object SQL: renew must see its own row (cursor.rowsWritten).
app.post('/gate-probe', async (c) => {
  const gate = c.env.BOX_UPLOAD_GATE.get(c.env.BOX_UPLOAD_GATE.idFromName('box'));
  const limits = { total: 4, perUploader: 2, leaseMs: 60000 };
  const acquired = await gate.acquire('probe-lease', 'u:probe', 'temp-uploads/probe/k', limits);
  const sameKey = await gate.acquire('probe-other', 'u:other', 'temp-uploads/probe/k', limits);
  const held = await gate.renew('probe-lease', 60000);
  await gate.release('probe-lease');
  const afterRelease = await gate.renew('probe-lease', 60000);
  return c.json({ acquired, sameKey, held, afterRelease });
});
mountBoxObjectRoute(app);
export default app;
`;

const KEY = 'objectadmin';
/** A token that cannot verify: a well-formed prefix with an unsigned payload. */
const FORGED_TOKEN_PATH = `/api/box-objects?${new URLSearchParams({ token: ['samobj1', 'x', 'y'].join('.') })}`;
const SECRET = randomBytes(16).toString('hex');
let store: ObjectStore;
let celld: Running | undefined;
let port = 0;

/** A minted URL, rewritten to the local celld (the signer names https://api.<domain>). */
async function mint(op: 'put' | 'get', key: string, options: Record<string, unknown> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/mint`, {
    method: 'POST',
    body: JSON.stringify({ op, key, options }),
  });
  expect(response.status).toBe(200);
  const url = new URL(((await response.json()) as { url: string }).url);
  expect(url.hostname).toBe('api.box.test');
  return `http://127.0.0.1:${port}${url.pathname}${url.search}`;
}

/** PUT with a declared length; the body may be written slowly or left open. */
function put(
  url: string,
  length: number,
  write: (req: ReturnType<typeof request>) => void
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((done, fail) => {
    const req = request(
      url,
      { method: 'PUT', headers: { 'content-length': String(length) } },
      (res) => {
        res.resume();
        res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers }));
      }
    );
    req.on('error', fail);
    write(req);
  });
}

const putBytes = (url: string, body: Buffer) => put(url, body.length, (req) => req.end(body));

/** celld still serves after a refusal (a crash or reset would otherwise pass as a refusal). */
async function expectCelldResponsive(): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/`);
  expect(response.status).toBe(200);
}

describe.skipIf(skipWithoutDocker)('box object URLs on celld', () => {
  beforeAll(async () => {
    store = await startObjectStore(KEY, SECRET);
    const node = await celldNode(await ensureCelldBinary(join(LIVE_TMP, 'celld-bin')), store);
    port = node.port;
    mkdirSync(LIVE_TMP, { recursive: true });
    const project = writeProject(mkdtempSync(join(LIVE_TMP, 'box-object-urls-')), {
      name: 'box-object-urls',
      main: 'worker.ts',
      worker: WORKER,
      bindings: {
        compatibility_flags: ['nodejs_compat'],
        r2_buckets: [{ binding: 'R2', bucket_name: 'files' }],
        durable_objects: { bindings: [{ name: 'BOX_UPLOAD_GATE', class_name: 'BoxUploadGate' }] },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['BoxUploadGate'] }],
      },
      vars: { BASE_DOMAIN: 'box.test', ENCRYPTION_KEY: randomBytes(32).toString('base64') },
    });
    celld = await node.serve(project);
  });

  afterAll(async () => {
    if (process.env.BOX_DEBUG)
      console.log(
        celld
          ?.output()
          .split('\n')
          .filter((l) => l.includes('box_objects'))
          .join('\n')
      );
    await celld?.stop();
    store?.stop();
  });

  it('streams a 64 MiB upload into R2 and back, sha256-verified', async () => {
    const body = randomBytes(64 * 1024 * 1024);
    const sha = createHash('sha256').update(body).digest('hex');
    const url = await mint('put', 'compose-build-contexts/live/ctx.tar.zst', {
      contentLength: body.length,
      contentType: 'application/zstd',
      sha256: sha,
      metadata: { sha256: sha },
    });
    expect((await putBytes(url, body)).status).toBe(200);
    // Retry of a finished upload with the bound digest: 200, nothing replaced.
    expect((await putBytes(url, body)).status).toBe(200);
    const download = await fetch(await mint('get', 'compose-build-contexts/live/ctx.tar.zst'));
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/zstd');
    const got = Buffer.from(await download.arrayBuffer());
    expect(createHash('sha256').update(got).digest('hex')).toBe(sha);
  }, 120_000);

  it('refuses bytes that do not match the bound sha256, and stores nothing', async () => {
    const body = randomBytes(1024);
    const url = await mint('put', 'compose-build-contexts/live/bad.tar.zst', {
      contentLength: body.length,
      sha256: createHash('sha256').update('something else').digest('hex'),
    });
    expect((await putBytes(url, body)).status).toBe(400);
    expect((await fetch(await mint('get', 'compose-build-contexts/live/bad.tar.zst'))).status).toBe(
      404
    );
  });

  it('is create-only without a digest: the second write is 412 and the first stays', async () => {
    const url = await mint('put', 'temp-uploads/live/a.txt', { contentLength: 5 });
    expect((await putBytes(url, Buffer.from('first'))).status).toBe(200);
    expect((await putBytes(url, Buffer.from('other'))).status).toBe(412);
    expect(await (await fetch(await mint('get', 'temp-uploads/live/a.txt'))).text()).toBe('first');
  });

  it('is create-only above celld 8 MiB conditional-put size too (multipart writes)', async () => {
    const body = randomBytes(9 * 1024 * 1024);
    const url = await mint('put', 'compose-image-artifacts/live/web.tar', {
      maxBytes: 64 * 1024 * 1024,
    });
    expect((await putBytes(url, body)).status).toBe(200);
    expect((await putBytes(url, randomBytes(body.length))).status).toBe(412);
    const got = Buffer.from(
      await (await fetch(await mint('get', 'compose-image-artifacts/live/web.tar'))).arrayBuffer()
    );
    expect(got.equals(body)).toBe(true);
  }, 60_000);

  it('the gate on celld: same-key claims refuse, renew reports a held and a released lease', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/gate-probe`, { method: 'POST' });
    expect(await response.json()).toEqual({
      acquired: { granted: true },
      sameKey: { granted: false, reason: 'key-in-use' },
      held: true,
      afterRelease: false,
    });
  });

  it('a body shorter than declared leaves no object', async () => {
    const url = await mint('put', 'temp-uploads/live/short.bin', { maxBytes: 1024 });
    // Declares 100 bytes, sends 10, then closes: FixedLengthStream fails the put.
    await put(url, 100, (req) => {
      req.write(Buffer.alloc(10));
      setTimeout(() => req.destroy(), 300);
    }).catch(() => undefined);
    expect((await fetch(await mint('get', 'temp-uploads/live/short.bin'))).status).toBe(404);
  });

  it('over the token maximum is 413; over celld 1 GiB is refused before the Worker', async () => {
    const small = await mint('put', 'temp-uploads/live/big.bin', { maxBytes: 10 });
    expect((await putBytes(small, Buffer.alloc(11))).status).toBe(413);
    const huge = await mint('put', 'temp-uploads/live/huge.bin', { maxBytes: 1024 * 1024 * 1024 });
    // celld answers from the declared length alone, while the client has sent one byte; any other
    // transport outcome fails the test rather than counting as a refusal.
    let open: ReturnType<typeof request> | undefined;
    const refused = await put(huge, 1024 * 1024 * 1024 + 1, (req) => {
      open = req;
      req.write(Buffer.alloc(1));
    });
    open?.destroy();
    expect(refused.status).toBe(413);
    await expectCelldResponsive();
  });

  it('a bad token is refused before the body is read: a large unauthenticated body is not buffered', async () => {
    const pid = celld!.child.pid!;
    const rss = () =>
      Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))![1]) / 1024;
    const before = rss();
    let peak = before;
    const sampler = setInterval(() => (peak = Math.max(peak, rss())), 100);
    const length = 512 * 1024 * 1024;
    const chunk = Buffer.alloc(1024 * 1024);
    let sent = 0;
    const started = Date.now();
    // celld answers 403 and closes while a client that sends at once is still writing, so Node
    // usually reports a socket error instead of the response. (A client sending
    // `Expect: 100-continue`, as curl does for large bodies, gets the 403 and sends nothing.)
    const status = await new Promise<number>((done) => {
      const req = request(`http://127.0.0.1:${port}${FORGED_TOKEN_PATH}`, {
        method: 'PUT',
        headers: { 'content-length': String(length) },
      });
      req.on('response', (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      });
      // Only the early-close outcomes count; anything else fails the test.
      req.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNRESET' || error.code === 'EPIPE') done(-1);
        else throw error;
      });
      const write = () => {
        while (sent < length) {
          sent += chunk.length;
          if (!req.write(chunk)) return void req.once('drain', write);
        }
        req.end();
      };
      write();
    });
    clearInterval(sampler);
    expect([403, -1]).toContain(status);
    // Refused without reading the body: the connection ended long before 512 MiB was sent, and
    // celld held none of it.
    expect(sent).toBeLessThan(length / 4);
    await expectCelldResponsive();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(peak - before).toBeLessThan(100);
  }, 60_000);

  it('holds at most four uploads at once (four uploaders): the fifth gets 503 with Retry-After', async () => {
    const length = 1024 * 1024;
    const held: Array<ReturnType<typeof request>> = [];
    const pending = [];
    for (let i = 0; i < 4; i++) {
      const url = await mint('put', `temp-uploads/busy/${i}`, {
        contentLength: length,
        owner: { userId: `user-${i}` },
      });
      pending.push(
        put(url, length, (req) => {
          req.write(Buffer.alloc(1024));
          held.push(req);
        })
      );
    }
    // Let the four reach the gate.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const fifth = await putBytes(
      await mint('put', 'temp-uploads/busy/5', { contentLength: 4, owner: { userId: 'user-5' } }),
      Buffer.from('five')
    );
    expect(fifth.status).toBe(503);
    expect(Number(fifth.headers['retry-after'])).toBeGreaterThan(0);
    for (const req of held) req.end(Buffer.alloc(length - 1024));
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual([200, 200, 200, 200]);
    // Every lease was released: a new upload is admitted.
    const after = await putBytes(
      await mint('put', 'temp-uploads/busy/6', { contentLength: 3, owner: { userId: 'user-6' } }),
      Buffer.from('six')
    );
    expect(after.status).toBe(200);
  }, 60_000);
});
