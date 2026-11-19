/**
 * waitForHealth (deploy-steps.ts) against a real HTTP server on loopback. On sam-box a health
 * request that celld dispatched to a stuck fresh isolate hung for celld's whole handler budget,
 * outlived the deploy's deadline and failed a deploy whose Worker answered every other request.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { waitForHealth } from './deploy-steps';

let server: Server;
let port: string;
let requests: number;
let hangFirst: number;
let held: ServerResponse[];
const saved = { ...process.env };

beforeEach(async () => {
  requests = 0;
  held = [];
  server = createServer((_req, res) => {
    requests += 1;
    if (requests <= hangFirst) {
      held.push(res); // never answered: a request stuck in a fresh isolate
      return;
    }
    res.writeHead(200).end('ok');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  port = String((server.address() as AddressInfo).port);
  process.env.SELFHOST_HEALTH_TIMEOUT_MS = '5000';
  process.env.SELFHOST_HEALTH_REQUEST_TIMEOUT_MS = '200';
  process.env.SELFHOST_HEALTH_POLL_INTERVAL_MS = '20';
});

afterEach(async () => {
  for (const res of held) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  process.env = { ...saved };
});

describe('waitForHealth', () => {
  it('abandons a request that never answers and succeeds on the next one', async () => {
    hangFirst = 1;
    const started = Date.now();
    await waitForHealth(port, 'box.example');
    expect(requests).toBe(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('still fails when every request hangs, within the overall deadline', async () => {
    hangFirst = Number.MAX_SAFE_INTEGER;
    process.env.SELFHOST_HEALTH_TIMEOUT_MS = '700';
    const started = Date.now();
    await expect(waitForHealth(port, 'box.example')).rejects.toThrow(/did not become healthy/);
    expect(requests).toBeGreaterThanOrEqual(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('returns at once when the first request answers 200 (control)', async () => {
    hangFirst = 0;
    await waitForHealth(port, 'box.example');
    expect(requests).toBe(1);
  });
});
