/**
 * The check after every secrets deploy (rotate, migrate, switch): celld's internal reload, then
 * the API health. Box round R11: the rotation's final reseal failed on one refused fetch while
 * celld stalled for about 6.5 s adopting the version ("celld did not adopt the deployment
 * (TypeError: fetch failed)"), and `rotate --resume` then finished. Real HTTP servers on loopback.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adoptAndCheck } from './celld-adopt';

let internal: Server;
let api: Server;
let reloads: number;
let healthChecks: number;
let refuseReloads: number;
let healthStatus: number;
const saved = { ...process.env };

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return String((server.address() as AddressInfo).port);
}

let box: Record<string, string>;

beforeEach(async () => {
  reloads = 0;
  healthChecks = 0;
  refuseReloads = 0;
  healthStatus = 200;
  internal = createServer((req, res) => {
    reloads += 1;
    // A celld stall: the connection is dropped, which fetch reports as "TypeError: fetch failed".
    if (reloads <= refuseReloads) {
      req.socket.destroy();
      return;
    }
    res.writeHead(200).end('ok');
  });
  api = createServer((_req, res) => {
    healthChecks += 1;
    res.writeHead(healthStatus).end(healthStatus === 200 ? 'ok' : '{"code":"STARTING"}');
  });
  box = {
    SAM_DOMAIN: 'sam.example.com',
    CELLD_INTERNAL_PORT: await listen(internal),
    CELLD_PORT: await listen(api),
  };
  process.env.SELFHOST_ADOPT_CHECK_WINDOW_MS = '3000';
  process.env.SELFHOST_HEALTH_POLL_INTERVAL_MS = '20';
});

afterEach(async () => {
  process.env = { ...saved };
  for (const server of [internal, api]) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

describe('adoptAndCheck', () => {
  it('rides out a refused reload during a short celld stall (box round R11)', async () => {
    refuseReloads = 2;
    const result = await adoptAndCheck(box);
    expect(result).toEqual({ healthy: true, detail: 'HTTP 200' });
    expect(reloads).toBe(3);
    expect(healthChecks).toBe(1);
  });

  it('rides out a health check that answers 503 while the version starts', async () => {
    healthStatus = 503;
    setTimeout(() => {
      healthStatus = 200;
    }, 200);
    const result = await adoptAndCheck(box);
    expect(result.healthy).toBe(true);
    expect(healthChecks).toBeGreaterThan(1);
  });

  it('control: a version that stays unhealthy fails after the window, with the last answer', async () => {
    healthStatus = 500;
    process.env.SELFHOST_ADOPT_CHECK_WINDOW_MS = '300';
    const started = Date.now();
    const result = await adoptAndCheck(box);
    expect(result).toEqual({ healthy: false, detail: 'HTTP 500 STARTING' });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(healthChecks).toBeGreaterThan(1);
  });

  it('control: celld that never adopts fails with the adoption error', async () => {
    refuseReloads = Number.POSITIVE_INFINITY;
    process.env.SELFHOST_ADOPT_CHECK_WINDOW_MS = '300';
    const result = await adoptAndCheck(box);
    expect(result.healthy).toBe(false);
    expect(result.detail).toMatch(/^celld did not adopt the deployment \(.*fetch failed/);
    expect(healthChecks).toBe(0);
  });
});
