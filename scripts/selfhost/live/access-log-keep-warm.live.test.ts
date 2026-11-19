/**
 * Live: Caddy's access log, its redaction, and the keep-warm health check
 * (deploy/selfhost/caddy/Caddyfile, log-redaction.caddy, keep-warm/), on the box's Caddy image
 * (built from caddy/Dockerfile) started through start.sh exactly as docker-compose.yml starts it, in front of a stub celld that
 * records what reaches it.
 *
 * Checked: one access-log line per request on stdout, with host, method, path, status and
 * duration; no header value (cookie, Authorization, X-SAM-*), no query string and no gateway
 * secret in the access log or in Caddy's own log, including a proxy-error entry; keep-warm sends
 * GET /health on the API host, a failing /health leaves real traffic untouched, SAM_KEEP_WARM=off
 * sends nothing, and start.sh refuses invalid keep-warm and frp rate-limit settings and a box
 * port inside the reverse-tunnel lease range.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  caddyBoxEnv,
  type CaddyRun,
  freePort,
  httpsGet,
  LIVE_TUNNEL_RANGE,
  runCaddyToExit,
  skipWithoutDocker,
  sleep,
  startCaddy as startBoxCaddy,
  waitFor,
} from './harness';

const DOMAIN = 'sam.test';
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

type Stack = CaddyRun;

let celld: Server;
let celldPort = 0;
let healthStatus = 200;
const hits: Hit[] = [];
const stacks: Stack[] = [];

async function baseEnv(extra: Record<string, string>): Promise<Record<string, string>> {
  return {
    ...(await caddyBoxEnv()),
    SAM_DOMAIN: DOMAIN,
    SAM_TLS_MODE: 'internal',
    CELLD_PORT: String(celldPort),
    REVERSE_TUNNEL_GATEWAY_SECRET: GATEWAY_SECRET,
    ...extra,
  };
}

async function startCaddy(extra: Record<string, string>): Promise<Stack> {
  const stack = await startBoxCaddy(await baseEnv(extra));
  stacks.push(stack);
  return stack;
}

const get = (stack: Stack, host: string, path: string, headers: Record<string, string> = {}) =>
  httpsGet(stack, host, path, headers);

function accessLines(stack: Stack): Array<Record<string, unknown>> {
  return stack
    .stdout()
    .split('\n')
    .filter((line) => line.includes('"http.log.access'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Removes every running stack, so pings counted next come only from the stack a test starts. */
function stopStacks(): void {
  for (const stack of stacks.splice(0)) stack.stop();
}

function healthHitsSince(start: number): Hit[] {
  return hits.slice(start).filter((hit) => hit.url === '/health');
}

// Needs Docker (harness skipWithoutDocker: skipped without it locally, never in CI).
describe.skipIf(skipWithoutDocker)('Caddy access log and keep-warm (live)', () => {
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
    for (const stack of stacks) stack.stop();
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
          line = accessLines(stack).find((entry) =>
            JSON.stringify(entry).includes('/api/projects')
          );
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
    beforeEach(stopStacks);
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
      [{ SAM_FRP_LOGIN_RATE_LIMIT_EVENTS: '0' }, /SAM_FRP_LOGIN_RATE_LIMIT_EVENTS must be/],
      [{ SAM_FRP_LOGIN_RATE_LIMIT_WINDOW: '2d' }, /SAM_FRP_LOGIN_RATE_LIMIT_WINDOW must be/],
      // A shell override handed straight to docker compose (F21 L5): celld's operator port inside
      // the lease range the deploy wrote to gateway.env.
      [
        { CELLD_INTERNAL_PORT: String(LIVE_TUNNEL_RANGE.start + 1) },
        /CELLD_INTERNAL_PORT \(20001\) lies inside the reverse-tunnel range 20000-20099/,
      ],
      [{ REVERSE_TUNNEL_PORT_RANGE_END: '' }, /REVERSE_TUNNEL_PORT_RANGE_START\/END missing/],
    ])('start.sh refuses %j', async (extra, message) => {
      const run = runCaddyToExit(await baseEnv(extra));
      expect(run.status).toBe(64);
      expect(run.stderr).toMatch(message);
    });
  });
});
