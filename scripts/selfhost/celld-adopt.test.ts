/**
 * `pnpm selfhost:deploy`'s adoption step and agent sign-in route check (celld-adopt.ts), against a
 * small fake celld on loopback that behaves like celld 0.6.3: the API serves the ADOPTED version
 * until `POST /reload` (or the 30 s poll, not modelled) switches it to the version the pointer
 * names; a version that does not build is refused with 422 and the old one keeps serving.
 *
 * Box round R15 (G3): the deploy checked only /health, which the previous version also answers,
 * so the agent sign-in route the new version added answered 404 for ~20 s after "deployed".
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  adoptAndCheck,
  adoptNewDeployment,
  AGENT_SIGN_IN_PATH,
  checkAgentSignInRoute,
} from './celld-adopt';
import { waitForHealth } from './deploy-steps';

interface Version {
  id: string;
  builds: boolean;
  /** The Worker has a usable AGENT_SIGN_IN_TRUST, so the route answers instead of 404. */
  agentSignIn: boolean;
}

let internal: Server;
let api: Server;
let box: Record<string, string>;
let serving: Version;
let pointer: Version;
let reloads: number;
let refuseReloads: number;
const saved = { ...process.env };

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return String((server.address() as AddressInfo).port);
}

/** What `celld deploy` does: write a new pointer. The node keeps serving the old version. */
function celldDeploy(version: Version): void {
  pointer = version;
}

beforeEach(async () => {
  reloads = 0;
  refuseReloads = 0;
  serving = { id: 'v1', builds: true, agentSignIn: false };
  pointer = serving;
  internal = createServer((req, res) => {
    reloads += 1;
    if (reloads <= refuseReloads) {
      req.socket.destroy();
      return;
    }
    if (!pointer.builds) {
      res
        .writeHead(422, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({ ok: false, outcome: 'failed', version: pointer.id, error: 'syntax' })
        );
      return;
    }
    serving = pointer;
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: true, outcome: 'adopted', generation: 2, version: serving.id }));
  });
  api = createServer((req, res) => {
    if (req.url === '/health') return void res.writeHead(200).end('{"status":"healthy"}');
    if (req.url === AGENT_SIGN_IN_PATH && req.method === 'POST') {
      // The route steps aside (404) when the serving Worker has no usable trust.
      return void res.writeHead(serving.agentSignIn ? 400 : 404).end('{}');
    }
    res.writeHead(404).end();
  });
  box = {
    SAM_DOMAIN: 'sam.example.com',
    CELLD_INTERNAL_PORT: await listen(internal),
    CELLD_PORT: await listen(api),
  };
  process.env.SELFHOST_ADOPT_CHECK_WINDOW_MS = '2000';
  process.env.SELFHOST_HEALTH_POLL_INTERVAL_MS = '20';
  process.env.SELFHOST_HEALTH_TIMEOUT_MS = '2000';
});

afterEach(async () => {
  process.env = { ...saved };
  for (const server of [internal, api]) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

describe('deploy adoption (G3)', () => {
  it('reproduces R15: health passes on the previous version, the new route still 404s', async () => {
    celldDeploy({ id: 'v2', builds: true, agentSignIn: true });
    await waitForHealth(box.CELLD_PORT!, box.SAM_DOMAIN!);
    process.env.SELFHOST_ADOPT_CHECK_WINDOW_MS = '200';
    await expect(checkAgentSignInRoute(box)).rejects.toThrow(/answers HTTP 404/);
    expect(serving.id).toBe('v1');
  });

  it('adopts the new version before the checks, so the new route answers at once', async () => {
    celldDeploy({ id: 'v2', builds: true, agentSignIn: true });
    expect(await adoptNewDeployment(box)).toBe('adopted version v2');
    await waitForHealth(box.CELLD_PORT!, box.SAM_DOMAIN!);
    await checkAgentSignInRoute(box);
    expect(serving.id).toBe('v2');
    expect(reloads).toBe(1);
  });

  it('rides out a refused reload while celld stalls', async () => {
    refuseReloads = 2;
    celldDeploy({ id: 'v2', builds: true, agentSignIn: false });
    expect(await adoptNewDeployment(box)).toBe('adopted version v2');
    expect(reloads).toBe(3);
  });

  it('fails at once, without retrying, when the new version does not build', async () => {
    celldDeploy({ id: 'v2', builds: false, agentSignIn: true });
    await expect(adoptNewDeployment(box)).rejects.toThrow(
      /HTTP 422 version v2: syntax\)\. The previous version keeps serving/
    );
    expect(reloads).toBe(1);
    expect(serving.id).toBe('v1');
  });

  it('adoptAndCheck (rotate, migrate, switch) also stops at once on a version that does not build', async () => {
    celldDeploy({ id: 'v2', builds: false, agentSignIn: false });
    const result = await adoptAndCheck(box);
    expect(result.healthy).toBe(false);
    expect(result.detail).toMatch(
      /HTTP 422 version v2: syntax\)\. The previous version keeps serving$/
    );
    expect(reloads).toBe(1);
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

describe('agent sign-in route check', () => {
  it('names the likely cause when the serving Worker has no usable trust', async () => {
    process.env.SELFHOST_ADOPT_CHECK_WINDOW_MS = '200';
    await expect(checkAgentSignInRoute(box)).rejects.toThrow(/agent_sign_in\.config_invalid/);
  });

  it('control: passes when the route refuses an empty body with 400', async () => {
    serving = { id: 'v1', builds: true, agentSignIn: true };
    await checkAgentSignInRoute(box);
  });
});
