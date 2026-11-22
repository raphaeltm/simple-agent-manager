/**
 * The dangling app-route DNS sweep on a self-host box whose deployment nodes run on the reverse
 * tunnel: their route records point at the box (`reverseTunnelAppRouteAddress`), not at the
 * node, so the sweep must judge them against the same address the release fetch writes
 * (`appRouteRecordAddress`). Real box zone (shipped migration), real transport install.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { installBoxDns } from '../../../src/selfhost/dns';
import { installReverseTunnelTransport } from '../../../src/selfhost/reverse-tunnel/transport';
import {
  releaseNodeAppRouteDnsRecords,
  runAppRouteDnsReconciliation,
} from '../../../src/services/app-route-dns-reconciliation';
import { resetBoxDnsBackendForTests } from '../../../src/services/dns-provider';
import {
  applySqliteMigration,
  createAllSchemaTables,
  createMemoryKv,
  createSqliteD1,
} from '../../helpers/sqlite-d1';

vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSetting: vi.fn(async () => undefined),
}));

const BASE = 'box.example.test';
const BOX_IP = '192.0.2.10';
const NODE_IP = '10.8.0.5';
const ENV_LIVE = '01KVJDV913S8W7KK32HTZTK0H8';
const ENV_STOPPED = '01KVJDV913S8W7KK32HTZTK0H9';
const host = (envId: string, i = 1) => `r${i}-web-80-${envId.toLowerCase()}.apps.${BASE}`;

let sqlite: Database.Database;
let env: Env;

function rows(): Array<{ id: string; content: string }> {
  return sqlite.prepare('SELECT id, content FROM selfhost_dns_records ORDER BY id').all() as Array<{
    id: string;
    content: string;
  }>;
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  applySqliteMigration(
    sqlite,
    new URL('../../../src/selfhost/migrations/0267_selfhost_dns_records.sql', import.meta.url)
  );
  resetBoxDnsBackendForTests();
  installBoxDns();
  installReverseTunnelTransport(() => '');
  env = {
    DATABASE: createSqliteD1(sqlite),
    KV: createMemoryKv(),
    BASE_DOMAIN: BASE,
    SAM_DNS_PROVIDER: 'box',
    SAM_DNS_PUBLIC_IPV4: BOX_IP,
  } as unknown as Env;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('no external request may be made on a box with its own DNS');
    })
  );
  await drizzle(env.DATABASE)
    .insert(schema.nodes)
    .values({
      id: 'tunnel-node',
      userId: 'user',
      name: 'tunnel-node',
      status: 'running',
      runtime: 'vm',
      nodeClass: 'managed',
      nodeRole: 'deployment',
      transport: 'reverse-tunnel',
      ipAddress: NODE_IP,
    } as schema.NewNode);
  for (const [id, nodeId, status] of [
    [ENV_LIVE, 'tunnel-node', 'active'],
    [ENV_STOPPED, null, 'stopped'],
  ] as const) {
    await drizzle(env.DATABASE)
      .insert(schema.deploymentEnvironments)
      .values({
        id,
        projectId: 'project',
        name: id,
        nodeId,
        status,
      } as schema.NewDeploymentEnvironmentRow);
  }
  const insert = sqlite.prepare(
    "INSERT INTO selfhost_dns_records (id, name, type, content, created_at, updated_at) VALUES (?, ?, 'A', ?, 'now', 'now')"
  );
  insert.run('live-at-box', host(ENV_LIVE), BOX_IP);
  insert.run('live-at-node', host(ENV_LIVE, 2), NODE_IP);
  insert.run('stopped', host(ENV_STOPPED), BOX_IP);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetBoxDnsBackendForTests();
  sqlite.close();
});

describe('dangling app-route sweep on reverse-tunnel deployment nodes', () => {
  it('keeps records that point at the box, moves stray ones there, deletes a stopped env', async () => {
    const result = await runAppRouteDnsReconciliation(env);

    expect(rows()).toEqual([
      { id: 'live-at-box', content: BOX_IP },
      { id: 'live-at-node', content: BOX_IP },
    ]);
    expect(result).toMatchObject({ kept: 1, repointed: 1, deleted: 1, failed: 0 });
  });

  it('skips release cleanup for wildcard-covered tunnel routes even with a Cloudflare zone', async () => {
    resetBoxDnsBackendForTests();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // Box DNS off: the reverse tunnel's routes are covered by the operator's wildcard.
    const wildcard = {
      ...env,
      SAM_DNS_PROVIDER: undefined,
      CF_ZONE_ID: 'zone',
      CF_API_TOKEN: 'token',
    } as unknown as Env;
    expect(
      await releaseNodeAppRouteDnsRecords(wildcard, {
        id: 'tunnel-node',
        nodeRole: 'deployment',
        ipAddress: NODE_IP,
        transport: 'reverse-tunnel',
      })
    ).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
