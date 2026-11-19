/**
 * `pnpm selfhost:deploy`'s post-deploy steps (celld-adopt.ts `verifyNewVersionServes`, called by
 * deploy.ts right after `celld deploy`), against a small fake celld on loopback that behaves like
 * celld 0.6.3: the API serves the ADOPTED version until `POST /reload` (or the 30 s poll, not
 * modelled) switches it to the version the pointer names; a version that does not build is
 * refused with 422 and the old one keeps serving. The fake answers only `POST /reload` on the
 * internal listener, as celld does. (Node's fetch does not send a custom Host header, so the
 * box's single Worker answers by path, which is what this fake models.)
 *
 * Box round R15 (G3): the deploy checked only /health, which the previous version also answers,
 * so the agent sign-in route the new version added answered 404 for ~20 s after "deployed".
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  adoptNewDeployment,
  AGENT_SIGN_IN_PATH,
  checkAgentSignInRoute,
  verifyNewVersionServes,
} from './celld-adopt';
import { waitForHealth } from './deploy-steps';

interface Version {
  id: string;
  builds: boolean;
  /** The Worker has a usable AGENT_SIGN_IN_TRUST, so the route answers instead of 404. */
  agentSignIn: boolean;
}

const DOMAIN = 'sam.example.com';
const ENV_KEYS = [
  'SELFHOST_ADOPT_CHECK_WINDOW_MS',
  'SELFHOST_HEALTH_POLL_INTERVAL_MS',
  'SELFHOST_HEALTH_TIMEOUT_MS',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let internal: Server;
let api: Server;
let box: Record<string, string>;
let serving: Version;
let pointer: Version;
let reloads: number;
let refuseReloads: number;
let reloadStatus: number | null;
let routeStatus: number | null;
/** Every request the fake celld answered, in order: what the deploy did, and when. */
let events: string[];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return String((server.address() as AddressInfo).port);
}

/** What `celld deploy` does: write a new pointer. The node keeps serving the old version. */
function celldDeploy(version: Version): void {
  pointer = version;
}

const verify = (agentSignInConfigured: boolean, log: string[] = []) =>
  verifyNewVersionServes(
    box,
    { celldPort: box.CELLD_PORT!, baseDomain: DOMAIN, agentSignInConfigured },
    (line) => log.push(line)
  );

beforeEach(async () => {
  reloads = 0;
  refuseReloads = 0;
  reloadStatus = null;
  routeStatus = null;
  events = [];
  serving = { id: 'v1', builds: true, agentSignIn: false };
  pointer = serving;
  internal = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/reload') {
      events.push(`internal ${req.method} ${req.url}`);
      return void res.writeHead(404).end();
    }
    reloads += 1;
    if (reloads <= refuseReloads) {
      req.socket.destroy();
      return;
    }
    if (reloadStatus !== null) return void res.writeHead(reloadStatus).end('{}');
    if (!pointer.builds) {
      events.push(`reload failed ${pointer.id}`);
      res
        .writeHead(422, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({ ok: false, outcome: 'failed', version: pointer.id, error: 'syntax' })
        );
      return;
    }
    serving = pointer;
    events.push(`reload ${serving.id}`);
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: true, outcome: 'adopted', generation: 2, version: serving.id }));
  });
  api = createServer((req, res) => {
    if (req.url === '/health') {
      events.push(`health ${serving.id}`);
      return void res.writeHead(200).end('{"status":"healthy"}');
    }
    if (req.url === AGENT_SIGN_IN_PATH && req.method === 'POST') {
      events.push(`sign-in ${serving.id}`);
      // The route steps aside (404) when the serving Worker has no usable trust.
      const status = routeStatus ?? (serving.agentSignIn ? 400 : 404);
      return void res.writeHead(status).end('{}');
    }
    res.writeHead(404).end();
  });
  box = {
    SAM_DOMAIN: DOMAIN,
    CELLD_INTERNAL_PORT: await listen(internal),
    CELLD_PORT: await listen(api),
  };
  process.env.SELFHOST_ADOPT_CHECK_WINDOW_MS = '2000';
  process.env.SELFHOST_HEALTH_POLL_INTERVAL_MS = '20';
  process.env.SELFHOST_HEALTH_TIMEOUT_MS = '2000';
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const server of [internal, api]) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

describe('after celld deploy (verifyNewVersionServes, G3)', () => {
  it('adopts first, so health and the agent sign-in route are checked on the new version', async () => {
    celldDeploy({ id: 'v2', builds: true, agentSignIn: true });
    const log: string[] = [];
    await verify(true, log);
    expect(events).toEqual(['reload v2', 'health v2', 'sign-in v2']);
    expect(log).toEqual([
      'celld adopted the new version: adopted version v2',
      'agent sign-in route answers on the new version',
    ]);
  });

  it('does not probe the agent sign-in route when no trust is configured', async () => {
    celldDeploy({ id: 'v2', builds: true, agentSignIn: false });
    await verify(false);
    expect(events).toEqual(['reload v2', 'health v2']);
  });

  it('stops the deploy when the trust is configured but the new version has no usable trust', async () => {
    process.env.SELFHOST_ADOPT_CHECK_WINDOW_MS = '200';
    celldDeploy({ id: 'v2', builds: true, agentSignIn: false });
    await expect(verify(true)).rejects.toThrow(/answers HTTP 404.*agent_sign_in\.config_invalid/);
    expect(events.slice(0, 2)).toEqual(['reload v2', 'health v2']);
  });

  it('stops at once, before any check, when the new version does not build', async () => {
    celldDeploy({ id: 'v2', builds: false, agentSignIn: true });
    await expect(verify(true)).rejects.toThrow(
      /HTTP 422 version v2: syntax\)\. The previous version keeps serving\.$/
    );
    expect(events).toEqual(['reload failed v2']);
    expect(serving.id).toBe('v1');
  });

  it('without the adoption step (the R15 deploy), health passes on the old version and the route 404s', async () => {
    // Control for the ordering above: the checks alone cannot tell the versions apart.
    celldDeploy({ id: 'v2', builds: true, agentSignIn: true });
    await waitForHealth(box.CELLD_PORT!, DOMAIN);
    process.env.SELFHOST_ADOPT_CHECK_WINDOW_MS = '200';
    await expect(checkAgentSignInRoute(box)).rejects.toThrow(/answers HTTP 404/);
    expect(events[0]).toBe('health v1');
  });
});

describe('adoptNewDeployment', () => {
  it('rides out a refused reload while celld stalls', async () => {
    refuseReloads = 2;
    celldDeploy({ id: 'v2', builds: true, agentSignIn: false });
    expect(await adoptNewDeployment(box)).toBe('adopted version v2');
    expect(reloads).toBe(3);
  });

  it('retries a 500 until the window ends, then names celld’s poll', async () => {
    reloadStatus = 500;
    process.env.SELFHOST_ADOPT_CHECK_WINDOW_MS = '200';
    await expect(adoptNewDeployment(box)).rejects.toThrow(/HTTP 500\).*CELLD_DEPLOY_POLL_S/);
    expect(reloads).toBeGreaterThan(1);
  });

  it('names the celld version on a 404 (no /reload before 0.6.3)', async () => {
    reloadStatus = 404;
    process.env.SELFHOST_ADOPT_CHECK_WINDOW_MS = '100';
    await expect(adoptNewDeployment(box)).rejects.toThrow(/celld 0\.6\.3 or later/);
  });

  it('fails after the window when celld never answers', async () => {
    refuseReloads = Number.POSITIVE_INFINITY;
    process.env.SELFHOST_ADOPT_CHECK_WINDOW_MS = '200';
    await expect(adoptNewDeployment(box)).rejects.toThrow(
      /celld did not adopt the deployment .*CELLD_DEPLOY_POLL_S/
    );
    expect(reloads).toBeGreaterThan(1);
  });
});

describe('checkAgentSignInRoute', () => {
  it('retries a 404 and passes once the route appears within the window', async () => {
    setTimeout(() => {
      serving = { ...serving, agentSignIn: true };
    }, 120);
    await checkAgentSignInRoute(box);
    expect(events.filter((e) => e.startsWith('sign-in')).length).toBeGreaterThan(1);
  });

  it('does not count a 500 as present', async () => {
    routeStatus = 500;
    process.env.SELFHOST_ADOPT_CHECK_WINDOW_MS = '100';
    await expect(checkAgentSignInRoute(box)).rejects.toThrow(/answers HTTP 500/);
  });

  it.each([400, 401, 429])('counts %i as present (the route answered)', async (status) => {
    routeStatus = status;
    await checkAgentSignInRoute(box);
  });
});
