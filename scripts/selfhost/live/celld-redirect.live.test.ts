/**
 * The API's guarded fetch on the real celld runtime (`celld dev`, the pinned, checksum-verified
 * release), not a mocked fetch: the guard is only as good as the runtime's `redirect: 'manual'`.
 *
 * A Worker bundles packages/worker-core/src/network-hosts and calls stub servers on loopback. The first
 * case records why the guard exists: celld's default fetch follows a 302 to an internal service
 * and hands back its body (res.redirected stays false, so nothing downstream can tell).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureCelldBinary, resolveEsbuild } from '../celld-binary.js';
import { freePort, LIVE_TMP, REPO_ROOT, type Running, start, waitFor } from './harness';

const NETWORK_HOSTS = join(REPO_ROOT, 'packages/worker-core/src/network-hosts/index.ts');

const WORKER = `
import { guardedFetch } from ${JSON.stringify(NETWORK_HOSTS)};

async function run(fn) {
  try {
    const response = await fn();
    return { status: response.status, location: response.headers.get('location'), body: await response.text() };
  } catch (error) {
    return { error: String(error && error.name), reason: error && error.reason };
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get('target');
    const policy = { allowPrivateNetwork: true };
    const cases = {
      '/default': () => fetch(target),
      '/manual': () => fetch(target, { redirect: 'manual' }),
      '/guarded': () => guardedFetch(target, {}, policy),
    };
    const fn = cases[url.pathname];
    return fn ? Response.json(await run(fn)) : new Response('celld-redirect');
  },
};
`;

let edge: Server;
let internal: Server;
let ports: { edge: number; internal: number; celld: number };
let celld: Running | undefined;
let internalHits = 0;

beforeAll(async () => {
  ports = { edge: await freePort(), internal: await freePort(), celld: await freePort() };
  internal = createServer((_req, res) => {
    internalHits += 1;
    res.end('INTERNAL');
  });
  edge = createServer((req, res) => {
    const path = req.url ?? '/';
    const hop = /^\/chain\/(\d+)$/.exec(path);
    if (path === '/to-internal') {
      res.writeHead(302, { Location: `http://127.0.0.1:${ports.internal}/secret` });
    } else if (path === '/to-same') {
      res.writeHead(302, { Location: '/final' });
    } else if (hop) {
      res.writeHead(302, { Location: `/chain/${Number(hop[1]) + 1}` });
    } else {
      res.writeHead(200);
    }
    res.end(path === '/final' ? 'FINAL' : '');
  });
  await new Promise<void>((done) => internal.listen(ports.internal, '127.0.0.1', done));
  await new Promise<void>((done) => edge.listen(ports.edge, '127.0.0.1', done));

  mkdirSync(LIVE_TMP, { recursive: true });
  const project = mkdtempSync(join(LIVE_TMP, 'celld-redirect-'));
  writeFileSync(
    join(project, 'wrangler.json'),
    JSON.stringify({ name: 'redirect-probe', main: 'worker.js', compatibility_date: '2026-01-01' })
  );
  writeFileSync(join(project, 'worker.js'), WORKER);
  const binary = await ensureCelldBinary(join(LIVE_TMP, 'celld-bin'));
  celld = start(
    'bash',
    [
      '-c',
      `cd "$0" && exec "$1" dev . --host 127.0.0.1 --port "$2"`,
      project,
      binary,
      String(ports.celld),
    ],
    { CELLD_ESBUILD: resolveEsbuild(join(REPO_ROOT, 'apps/api')) }
  );
  await waitFor(
    'celld dev to serve the Worker',
    async () => {
      try {
        return (await fetch(`http://127.0.0.1:${ports.celld}/`)).status === 200;
      } catch {
        return false;
      }
    },
    120_000,
    () => celld?.output() ?? ''
  );
});

afterAll(async () => {
  await celld?.stop();
  await new Promise<void>((done) => (edge ? edge.close(() => done()) : done()));
  await new Promise<void>((done) => (internal ? internal.close(() => done()) : done()));
});

async function ask(path: string, target: string): Promise<Record<string, unknown>> {
  const url = `http://127.0.0.1:${ports.celld}${path}?target=${encodeURIComponent(target)}`;
  return (await (await fetch(url)).json()) as Record<string, unknown>;
}

const at = (path: string): string => `http://127.0.0.1:${ports.edge}${path}`;

describe('redirects on the real celld runtime', () => {
  it("celld's default fetch follows a redirect to an internal service (why the guard exists)", async () => {
    const before = internalHits;
    expect(await ask('/default', at('/to-internal'))).toMatchObject({
      status: 200,
      body: 'INTERNAL',
    });
    expect(internalHits).toBe(before + 1);
  });

  it("redirect: 'manual' returns the 302 and its Location, and nothing follows it", async () => {
    const before = internalHits;
    expect(await ask('/manual', at('/to-internal'))).toMatchObject({
      status: 302,
      location: `http://127.0.0.1:${ports.internal}/secret`,
    });
    expect(internalHits).toBe(before);
  });

  it('guardedFetch refuses a hop to another private origin before requesting it', async () => {
    const before = internalHits;
    expect(await ask('/guarded', at('/to-internal'))).toEqual({
      error: 'OutboundRequestRefusedError',
      reason: 'host',
    });
    expect(internalHits).toBe(before);
  });

  it('control: guardedFetch follows a validated same-origin hop to the final response', async () => {
    expect(await ask('/guarded', at('/to-same'))).toMatchObject({ status: 200, body: 'FINAL' });
  });

  it('guardedFetch stops a redirect chain past the hop limit', async () => {
    expect(await ask('/guarded', at('/chain/0'))).toEqual({
      error: 'OutboundRequestRefusedError',
      reason: 'redirect_limit',
    });
  });
});
