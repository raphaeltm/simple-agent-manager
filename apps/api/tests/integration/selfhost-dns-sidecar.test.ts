/**
 * DNS on the box, end to end with the real sam-dns binary (deploy/selfhost/sam-dns, built with
 * `go build`):
 *
 *   upsertAppRouteDNSRecord (the writer deploy-release-callback.ts fans out per route)
 *     -> selfhost_dns_records in D1 (real SQLite, shipped migration)
 *     -> GET /api/self-host/gateway/dns-records (the real gateway router, behind a loopback bridge
 *        standing in for celld)
 *     -> sam-dns syncs it (pages of 5, so more records than one page: rule 81)
 *     -> a real DNS client (node:dns Resolver) gets the node's address.
 *
 * Then a moved route, a removed route, recursion and a zone transfer, through the same path.
 *
 * The Go toolchain is optional locally: without SAM_DNS_SIDECAR_TESTS=1 the block is skipped. The
 * Self-host DNS CI job sets it, and then a missing toolchain fails instead of skipping. Locally:
 * SAM_DNS_SIDECAR_TESTS=1 pnpm vitest run tests/integration/selfhost-dns-sidecar.test.ts
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { Resolver } from 'node:dns/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { installBoxDns } from '../../src/selfhost/dns';
import { createSelfHostGatewayRoutes } from '../../src/selfhost/reverse-tunnel/gateway';
import { cleanupAppRouteDNSRecords, upsertAppRouteDNSRecord } from '../../src/services/dns';
import { resetBoxDnsBackendForTests } from '../../src/services/dns-provider';
import { createSqliteD1 } from '../helpers/sqlite-d1';

const ZONE = 'box.example.test';
const BOX_IP = '203.0.113.5';
const SECRET = 'g'.repeat(64);
const TSIG = Buffer.alloc(32, 9).toString('base64');
const PAGE = 5;
const ROUTES = PAGE * 2 + 3;
const enabled = process.env.SAM_DNS_SIDECAR_TESTS === '1';

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function eventually<T>(fn: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

describe.skipIf(!enabled)('sam-dns serves the records the Worker writes', () => {
  let sqlite: Database.Database;
  let env: Env;
  let bridge: http.Server;
  let sidecar: ChildProcess;
  let resolver: Resolver;
  let dnsPort: number;
  const hostnames = Array.from({ length: ROUTES }, (_, i) => `r${i}-web-80-01envabc.apps.${ZONE}`);

  beforeAll(async () => {
    const binary = join(mkdtempSync(join(tmpdir(), 'sam-dns-')), 'sam-dns');
    execFileSync('go', ['build', '-o', binary, '.'], {
      cwd: new URL('../../../../deploy/selfhost/sam-dns/', import.meta.url).pathname,
      stdio: 'inherit',
    });

    sqlite = new Database(':memory:');
    sqlite.exec(
      readFileSync(
        new URL('../../src/selfhost/migrations/0267_selfhost_dns_records.sql', import.meta.url),
        'utf8'
      )
    );
    env = {
      DATABASE: createSqliteD1(sqlite),
      BASE_DOMAIN: ZONE,
      SAM_DNS_PROVIDER: 'box',
      REVERSE_TUNNEL_GATEWAY_SECRET: SECRET,
    } as unknown as Env;
    resetBoxDnsBackendForTests();
    installBoxDns();

    // celld stand-in: the real gateway router on a loopback port.
    const gateway = createSelfHostGatewayRoutes(() => new Response(null, { status: 404 }));
    bridge = http.createServer((req, res) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value);
      }
      void Promise.resolve(gateway.request(req.url ?? '/', { headers }, env)).then(
        async (response) => {
          res.writeHead(response.status, { 'Content-Type': 'application/json' });
          res.end(Buffer.from(await response.arrayBuffer()));
        }
      );
    });
    await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    const bridgePort = (bridge.address() as net.AddressInfo).port;

    // The records exist before sam-dns starts, so its first sync reads every page.
    for (const hostname of hostnames) await upsertAppRouteDNSRecord(hostname, '198.51.100.7', env);

    dnsPort = await freePort();
    const updatePort = await freePort();
    sidecar = spawn(binary, [], {
      env: {
        PATH: process.env.PATH ?? '',
        SAM_DOMAIN: ZONE,
        SAM_DNS_PUBLIC_IPV4: BOX_IP,
        SAM_DNS_LISTEN: `127.0.0.1:${dnsPort}`,
        SAM_DNS_UPDATE_LISTEN: `127.0.0.1:${updatePort}`,
        SAM_DNS_TSIG_SECRET: TSIG,
        REVERSE_TUNNEL_GATEWAY_SECRET: SECRET,
        CELLD_PORT: String(bridgePort),
        SAM_DNS_SYNC_PAGE_SIZE: String(PAGE),
        SAM_DNS_SYNC_INTERVAL: '200ms',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    resolver = new Resolver({ timeout: 1000, tries: 1 });
    resolver.setServers([`127.0.0.1:${dnsPort}`]);
  }, 180_000);

  afterAll(async () => {
    if (!enabled) return;
    sidecar?.kill('SIGTERM');
    await new Promise<void>((resolve) => bridge?.close(() => resolve()));
    resetBoxDnsBackendForTests();
    sqlite?.close();
  });

  it('answers for every route written before it started (more than one sync page)', async () => {
    for (const hostname of hostnames) {
      expect(await eventually(() => resolver.resolve4(hostname)), hostname).toEqual([
        '198.51.100.7',
      ]);
    }
    // The static records: the box itself through the wildcard and the ns1 glue.
    expect(await resolver.resolve4(`api.${ZONE}`)).toEqual([BOX_IP]);
    expect(await resolver.resolveNs(ZONE)).toEqual([`ns1.${ZONE}`]);
  });

  it('follows a route that moves to another node and one that is removed', async () => {
    await upsertAppRouteDNSRecord(hostnames[0]!, '198.51.100.99', env);
    await cleanupAppRouteDNSRecords([hostnames[1]!], env);
    await eventually(async () => {
      expect(await resolver.resolve4(hostnames[0]!)).toEqual(['198.51.100.99']);
    });
    // Removed: NXDOMAIN (apps.<zone> exists, so the box wildcard must not answer for it).
    await eventually(async () => {
      await expect(resolver.resolve4(hostnames[1]!)).rejects.toMatchObject({ code: 'ENOTFOUND' });
    });
  });

  it('refuses recursion for any other name', async () => {
    await expect(resolver.resolve4('example.com')).rejects.toMatchObject({ code: 'EREFUSED' });
  });
});
