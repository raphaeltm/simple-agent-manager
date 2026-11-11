/**
 * The GCE metadata token proxy (deploy/selfhost/metadata-proxy/Caddyfile) in the pinned Caddy
 * image, against a stub metadata server: it serves only the default service account's token,
 * always with the Cloud Storage scope whatever the caller asked for, only under the secret path,
 * only for GET with Metadata-Flavor, and never forwards X-Forwarded-For.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_GCE_METADATA_PROXY_SCOPES } from '../egress-fence.js';
import { caddyRuntimeImage, freePort, REPO_ROOT, waitFor } from './harness';

const SECRET = randomBytes(32).toString('hex');
const TOKEN_PATH = '/computeMetadata/v1/instance/service-accounts/default/token';

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

const seen: Seen[] = [];
let upstream: Server;
let port = 0;
let container = '';

async function ask(
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { 'Metadata-Flavor': 'Google', ...(init.headers as Record<string, string>) },
  });
  return { status: response.status, body: await response.text() };
}

/** Sends `path` byte for byte (fetch would normalise `..` and `%2e`); resolves the status. */
function rawGet(target: number, path: string, flavor = 'Google', method = 'GET'): Promise<number> {
  return new Promise((done, fail) => {
    const socket = connect(target, '127.0.0.1', () => {
      socket.write(
        `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nMetadata-Flavor: ${flavor}\r\nConnection: close\r\n\r\n`
      );
    });
    let reply = '';
    socket.on('data', (chunk: Buffer) => (reply += chunk.toString()));
    socket.on('end', () => done(Number(/^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1] ?? 0)));
    socket.on('error', fail);
  });
}

/** The proxy in the pinned Caddy image, on the host network, logging nothing. */
function startProxy(name: string, listen: number, secret: string, upstream: number): void {
  const env = {
    GCE_METADATA_PROXY_PORT: String(listen),
    GCE_METADATA_PROXY_SECRET: secret,
    GCE_METADATA_UPSTREAM: `127.0.0.1:${upstream}`,
  };
  execFileSync('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--network',
    'host',
    '--read-only',
    '--tmpfs',
    '/data',
    '--tmpfs',
    '/config',
    '-v',
    `${REPO_ROOT}/deploy/selfhost/metadata-proxy/Caddyfile:/etc/caddy/Caddyfile:ro`,
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    caddyRuntimeImage(),
    'caddy',
    'run',
    '--config',
    '/etc/caddy/Caddyfile',
    '--adapter',
    'caddyfile',
  ]);
}

let emptySecretPort = 0;
let emptySecretContainer = '';

beforeAll(async () => {
  port = await freePort();
  const upstreamPort = await freePort();
  upstream = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    res.end('{"access_token":"stub","expires_in":3599,"token_type":"Bearer"}');
  });
  await new Promise<void>((done) => upstream.listen(upstreamPort, '127.0.0.1', done));
  container = `sam-live-metadata-${randomBytes(4).toString('hex')}`;
  startProxy(container, port, SECRET, upstreamPort);
  emptySecretPort = await freePort();
  emptySecretContainer = `${container}-empty`;
  startProxy(emptySecretContainer, emptySecretPort, '', upstreamPort);
  await waitFor(
    'the metadata proxy to listen',
    async () => {
      try {
        return (await ask('/')).status === 404;
      } catch {
        return false;
      }
    },
    120_000
  );
});

afterAll(async () => {
  for (const name of [container, emptySecretContainer]) {
    if (name) execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  }
  await new Promise<void>((done) => (upstream ? upstream.close(() => done()) : done()));
});

beforeEach(() => {
  seen.length = 0;
});

describe('GCE metadata token proxy', () => {
  it('serves the token with the Cloud Storage scope, whatever the caller asked for', async () => {
    const asked = `/${SECRET}${TOKEN_PATH}?scopes=https://www.googleapis.com/auth/cloud-platform&audience=x`;
    const reply = await ask(asked, { headers: { 'X-Forwarded-For': '10.0.0.9' } });
    expect(reply).toEqual({ status: 200, body: expect.stringContaining('"access_token":"stub"') });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${TOKEN_PATH}?scopes=${DEFAULT_GCE_METADATA_PROXY_SCOPES}`);
    expect(seen[0]!.headers.host).toBe('metadata.google.internal');
    expect(seen[0]!.headers['metadata-flavor']).toBe('Google');
    expect(seen[0]!.headers['x-forwarded-for']).toBeUndefined();
  });

  it('control: a plain token request gets the same forced scope', async () => {
    expect((await ask(`/${SECRET}${TOKEN_PATH}`)).status).toBe(200);
    expect(seen.map((request) => request.url)).toEqual([
      `${TOKEN_PATH}?scopes=${DEFAULT_GCE_METADATA_PROXY_SCOPES}`,
    ]);
  });

  it.each([
    ['the email path', `/${SECRET}/computeMetadata/v1/instance/service-accounts/default/email`],
    [
      'an identity token',
      `/${SECRET}/computeMetadata/v1/instance/service-accounts/default/identity?audience=x`,
    ],
    ['project data', `/${SECRET}/computeMetadata/v1/project/project-id`],
    ['instance attributes', `/${SECRET}/computeMetadata/v1/instance/attributes/`],
    [
      'another service account',
      `/${SECRET}/computeMetadata/v1/instance/service-accounts/other@x/token`,
    ],
    ['the token without the secret', TOKEN_PATH],
    ['the token under a wrong secret', `/${'0'.repeat(64)}${TOKEN_PATH}`],
  ])('refuses %s', async (_name, path) => {
    expect((await ask(path)).status).toBe(404);
    expect(seen).toEqual([]);
  });

  it.each([
    ['dot segments', `/${SECRET}${TOKEN_PATH}/../email`],
    [
      'encoded dot segments',
      `/${SECRET}/computeMetadata/v1/instance/service-accounts/default/%2e%2e/default/email`,
    ],
    ['an encoded slash', `/${SECRET}/computeMetadata/v1/instance/service-accounts/default%2Femail`],
    ['a trailing slash', `/${SECRET}${TOKEN_PATH}/`],
    ['extra segments', `/${SECRET}${TOKEN_PATH}/x`],
  ])('refuses a raw path with %s, never reaching the metadata server', async (_name, path) => {
    expect(await rawGet(port, path)).toBe(404);
    expect(seen).toEqual([]);
  });

  it('refuses HEAD and a Metadata-Flavor other than Google (raw request)', async () => {
    expect(await rawGet(port, `/${SECRET}${TOKEN_PATH}`, 'Google', 'HEAD')).toBe(404);
    expect(await rawGet(port, `/${SECRET}${TOKEN_PATH}`, 'Evil')).toBe(404);
    expect(seen).toEqual([]);
    expect(await rawGet(port, `/${SECRET}${TOKEN_PATH}`)).toBe(200); // liveness control
  });

  it('with an empty secret it serves nothing, not the bare metadata path', async () => {
    await waitFor(
      'the empty-secret proxy to listen',
      async () => {
        try {
          return (await rawGet(emptySecretPort, '/')) === 404;
        } catch {
          return false;
        }
      },
      120_000
    );
    for (const path of [TOKEN_PATH, `/${TOKEN_PATH}`]) {
      expect(await rawGet(emptySecretPort, path)).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  it('refuses the token without Metadata-Flavor, and for any method but GET', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/${SECRET}${TOKEN_PATH}`);
    expect(response.status).toBe(404);
    expect((await ask(`/${SECRET}${TOKEN_PATH}`, { method: 'POST' })).status).toBe(404);
    expect(seen).toEqual([]);
  });
});
