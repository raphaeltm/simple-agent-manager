/**
 * DNS provider seam (services/dns-provider.ts): which provider an installation's records go to.
 *
 * Divergence (.claude/rules/74): a Cloudflare Worker whose env carries the box's
 * SAM_DNS_PROVIDER="box" still resolves to Cloudflare, because only the self-host build installs
 * the box backend, and every DNS call makes exactly the same Cloudflare requests as without it.
 * Convergence: the self-host build's real install (`withSelfHostBuild` -> `installBoxDns`) plus the
 * var resolves to the box and writes to D1 with no Cloudflare request. Control: installed but the
 * var unset stays on Cloudflare, so an existing box changes nothing until its operator switches.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { withSelfHostBuild } from '../../../src/selfhost/build';
import {
  cleanupAppRouteDNSRecords,
  cleanupWorkspaceDNSRecords,
  createDNSRecord,
  createNodeBackendDNSRecord,
  deleteDNSRecord,
  updateDNSRecord,
  upsertAppRouteDNSRecord,
} from '../../../src/services/dns';
import { resetBoxDnsBackendForTests, resolveDnsProvider } from '../../../src/services/dns-provider';
import { applySqliteMigration, createSqliteD1 } from '../../helpers/sqlite-d1';

const MIGRATION = new URL(
  '../../../src/selfhost/migrations/0267_selfhost_dns_records.sql',
  import.meta.url
);

type Call = { method: string; url: string; body: unknown; auth: string | null };

let calls: Call[];
let sqlite: Database.Database;

/** A Cloudflare DNS API that records each request; every lookup is empty, every write succeeds. */
function stubCloudflare() {
  calls = [];
  let next = 1;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        method: init?.method ?? 'GET',
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
        auth: headers.get('Authorization'),
      });
      const method = init?.method ?? 'GET';
      if (method === 'GET') return Response.json({ result: [] });
      return Response.json({ result: { id: `cf-${next++}` } });
    })
  );
}

function cloudflareEnv(extra: Record<string, string> = {}): Env {
  return {
    CF_API_TOKEN: 'cf-token',
    CF_ZONE_ID: 'zone-1',
    DNS_TTL_SECONDS: '120',
    BASE_DOMAIN: 'example.com',
    DATABASE: createSqliteD1(sqlite),
    ...extra,
  } as unknown as Env;
}

/** Every exported DNS primitive once, as production calls them. */
async function exerciseEveryPrimitive(env: Env): Promise<void> {
  await upsertAppRouteDNSRecord('r1-web-3000-env1.apps.example.com', '203.0.113.10', env);
  await createDNSRecord('ws1', '203.0.113.11', env);
  await createNodeBackendDNSRecord('NODE1', '203.0.113.12', env);
  await updateDNSRecord('cf-1', '203.0.113.13', env);
  await deleteDNSRecord('cf-2', env);
  await cleanupAppRouteDNSRecords(['r1-web-3000-env1.apps.example.com'], env);
  await cleanupWorkspaceDNSRecords('ws1', env);
}

function installSelfHostBuild(): void {
  // The real self-host entry: the same call the generated celld main makes.
  const app = new Hono<{ Bindings: Env }>();
  app.get('/health', (c) => c.text('ok')); // the shared app always has routes before the wrap
  withSelfHostBuild({ fetch: app.fetch, scheduled: async () => undefined }, app);
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  applySqliteMigration(sqlite, MIGRATION);
  resetBoxDnsBackendForTests();
  stubCloudflare();
});

afterEach(() => {
  resetBoxDnsBackendForTests();
  vi.unstubAllGlobals();
  sqlite.close();
});

function boxRows(): Array<{ name: string; content: string }> {
  return sqlite
    .prepare('SELECT name, content FROM selfhost_dns_records ORDER BY name')
    .all() as Array<{ name: string; content: string }>;
}

describe('DNS provider resolution on Cloudflare (nothing installed)', () => {
  it('resolves Cloudflare-shaped envs to Cloudflare, with or without the box setting', () => {
    expect(resolveDnsProvider(cloudflareEnv())).toBe('cloudflare');
    expect(resolveDnsProvider(cloudflareEnv({ SAM_DNS_PROVIDER: 'box' }))).toBe('cloudflare');
  });

  it('makes byte-identical Cloudflare requests when the env carries SAM_DNS_PROVIDER=box', async () => {
    await exerciseEveryPrimitive(cloudflareEnv());
    const baseline = calls;
    expect(baseline.length).toBeGreaterThanOrEqual(10);
    expect(baseline.every((call) => call.url.startsWith('https://api.cloudflare.com/'))).toBe(true);
    expect(baseline.every((call) => call.auth === 'Bearer cf-token')).toBe(true);

    stubCloudflare();
    await exerciseEveryPrimitive(cloudflareEnv({ SAM_DNS_PROVIDER: 'box' }));
    expect(calls).toEqual(baseline);
    expect(boxRows()).toEqual([]);
  });

  it('keeps the Cloudflare app-route record shape (grey cloud, configured TTL)', async () => {
    await upsertAppRouteDNSRecord(
      'r1-web-3000-env1.apps.example.com',
      '203.0.113.10',
      cloudflareEnv({ SAM_DNS_PROVIDER: 'box' })
    );
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(calls[1]).toMatchObject({
      url: 'https://api.cloudflare.com/client/v4/zones/zone-1/dns_records',
      body: {
        type: 'A',
        name: 'r1-web-3000-env1.apps.example.com',
        content: '203.0.113.10',
        ttl: 120,
        proxied: false,
      },
    });
  });
});

describe('DNS provider resolution in the self-host build', () => {
  it('stays on Cloudflare when the box setting is absent (an existing box is unchanged)', async () => {
    installSelfHostBuild();
    const env = cloudflareEnv();
    expect(resolveDnsProvider(env)).toBe('cloudflare');
    await upsertAppRouteDNSRecord('r1-web-3000-env1.apps.example.com', '203.0.113.10', env);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(boxRows()).toEqual([]);
  });

  it('writes to the box zone in D1 with no Cloudflare request when SAM_DNS_PROVIDER=box', async () => {
    installSelfHostBuild();
    const env = cloudflareEnv({ SAM_DNS_PROVIDER: 'box' });
    expect(resolveDnsProvider(env)).toBe('box');

    const routeId = await upsertAppRouteDNSRecord(
      'r1-web-3000-env1.apps.example.com',
      '203.0.113.10',
      env
    );
    const wsId = await createDNSRecord('ws1', '203.0.113.11', env);
    const nodeId = await createNodeBackendDNSRecord('NODE1', '203.0.113.12', env);
    expect(boxRows()).toEqual([
      { name: 'node1.vm.example.com', content: '203.0.113.12' },
      { name: 'r1-web-3000-env1.apps.example.com', content: '203.0.113.10' },
      { name: 'ws-ws1.example.com', content: '203.0.113.11' },
    ]);

    // A durable replay adopts the matching record and refuses a different one (rule 75 §7).
    await expect(
      createNodeBackendDNSRecord('NODE1', '203.0.113.12', env, undefined, true)
    ).resolves.toBe(nodeId);
    await expect(
      createNodeBackendDNSRecord('NODE1', '203.0.113.99', env, undefined, true)
    ).rejects.toThrow(/differs from the recovered allocation/);

    await updateDNSRecord(wsId, '198.51.100.1', env);
    await deleteDNSRecord(nodeId, env);
    expect(await cleanupAppRouteDNSRecords(['r1-web-3000-env1.apps.example.com'], env)).toBe(1);
    expect(await cleanupWorkspaceDNSRecords('ws1', env)).toBe(1);
    expect(routeId).toMatch(/^box_/);
    expect(boxRows()).toEqual([]);
    expect(calls).toEqual([]);
  });
});
