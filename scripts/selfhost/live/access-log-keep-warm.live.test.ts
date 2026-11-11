/**
 * Live: Caddy's access log, its redaction, and the keep-warm health check
 * (deploy/selfhost/caddy/Caddyfile, log-redaction.caddy, keep-warm/), on the pinned Caddy image
 * started through start.sh exactly as docker-compose.yml starts it, in front of a stub celld that
 * records what reaches it.
 *
 * Checked: one access-log line per request on stdout, with host, method, path, status and
 * duration; no header value (cookie, Authorization, X-SAM-*), no query string and no gateway
 * secret in the access log or in Caddy's own log, including a proxy-error entry; keep-warm sends
 * GET /health on the API host, a failing /health leaves real traffic untouched, SAM_KEEP_WARM=off
 * sends nothing, and start.sh refuses invalid keep-warm settings.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { caddyRuntimeImage, freePort, REPO_ROOT, sleep, waitFor } from './harness';

const DOMAIN = 'sam.test';
const CADDY_DIR = `${REPO_ROOT}/deploy/selfhost/caddy`;
const GATEWAY_SECRET = `gw${randomBytes(24).toString('hex')}`;
const SECRETS = {
  cookie: `ck${randomBytes(12).toString('hex')}`,
  bearer: `br${randomBytes(12).toString('hex')}`,
  samHeader: `xs${randomBytes(12).toString('hex')}`,
  query: `qy${randomBytes(12).toString('hex')}`,
  responseCookie: `rc${randomBytes(12).toString('hex')}`,
};

interface Hit {
  host: string;
  url: string;
}

interface Stack {
  container: string;
  https: number;
  stdout: () => string;
  stderr: () => string;
}

let celld: Server;
let celldPort = 0;
let healthStatus = 200;
const hits: Hit[] = [];
const stacks: Stack[] = [];

function caddyArgs(name: string, env: Record<string, string>): string[] {
  return [
    'run',
    '-d',
    '--name',
    name,
    '--network',
    'host',
    '-v',
    `${CADDY_DIR}:/etc/caddy:ro`,
    '--cap-drop',
    'ALL',
    '--cap-add',
    'NET_BIND_SERVICE',
    '--entrypoint',
    '/bin/sh',
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    caddyRuntimeImage(),
    '/etc/caddy/start.sh',
  ];
}

async function baseEnv(extra: Record<string, string>): Promise<Record<string, string>> {
  return {
    SAM_DOMAIN: DOMAIN,
    SAM_TLS_MODE: 'internal',
    HTTP_PORT: String(await freePort()),
    HTTPS_PORT: String(await freePort()),
    CELLD_PORT: String(celldPort),
    FRPS_BIND_PORT: String(await freePort()),
    REVERSE_TUNNEL_GATEWAY_SECRET: GATEWAY_SECRET,
    ...extra,
  };
}

async function startCaddy(extra: Record<string, string>): Promise<Stack> {
  const env = await baseEnv(extra);
  const container = `sam-live-log-${randomBytes(4).toString('hex')}`;
  execFileSync('docker', caddyArgs(container, env));
  const read = () => spawnSync('docker', ['logs', container], { encoding: 'utf8' });
  const stack: Stack = {
    container,
    https: Number(env.HTTPS_PORT),
    stdout: () => read().stdout ?? '',
    stderr: () => read().stderr ?? '',
  };
  stacks.push(stack);
  await waitFor(
    'Caddy to serve TLS',
    async () => {
      try {
        return (await get(stack, `app.${DOMAIN}`, '/ready')).status === 200;
      } catch {
        return false;
      }
    },
    120_000,
    stack.stderr
  );
  return stack;
}

function get(
  stack: Stack,
  host: string,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number }> {
  return new Promise((done, fail) => {
    const req = httpsRequest({
      host: '127.0.0.1',
      port: stack.https,
      servername: host,
      rejectUnauthorized: false,
      path,
      headers: { Host: host, ...headers },
    });
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => done({ status: res.statusCode ?? 0 }));
    });
    req.on('error', fail);
    req.end();
  });
}

function accessLines(stack: Stack): Array<Record<string, unknown>> {
  return stack
    .stdout()
    .split('\n')
    .filter((line) => line.includes('"http.log.access'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function healthHitsSince(start: number): Hit[] {
  return hits.slice(start).filter((hit) => hit.url === '/health');
}

beforeAll(async () => {
  celldPort = await freePort();
  celld = createServer((req, res) => {
    hits.push({ host: req.headers.host ?? '', url: req.url ?? '' });
    if (req.url === '/health') {
      res.statusCode = healthStatus;
      res.end('health');
      return;
    }
    res.setHeader('Set-Cookie', `session=${SECRETS.responseCookie}`);
    res.end('celld');
  });
  await new Promise<void>((done) => celld.listen(celldPort, '127.0.0.1', done));
});

afterAll(async () => {
  for (const stack of stacks) spawnSync('docker', ['rm', '-f', stack.container]);
  await new Promise<void>((done) => celld.close(() => done()));
});

describe('access log', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startCaddy({ SAM_KEEP_WARM: 'off' });
  });

  it('logs one line per request with host, path, status and duration, and nothing secret', async () => {
    const reply = await get(stack, `app.${DOMAIN}`, `/api/projects?token=${SECRETS.query}&x=1`, {
      Cookie: `__Secure-better-auth.session_token=${SECRETS.cookie}`,
      Authorization: `Bearer ${SECRETS.bearer}`,
      'X-SAM-Upstream-Authorization': SECRETS.samHeader,
    });
    expect(reply.status).toBe(200);
    // Liveness: the request did reach celld with its query, so redaction is in the log only.
    expect(hits.some((hit) => hit.url.includes(SECRETS.query))).toBe(true);

    let line: Record<string, unknown> | undefined;
    await waitFor(
      'the access-log line',
      async () => {
        line = accessLines(stack).find((entry) => JSON.stringify(entry).includes('/api/projects'));
        return line !== undefined;
      },
      10_000,
      stack.stderr
    );
    const request = line!.request as Record<string, unknown>;
    expect(request.host).toBe(`app.${DOMAIN}`);
    expect(request.method).toBe('GET');
    expect(request.uri).toBe('/api/projects?<redacted>');
    expect(request.headers).toBeUndefined();
    expect(line!.resp_headers).toBeUndefined();
    expect(line!.status).toBe(200);
    expect(typeof line!.duration).toBe('number');

    const everything = stack.stdout() + stack.stderr();
    for (const secret of [...Object.values(SECRETS), GATEWAY_SECRET]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('replaces a credential carried in the path, and leaves other paths alone', async () => {
    const token = `pt${randomBytes(12).toString('hex')}`;
    const cases: Array<[string, string, string]> = [
      [
        `api.${DOMAIN}`,
        `/ai/proxy/${token}/anthropic/v1/messages`,
        '/ai/proxy/<redacted>/anthropic/v1/messages',
      ],
      [`api.${DOMAIN}`, `/api/bootstrap/${token}`, '/api/bootstrap/<redacted>'],
      [
        `api.${DOMAIN}`,
        `/api/projects/invite-links/${token}/request?x=1`,
        '/api/projects/invite-links/<redacted>/request?<redacted>',
      ],
      [`app.${DOMAIN}`, `/projects/invite/${token}`, '/projects/invite/<redacted>'],
      [`preview.${DOMAIN}`, `/p/proj/file/1/9999/${token}/index.html`, '/p/<redacted>'],
      [`api.${DOMAIN}`, '/api/projects/p1/sessions', '/api/projects/p1/sessions'],
    ];
    for (const [host, path] of cases) expect((await get(stack, host, path)).status).toBe(200);
    await waitFor('every path-case line', async () => {
      const uris = accessLines(stack).map((line) => (line.request as { uri?: string }).uri);
      return cases.every(([, , logged]) => uris.includes(logged));
    });
    // Liveness: the token reached celld unchanged; only the log is redacted.
    expect(hits.filter((hit) => hit.url.includes(token))).toHaveLength(5);
    expect(stack.stdout() + stack.stderr()).not.toContain(token);
  });

  it('redacts the query of a proxy-error entry in Caddy own log', async () => {
    const down = await startCaddy({ SAM_KEEP_WARM: 'off', CELLD_PORT: String(await freePort()) });
    expect((await get(down, `api.${DOMAIN}`, `/x?t=${SECRETS.query}`)).status).toBe(502);
    await waitFor('the proxy error entry', async () => down.stderr().includes('/x?<redacted>'));
    expect(down.stdout() + down.stderr()).not.toContain(SECRETS.query);
  });
});

describe('keep-warm', () => {
  it('sends GET /health on the API host while idle', async () => {
    const start = hits.length;
    await startCaddy({ SAM_KEEP_WARM: 'on', SAM_KEEP_WARM_INTERVAL: '1s' });
    await waitFor('three keep-warm pings', async () => healthHitsSince(start).length >= 3);
    expect(healthHitsSince(start).every((hit) => hit.host === `api.${DOMAIN}`)).toBe(true);
  });

  it('a failing /health leaves real traffic untouched', async () => {
    const stack = await startCaddy({ SAM_KEEP_WARM: 'on', SAM_KEEP_WARM_INTERVAL: '1s' });
    healthStatus = 503;
    try {
      const start = hits.length;
      await waitFor('two failed pings', async () => healthHitsSince(start).length >= 2);
      for (let i = 0; i < 3; i++) {
        expect((await get(stack, `app.${DOMAIN}`, '/projects')).status).toBe(200);
      }
    } finally {
      healthStatus = 200;
    }
  });

  it('SAM_KEEP_WARM=off sends nothing', async () => {
    const stack = await startCaddy({ SAM_KEEP_WARM: 'off', SAM_KEEP_WARM_INTERVAL: '1s' });
    const start = hits.length;
    await sleep(3_500);
    expect(healthHitsSince(start)).toEqual([]);
    // Liveness: this Caddy is serving.
    expect((await get(stack, `app.${DOMAIN}`, '/projects')).status).toBe(200);
  });

  it.each([
    [{ SAM_KEEP_WARM: 'yes' }, /SAM_KEEP_WARM must be on or off/],
    [{ SAM_KEEP_WARM_INTERVAL: '7s' }, /SAM_KEEP_WARM_INTERVAL must be 1s to 6s/],
  ])('start.sh refuses %j', async (extra, message) => {
    const container = `sam-live-log-${randomBytes(4).toString('hex')}`;
    const run = spawnSync(
      'docker',
      caddyArgs(container, await baseEnv(extra)).map((arg) => (arg === '-d' ? '--rm' : arg)),
      { encoding: 'utf8', timeout: 60_000 }
    );
    expect(run.status).toBe(64);
    expect(run.stderr).toMatch(message);
  });
});
