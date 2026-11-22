/**
 * Dangling app-route DNS cleanup (`services/app-route-dns-reconciliation.ts`) on a real SQL engine
 * against a Cloudflare DNS fake that enforces the list/delete contract, and against the self-host
 * box zone (real SQLite, shipped migration) through the same provider seam.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { installBoxDns } from '../../../src/selfhost/dns';
import {
  APP_ROUTE_DNS_SWEEP_CURSOR_KEY,
  judgeAppRouteRecord,
  releaseNodeAppRouteDnsRecords,
  runAppRouteDnsReconciliation,
} from '../../../src/services/app-route-dns-reconciliation';
import { parseAppRouteHostname } from '../../../src/services/dns-app-route-inventory';
import { resetBoxDnsBackendForTests } from '../../../src/services/dns-provider';
import { createFakeCloudflareDns, type FakeDnsRecord } from '../../helpers/fake-cloudflare-dns';
import {
  applySqliteMigration,
  createAllSchemaTables,
  createMemoryKv,
  createSqliteD1,
} from '../../helpers/sqlite-d1';

const settings = vi.hoisted(() => ({ values: new Map<string, number>() }));
vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSetting: vi.fn(async (_env: unknown, name: string) => settings.values.get(name)),
}));

const ZONE = 'zone-1';
const TOKEN = 'cf-token';
const BASE = 'example.com';
const LIVE_IP = '10.0.0.1';
const RELEASED_IP = '10.0.0.3';

// ULIDs as `buildRouteHostname` writes them (lower-cased in the hostname).
const ENV_LIVE = '01KVJDV913S8W7KK32HTZTK0H8';
const ENV_STOPPED = '01KVJDV913S8W7KK32HTZTK0H9';
const ENV_MISSING = '01KVJDV913S8W7KK32HTZTK0HA';
const ENV_RELEASED = '01KVJDV913S8W7KK32HTZTK0HB';
const ENV_MISMATCH = '01KVJDV913S8W7KK32HTZTK0HC';
const ENV_UNLINKED_ON_RELEASED = '01KVJDV913S8W7KK32HTZTK0HD';

const host = (envId: string, index = 1, service = 'web', port = 80) =>
  `r${index}-${service}-${port}-${envId.toLowerCase()}.apps.${BASE}`;

let sqlite: Database.Database;
let env: Env;

async function seedNode(
  id: string,
  status: string,
  ipAddress: string | null,
  nodeRole = 'deployment'
) {
  await drizzle(env.DATABASE)
    .insert(schema.nodes)
    .values({
      id,
      userId: 'user',
      name: id,
      status,
      runtime: 'vm',
      nodeClass: 'managed',
      nodeRole,
      ipAddress,
    } as schema.NewNode);
}

async function seedEnvironment(id: string, nodeId: string | null, status = 'active') {
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

function rec(id: string, name: string, content: string, type = 'A'): FakeDnsRecord {
  return { id, name, type, content };
}

/** Names outside SAM's app-route namespace, or near-misses of it. None may ever be deleted. */
const FOREIGN_RECORDS: FakeDnsRecord[] = [
  rec('foreign-api', `api.${BASE}`, RELEASED_IP),
  rec('foreign-ws', `ws-abc.${BASE}`, RELEASED_IP),
  rec('foreign-vm', `abc.vm.${BASE}`, RELEASED_IP),
  rec('foreign-bare-apps', `foo.apps.${BASE}`, RELEASED_IP),
  rec('foreign-prefix', `x-${host(ENV_MISSING)}`, RELEASED_IP),
  rec('foreign-nested', `r1-web-80-${ENV_MISSING.toLowerCase()}.sub.apps.${BASE}`, RELEASED_IP),
  rec('foreign-short-env', `r1-web-80-01kvjdv913.apps.${BASE}`, RELEASED_IP),
  rec('foreign-txt', host(ENV_MISSING, 9), 'v=spf1 -all', 'TXT'),
];

async function seedWorld() {
  await seedNode('live-node', 'running', LIVE_IP);
  await seedNode('released-node', 'deleted', null);
  await seedEnvironment(ENV_LIVE, 'live-node');
  await seedEnvironment(ENV_STOPPED, null, 'stopped');
  await seedEnvironment(ENV_RELEASED, 'released-node', 'stopping');
  await seedEnvironment(ENV_MISMATCH, 'live-node');
  return [
    rec('live', host(ENV_LIVE), LIVE_IP),
    rec('live-2', host(ENV_LIVE, 2, 'api', 8080), LIVE_IP),
    rec('dangling-stopped', host(ENV_STOPPED), RELEASED_IP),
    rec('dangling-missing', host(ENV_MISSING), RELEASED_IP),
    rec('dangling-released', host(ENV_RELEASED), RELEASED_IP),
    rec('dangling-mismatch', host(ENV_MISMATCH), '10.0.0.9'),
    ...FOREIGN_RECORDS,
  ];
}

/** Dangling with no live node behind them: deleted. */
const DELETED_IDS = ['dangling-stopped', 'dangling-missing', 'dangling-released'];
/** Its environment runs on a live node at another address: repointed there, not deleted. */
const REPOINTED_ID = 'dangling-mismatch';
const isRepointed = (zone: ReturnType<typeof createFakeCloudflareDns>) =>
  zone.records.get(REPOINTED_ID)?.content === LIVE_IP;
const KEPT_IDS = ['live', 'live-2', ...FOREIGN_RECORDS.map((r) => r.id)];

beforeEach(() => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  env = {
    DATABASE: createSqliteD1(sqlite),
    KV: createMemoryKv(),
    BASE_DOMAIN: BASE,
    CF_ZONE_ID: ZONE,
    CF_API_TOKEN: TOKEN,
  } as unknown as Env;
  settings.values.clear();
  resetBoxDnsBackendForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetBoxDnsBackendForTests();
  sqlite.close();
});

describe('parseAppRouteHostname', () => {
  it('accepts exactly buildRouteHostname output for this BASE_DOMAIN', () => {
    expect(parseAppRouteHostname(host(ENV_LIVE), BASE)).toEqual({ environmentId: ENV_LIVE });
    // A service cut at 24 characters can end in a hyphen.
    expect(
      parseAppRouteHostname(
        `r12-${'my-service-name-is-long'}--3000-${ENV_LIVE.toLowerCase()}.apps.${BASE}`,
        BASE
      )
    ).toEqual({
      environmentId: ENV_LIVE,
    });
    for (const record of FOREIGN_RECORDS.filter((r) => r.type === 'A')) {
      expect(parseAppRouteHostname(record.name, BASE), record.name).toBeNull();
    }
    expect(parseAppRouteHostname(host(ENV_LIVE), 'other.com')).toBeNull();
    expect(parseAppRouteHostname(host(ENV_LIVE), '')).toBeNull();
    expect(
      parseAppRouteHostname(`r0-web-80-${ENV_LIVE.toLowerCase()}.apps.${BASE}`, BASE)
    ).toBeNull();
    expect(
      parseAppRouteHostname(`r1-web-x80-${ENV_LIVE.toLowerCase()}.apps.${BASE}`, BASE)
    ).toBeNull();
  });
});

describe('judgeAppRouteRecord', () => {
  it('keeps a record it cannot judge and names the reason for each dangling shape', () => {
    const record = { content: LIVE_IP };
    expect(judgeAppRouteRecord(record, 'unknown')).toBeNull();
    expect(judgeAppRouteRecord(record, undefined)).toEqual({
      live: false,
      reason: 'environment_missing',
    });
    expect(
      judgeAppRouteRecord(record, {
        nodeId: 'n',
        nodeStatus: 'running',
        ipAddress: LIVE_IP,
        terminationConfirmedAt: null,
        recordAddress: { covered: false, address: LIVE_IP },
      })
    ).toEqual({ live: true });
    // A stopped node keeps its provider IP; its routes are not dangling.
    expect(
      judgeAppRouteRecord(record, {
        nodeId: 'n',
        nodeStatus: 'stopped',
        ipAddress: LIVE_IP,
        terminationConfirmedAt: null,
        recordAddress: { covered: false, address: LIVE_IP },
      })
    ).toEqual({ live: true });
    // A teardown that failed after the VM was deleted can leave the node in `error`: the proof,
    // not the status, says the IP is released.
    expect(
      judgeAppRouteRecord(record, {
        nodeId: 'n',
        nodeStatus: 'error',
        ipAddress: LIVE_IP,
        terminationConfirmedAt: '2026-11-22T00:00:00.000Z',
        recordAddress: { covered: false, address: LIVE_IP },
      })
    ).toEqual({ live: false, reason: 'node_released' });
    expect(
      judgeAppRouteRecord(record, {
        nodeId: 'n',
        nodeStatus: 'error',
        ipAddress: LIVE_IP,
        terminationConfirmedAt: null,
        recordAddress: { covered: false, address: LIVE_IP },
      })
    ).toEqual({ live: true });
    for (const status of ['destroying', 'deleting', 'deleted', 'destroyed']) {
      expect(
        judgeAppRouteRecord(record, {
          nodeId: 'n',
          nodeStatus: status,
          ipAddress: LIVE_IP,
          terminationConfirmedAt: null,
          recordAddress: { covered: false, address: LIVE_IP },
        })
      ).toEqual({ live: false, reason: 'node_released' });
    }
  });
});

describe('records of nodes whose transport carries app ingress (self-host box tunnel)', () => {
  const BOX_IP = '192.0.2.10';
  const target = (
    recordAddress: { covered: true } | { covered: false; address: string | null }
  ) => ({
    nodeId: 'n',
    nodeStatus: 'running',
    ipAddress: '10.8.0.5',
    terminationConfirmedAt: null,
    recordAddress,
  });

  it('judges a record live when it points where the release fetch writes it (the box)', () => {
    expect(
      judgeAppRouteRecord({ content: BOX_IP }, target({ covered: false, address: BOX_IP }))
    ).toEqual({ live: true });
    // The node's own IP is not where this transport's records belong.
    expect(
      judgeAppRouteRecord({ content: '10.8.0.5' }, target({ covered: false, address: BOX_IP }))
    ).toEqual({ live: false, reason: 'ip_mismatch' });
  });

  it('treats an explicit record under wildcard coverage as left over from an earlier node', () => {
    // The release fetch writes no per-route record for covered names; one that exists overrides
    // the wildcard and may still point at a released public IP.
    expect(judgeAppRouteRecord({ content: RELEASED_IP }, target({ covered: true }))).toEqual({
      live: false,
      reason: 'wildcard_covered',
    });
  });
});

describe('runAppRouteDnsReconciliation against Cloudflare', () => {
  it('deletes each dangling app-route record and nothing else in the zone', async () => {
    const zone = createFakeCloudflareDns({ zoneId: ZONE, token: TOKEN, seed: await seedWorld() });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));

    const result = await runAppRouteDnsReconciliation(env);

    for (const id of DELETED_IDS) expect(zone.records.has(id), id).toBe(false);
    expect(isRepointed(zone)).toBe(true);
    for (const id of KEPT_IDS) expect(zone.records.has(id), id).toBe(true);
    expect(result).toMatchObject({
      deleted: 3,
      repointed: 1,
      kept: 2,
      failed: 0,
      cycleComplete: true,
      stoppedBy: 'end_of_zone',
    });
    // Every list asked only for A records under the app-route suffix.
    const lists = zone.requests.filter(
      (r) => r.method === 'GET' && r.url.includes('name.endswith')
    );
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      const params = new URL(list.url).searchParams;
      expect(params.get('type')).toBe('A');
      expect(params.get('name.endswith')).toBe(`.apps.${BASE}`);
    }
  });

  it('pages through more records than one page holds, re-reading pages that shifted', async () => {
    settings.values.set('appRouteDns.sweepPageSize', 2);
    const zone = createFakeCloudflareDns({ zoneId: ZONE, token: TOKEN, seed: await seedWorld() });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));

    const result = await runAppRouteDnsReconciliation(env);

    for (const id of DELETED_IDS) expect(zone.records.has(id), id).toBe(false);
    expect(isRepointed(zone)).toBe(true);
    for (const id of KEPT_IDS) expect(zone.records.has(id), id).toBe(true);
    expect(result.cycleComplete).toBe(true);
    expect(await env.KV.get(APP_ROUTE_DNS_SWEEP_CURSOR_KEY)).toBeNull();
  });

  it('stops at the delete limit and resumes from its stored cursor until the zone is clean', async () => {
    settings.values.set('appRouteDns.sweepPageSize', 2);
    settings.values.set('appRouteDns.sweepMaxDeletes', 1);
    const zone = createFakeCloudflareDns({ zoneId: ZONE, token: TOKEN, seed: await seedWorld() });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));

    const runs = [];
    for (
      let i = 0;
      i < 10 && (DELETED_IDS.some((id) => zone.records.has(id)) || !isRepointed(zone));
      i++
    ) {
      runs.push(await runAppRouteDnsReconciliation(env));
    }
    expect(runs.length).toBe(4);
    expect(runs.map((r) => r.deleted + r.repointed)).toEqual([1, 1, 1, 1]);
    expect(runs.slice(0, 3).every((r) => r.stoppedBy === 'delete_limit')).toBe(true);
    for (const id of KEPT_IDS) expect(zone.records.has(id), id).toBe(true);
  });

  it('stops at its deadline and keeps its place', async () => {
    settings.values.set('appRouteDns.sweepPageSize', 2);
    const zone = createFakeCloudflareDns({ zoneId: ZONE, token: TOKEN, seed: await seedWorld() });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));
    const realNow = Date.now();
    let lists = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow + (lists >= 1 ? 60_000 : 0));
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('name.endswith')) lists++;
      return zone.fetch(input, init);
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await runAppRouteDnsReconciliation(env);

    expect(lists).toBe(1);
    expect(result.stoppedBy).toBe('deadline');
    expect(result.cycleComplete).toBe(false);
  });

  it('leaves a record that a release fetch repointed after it was judged dangling', async () => {
    const seed = await seedWorld();
    const zone = createFakeCloudflareDns({
      zoneId: ZONE,
      token: TOKEN,
      seed,
      beforeRequest: (method, url) => {
        // The re-read before delete: a concurrent upsertAppRouteDNSRecord has just repointed it.
        if (method === 'GET' && url.pathname.endsWith('/dangling-stopped')) {
          const record = zone.records.get('dangling-stopped');
          if (record) record.content = '10.0.0.77';
        }
      },
    });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));

    const result = await runAppRouteDnsReconciliation(env);

    expect(zone.records.get('dangling-stopped')?.content).toBe('10.0.0.77');
    expect(result.changed).toBe(1);
    expect(result.deleted).toBe(2);
    expect(result.repointed).toBe(1);
  });

  it('reports a failed delete as a sweep failure without touching other records', async () => {
    const zone = createFakeCloudflareDns({ zoneId: ZONE, token: TOKEN, seed: await seedWorld() });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === 'DELETE' && String(input).endsWith('/dangling-missing')
          ? new Response(JSON.stringify({ errors: [{ code: 10000, message: 'boom' }] }), {
              status: 500,
            })
          : zone.fetch(input, init)
      )
    );

    await expect(runAppRouteDnsReconciliation(env)).rejects.toThrow(/failed to delete 1/);
    expect(zone.records.has('dangling-missing')).toBe(true);
    for (const id of ['dangling-stopped', 'dangling-released']) {
      expect(zone.records.has(id), id).toBe(false);
    }
    expect(isRepointed(zone)).toBe(true);
    for (const id of KEPT_IDS) expect(zone.records.has(id), id).toBe(true);
  });

  it('never deletes a non-A record, even if the provider ignored the type filter', async () => {
    const zone = createFakeCloudflareDns({ zoneId: ZONE, token: TOKEN, seed: await seedWorld() });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        url.searchParams.delete('type');
        return zone.fetch(url.href, init);
      })
    );
    await runAppRouteDnsReconciliation(env);
    expect(zone.records.has('foreign-txt')).toBe(true);
    for (const id of DELETED_IDS) expect(zone.records.has(id), id).toBe(false);
    expect(isRepointed(zone)).toBe(true);
  });

  it('does nothing without a BASE_DOMAIN', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await runAppRouteDnsReconciliation({ ...env, BASE_DOMAIN: '' } as Env);
    expect(result.stoppedBy).toBe('no_base_domain');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('releaseNodeAppRouteDnsRecords against Cloudflare', () => {
  async function seedRelease() {
    await seedNode('releasing', 'destroying', RELEASED_IP);
    await seedNode('live-node', 'running', LIVE_IP);
    await seedEnvironment(ENV_RELEASED, 'releasing', 'stopping');
    // Unlinked before teardown (as a failed start leaves it): only the IP still ties it here.
    await seedEnvironment(ENV_UNLINKED_ON_RELEASED, null, 'error');
    await seedEnvironment(ENV_LIVE, 'live-node');
    return [
      rec('released-1', host(ENV_RELEASED), RELEASED_IP),
      rec('released-2', host(ENV_RELEASED, 2, 'api', 8080), RELEASED_IP),
      rec('unlinked', host(ENV_UNLINKED_ON_RELEASED), RELEASED_IP),
      rec('live', host(ENV_LIVE), LIVE_IP),
      ...FOREIGN_RECORDS,
    ];
  }

  it('deletes every app-route record pointing at the released IP, and only those', async () => {
    const zone = createFakeCloudflareDns({ zoneId: ZONE, token: TOKEN, seed: await seedRelease() });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));

    const counts = await releaseNodeAppRouteDnsRecords(env, {
      id: 'releasing',
      nodeRole: 'deployment',
      ipAddress: RELEASED_IP,
    });

    expect(counts).toMatchObject({ deleted: 3, failed: 0 });
    for (const id of ['released-1', 'released-2', 'unlinked'])
      expect(zone.records.has(id), id).toBe(false);
    for (const id of ['live', ...FOREIGN_RECORDS.map((r) => r.id)])
      expect(zone.records.has(id), id).toBe(true);
    const list = zone.requests.find((r) => r.url.includes('content.exact'));
    expect(new URL(list!.url).searchParams.get('content.exact')).toBe(RELEASED_IP);
  });

  it('throws when a record cannot be deleted, so the caller keeps the node retryable', async () => {
    const zone = createFakeCloudflareDns({ zoneId: ZONE, token: TOKEN, seed: await seedRelease() });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === 'DELETE'
          ? new Response(JSON.stringify({ errors: [{ code: 10000, message: 'boom' }] }), {
              status: 500,
            })
          : zone.fetch(input, init)
      )
    );
    await expect(
      releaseNodeAppRouteDnsRecords(env, {
        id: 'releasing',
        nodeRole: 'deployment',
        ipAddress: RELEASED_IP,
      })
    ).rejects.toThrow(/Could not delete 3 app-route DNS record/);
  });

  it('makes no DNS request for a node that serves no app routes', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(
      await releaseNodeAppRouteDnsRecords(env, {
        id: 'w',
        nodeRole: 'workspace',
        ipAddress: RELEASED_IP,
      })
    ).toBeNull();
    expect(
      await releaseNodeAppRouteDnsRecords(env, { id: 'd', nodeRole: 'deployment', ipAddress: null })
    ).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('on a self-host box that serves its own DNS', () => {
  function boxRows(): Array<{ id: string; name: string; content: string }> {
    return sqlite
      .prepare('SELECT id, name, content FROM selfhost_dns_records ORDER BY name')
      .all() as Array<{
      id: string;
      name: string;
      content: string;
    }>;
  }

  it('sweeps and releases through the box zone, never calling Cloudflare', async () => {
    applySqliteMigration(
      sqlite,
      new URL('../../../src/selfhost/migrations/0267_selfhost_dns_records.sql', import.meta.url)
    );
    installBoxDns();
    env = { ...env, SAM_DNS_PROVIDER: 'box' } as unknown as Env;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('no external request may be made on a box with its own DNS');
      })
    );
    const seed = await seedWorld();
    const insert = sqlite.prepare(
      "INSERT INTO selfhost_dns_records (id, name, type, content, created_at, updated_at) VALUES (?, ?, ?, ?, 'now', 'now')"
    );
    // The box zone holds A records only.
    for (const r of seed.filter((r) => r.type === 'A')) insert.run(r.id, r.name, r.type, r.content);
    settings.values.set('appRouteDns.sweepPageSize', 2);

    const result = await runAppRouteDnsReconciliation(env);

    const remaining = boxRows()
      .map((r) => r.id)
      .sort();
    expect(result).toMatchObject({ deleted: 3, repointed: 1, failed: 0, cycleComplete: true });
    for (const id of DELETED_IDS) expect(remaining).not.toContain(id);
    expect(boxRows().find((r) => r.id === REPOINTED_ID)?.content).toBe(LIVE_IP);
    for (const id of KEPT_IDS.filter((id) => id !== 'foreign-txt')) {
      expect(remaining).toContain(id);
    }

    // Release path: a live route moved onto a node that is now being released.
    sqlite.prepare("UPDATE nodes SET status = 'destroying' WHERE id = 'live-node'").run();
    const counts = await releaseNodeAppRouteDnsRecords(env, {
      id: 'live-node',
      nodeRole: 'deployment',
      ipAddress: LIVE_IP,
    });
    // live, live-2 and the record repointed above all sit on the node being released.
    expect(counts?.deleted).toBe(3);
    expect(boxRows().some((r) => r.content === LIVE_IP)).toBe(false);
  });
});

describe('released-IP judgement edges', () => {
  it('sweeps a record whose node failed teardown after its VM was proven deleted', async () => {
    await seedNode('half-retired', 'error', RELEASED_IP);
    sqlite
      .prepare(
        "UPDATE nodes SET runtime_termination_confirmed_at = '2026-11-22T00:00:00.000Z' WHERE id = 'half-retired'"
      )
      .run();
    await seedEnvironment(ENV_RELEASED, 'half-retired', 'error');
    // Control: an `error` node with no proof still holds its IP.
    await seedNode('erroring', 'error', LIVE_IP);
    await seedEnvironment(ENV_LIVE, 'erroring', 'error');
    const zone = createFakeCloudflareDns({
      zoneId: ZONE,
      token: TOKEN,
      seed: [
        rec('released', host(ENV_RELEASED), RELEASED_IP),
        rec('live', host(ENV_LIVE), LIVE_IP),
      ],
    });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));

    await runAppRouteDnsReconciliation(env);

    expect(zone.records.has('released')).toBe(false);
    expect(zone.records.has('live')).toBe(true);
  });

  it('re-judges each record on fresh D1 state, so a start that reused the IP keeps its route', async () => {
    const seed = await seedWorld();
    const zone = createFakeCloudflareDns({
      zoneId: ZONE,
      token: TOKEN,
      seed,
      beforeRequest: (method, url) => {
        // While the sweep is deleting the first dangling record, a start links ENV_RELEASED to a
        // new node that the provider gave the same recycled IP; its release fetch re-upserts the
        // record with unchanged content, so only D1 can tell the record is live again.
        if (method === 'GET' && url.pathname.endsWith('/dangling-stopped')) {
          sqlite
            .prepare(
              "INSERT INTO nodes (id, user_id, name, status, runtime, node_class, node_role, ip_address) VALUES ('reused', 'user', 'reused', 'running', 'vm', 'managed', 'deployment', ?)"
            )
            .run(RELEASED_IP);
          sqlite
            .prepare(
              "UPDATE deployment_environments SET node_id = 'reused', status = 'active' WHERE id = ?"
            )
            .run(ENV_RELEASED);
        }
      },
    });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));

    const result = await runAppRouteDnsReconciliation(env);

    expect(zone.records.has('dangling-released')).toBe(true);
    expect(zone.records.has('dangling-stopped')).toBe(false);
    expect(result.changed).toBe(1);
  });

  it('logs an unreadable environment row and leaves its record to the sweep instead of wedging teardown', async () => {
    await seedNode('releasing', 'destroying', RELEASED_IP);
    await seedEnvironment(ENV_RELEASED, 'releasing', 'stopping');
    await seedEnvironment(ENV_UNLINKED_ON_RELEASED, null, 'error');
    // A node row whose status cannot be read (a BLOB where TEXT belongs).
    sqlite
      .prepare(
        "INSERT INTO nodes (id, user_id, name, status, runtime, node_class, node_role, ip_address) VALUES ('garbled', 'user', 'garbled', X'00', 'vm', 'managed', 'deployment', ?)"
      )
      .run(RELEASED_IP);
    sqlite
      .prepare("UPDATE deployment_environments SET node_id = 'garbled' WHERE id = ?")
      .run(ENV_UNLINKED_ON_RELEASED);
    const zone = createFakeCloudflareDns({
      zoneId: ZONE,
      token: TOKEN,
      seed: [
        rec('released', host(ENV_RELEASED), RELEASED_IP),
        rec('unreadable', host(ENV_UNLINKED_ON_RELEASED), RELEASED_IP),
      ],
    });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));

    const counts = await releaseNodeAppRouteDnsRecords(env, {
      id: 'releasing',
      nodeRole: 'deployment',
      ipAddress: RELEASED_IP,
    });

    expect(counts).toMatchObject({ deleted: 1, unknown: 1 });
    expect(zone.records.has('released')).toBe(false);
    expect(zone.records.has('unreadable')).toBe(true);
  });

  it('counts names under the app-route suffix that are not SAM app routes', async () => {
    const zone = createFakeCloudflareDns({ zoneId: ZONE, token: TOKEN, seed: await seedWorld() });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));
    const result = await runAppRouteDnsReconciliation(env);
    // foo.apps, x-r1-…, the nested and the short-env names: listed by the suffix, never parsed.
    expect(result.unparsed).toBe(4);
  });
});

describe('sweep progress past records that always fail to delete', () => {
  it('reaches a later dangling record when the records ahead of it always fail to delete', async () => {
    settings.values.set('appRouteDns.sweepMaxDeletes', 2);
    const seed = await seedWorld();
    const zone = createFakeCloudflareDns({ zoneId: ZONE, token: TOKEN, seed });
    // The first two dangling records in name order can never be deleted.
    const stuck = new Set(['dangling-stopped', 'dangling-missing']);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === 'DELETE' && [...stuck].some((id) => String(input).endsWith(`/${id}`))
          ? new Response(JSON.stringify({ errors: [{ code: 10000, message: 'stuck' }] }), {
              status: 500,
            })
          : zone.fetch(input, init)
      )
    );

    for (let i = 0; i < 10 && (zone.records.has('dangling-released') || !isRepointed(zone)); i++) {
      await runAppRouteDnsReconciliation(env).catch(() => undefined);
    }

    expect(zone.records.has('dangling-released')).toBe(false);
    expect(isRepointed(zone)).toBe(true);
    for (const id of stuck) expect(zone.records.has(id)).toBe(true);
    for (const id of KEPT_IDS) expect(zone.records.has(id), id).toBe(true);
  });
});

describe('records of an environment that moved to a live node', () => {
  it('are repointed, not deleted, when the old node is released', async () => {
    await seedNode('releasing', 'destroying', RELEASED_IP);
    await seedNode('replacement', 'running', LIVE_IP);
    // Started again on a replacement before the old node's teardown finished.
    await seedEnvironment(ENV_LIVE, 'replacement');
    const zone = createFakeCloudflareDns({
      zoneId: ZONE,
      token: TOKEN,
      seed: [rec('moved', host(ENV_LIVE), RELEASED_IP)],
    });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));

    const counts = await releaseNodeAppRouteDnsRecords(env, {
      id: 'releasing',
      nodeRole: 'deployment',
      ipAddress: RELEASED_IP,
    });

    expect(counts).toMatchObject({ repointed: 1, deleted: 0 });
    expect(zone.byName(host(ENV_LIVE)).map((r) => r.content)).toEqual([LIVE_IP]);
    expect(zone.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('are deleted when the environment has no address to move to yet', async () => {
    await seedNode('releasing', 'destroying', RELEASED_IP);
    await seedNode('booting', 'creating', null);
    await seedEnvironment(ENV_LIVE, 'booting', 'starting');
    const zone = createFakeCloudflareDns({
      zoneId: ZONE,
      token: TOKEN,
      seed: [rec('moved', host(ENV_LIVE), RELEASED_IP)],
    });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));

    const counts = await releaseNodeAppRouteDnsRecords(env, {
      id: 'releasing',
      nodeRole: 'deployment',
      ipAddress: RELEASED_IP,
    });

    expect(counts).toMatchObject({ repointed: 0, deleted: 1 });
    expect(zone.byName(host(ENV_LIVE))).toEqual([]);
  });
});

describe('CodeRabbit review cases', () => {
  it('accepts only canonical lower-case ULIDs as the environment label', () => {
    const name = (envLabel: string) => `r1-web-80-${envLabel}.apps.${BASE}`;
    expect(parseAppRouteHostname(name('i'.repeat(26)), BASE)).toBeNull();
    expect(parseAppRouteHostname(name(`01kvjdv913s8w7kk32htztk0u${'0'}`), BASE)).toBeNull();
    expect(parseAppRouteHostname(name(`8${'0'.repeat(25)}`), BASE)).toBeNull();
    // Control: a real ULID label still parses.
    expect(parseAppRouteHostname(name(ENV_LIVE.toLowerCase()), BASE)).toEqual({
      environmentId: ENV_LIVE,
    });
  });

  it('skips one malformed list row and still cleans the rest of the page', async () => {
    const zone = createFakeCloudflareDns({ zoneId: ZONE, token: TOKEN, seed: await seedWorld() });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await zone.fetch(input, init);
        if (!String(input).includes('name.endswith')) return response;
        const body = (await response.json()) as { result: unknown[] };
        body.result.unshift({
          id: 42,
          name: host(ENV_MISSING, 7),
          type: 'A',
          content: RELEASED_IP,
        });
        return new Response(JSON.stringify(body), { status: 200 });
      })
    );

    const result = await runAppRouteDnsReconciliation(env);

    for (const id of DELETED_IDS) expect(zone.records.has(id), id).toBe(false);
    expect(isRepointed(zone)).toBe(true);
    expect(result.failed).toBe(0);
  });

  it('releases a node with more records than one page holds', async () => {
    settings.values.set('appRouteDns.sweepPageSize', 1);
    await seedNode('releasing', 'destroying', RELEASED_IP);
    await seedEnvironment(ENV_RELEASED, 'releasing', 'stopping');
    const zone = createFakeCloudflareDns({
      zoneId: ZONE,
      token: TOKEN,
      seed: [1, 2, 3].map((i) =>
        rec(`route-${i}`, host(ENV_RELEASED, i, 'web', 3000 + i), RELEASED_IP)
      ),
    });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));

    const counts = await releaseNodeAppRouteDnsRecords(env, {
      id: 'releasing',
      nodeRole: 'deployment',
      ipAddress: RELEASED_IP,
    });

    expect(counts?.deleted).toBe(3);
    expect(zone.records.size).toBe(0);
  });

  it('bounds release cleanup by its own budget even when the caller passes a longer deadline', async () => {
    settings.values.set('appRouteDns.sweepBudgetMs', 1000);
    await seedNode('releasing', 'destroying', RELEASED_IP);
    await seedEnvironment(ENV_RELEASED, 'releasing', 'stopping');
    const zone = createFakeCloudflareDns({
      zoneId: ZONE,
      token: TOKEN,
      seed: [1, 2, 3, 4, 5, 6].map((i) =>
        rec(`route-${i}`, host(ENV_RELEASED, i, 'web', 3000 + i), RELEASED_IP)
      ),
    });
    // Each delete is slow but succeeds, so only a whole-run budget can stop the loop.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') await new Promise((r) => setTimeout(r, 300));
        return zone.fetch(input, init);
      })
    );
    const callerDeadline = new AbortController().signal; // never aborts

    await expect(
      releaseNodeAppRouteDnsRecords(
        env,
        { id: 'releasing', nodeRole: 'deployment', ipAddress: RELEASED_IP },
        callerDeadline
      )
    ).rejects.toThrow(/Could not delete/);
    expect(zone.records.size).toBeGreaterThan(0);
  });

  it('still reaches later records in the same sweep when one record hangs on every attempt', async () => {
    settings.values.set('appRouteDns.sweepBudgetMs', 4000);
    const zone = createFakeCloudflareDns({ zoneId: ZONE, token: TOKEN, seed: await seedWorld() });
    // The first dangling record in name order never answers its DELETE.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE' && String(input).endsWith('/dangling-stopped')) {
          return new Promise<Response>((_, reject) =>
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          );
        }
        return zone.fetch(input, init);
      })
    );

    await runAppRouteDnsReconciliation(env).catch(() => undefined);

    expect(zone.records.has('dangling-stopped')).toBe(true);
    for (const id of ['dangling-missing', 'dangling-released']) {
      expect(zone.records.has(id), id).toBe(false);
    }
  });
});

describe('records the sweep cannot judge', () => {
  it('keeps them but fails the sweep on every run until the row is repaired', async () => {
    await seedEnvironment(ENV_STOPPED, null, 'stopped');
    await seedEnvironment(ENV_LIVE, null, 'stopped');
    // An environment row whose node link cannot be read (a BLOB where TEXT belongs).
    sqlite.prepare("UPDATE deployment_environments SET node_id = X'00' WHERE id = ?").run(ENV_LIVE);
    const zone = createFakeCloudflareDns({
      zoneId: ZONE,
      token: TOKEN,
      seed: [
        rec('unreadable', host(ENV_LIVE), RELEASED_IP),
        rec('dangling', host(ENV_STOPPED), RELEASED_IP),
      ],
    });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));

    for (let run = 0; run < 2; run++) {
      await expect(runAppRouteDnsReconciliation(env)).rejects.toThrow(/could not judge 1/);
    }
    expect(zone.records.has('unreadable')).toBe(true);
    // Liveness: the readable dangling record on the same page was still deleted.
    expect(zone.records.has('dangling')).toBe(false);
  });
});

describe('box zone paging with a malformed stored row', () => {
  it('keeps paging past a full page that held a row it had to drop', async () => {
    applySqliteMigration(
      sqlite,
      new URL('../../../src/selfhost/migrations/0267_selfhost_dns_records.sql', import.meta.url)
    );
    installBoxDns();
    env = { ...env, SAM_DNS_PROVIDER: 'box' } as unknown as Env;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('no external request may be made on a box with its own DNS');
      })
    );
    settings.values.set('appRouteDns.sweepPageSize', 2);
    await seedNode('live-node', 'running', LIVE_IP);
    await seedEnvironment(ENV_LIVE, 'live-node');
    const insert = sqlite.prepare(
      "INSERT INTO selfhost_dns_records (id, name, type, content, created_at, updated_at) VALUES (?, ?, 'A', ?, 'now', 'now')"
    );
    // Page 1 (by name): a row whose content is not an IPv4 address, then a live route.
    insert.run('garbled', `a-garbled.apps.${BASE}`, 'not-an-ip');
    insert.run('live', `b-${host(ENV_LIVE).replace(/^r1-/, 'x')}`, LIVE_IP);
    // Page 2: a dangling route.
    insert.run('dangling', `r9-web-80-${ENV_MISSING.toLowerCase()}.apps.${BASE}`, RELEASED_IP);

    const result = await runAppRouteDnsReconciliation(env);

    const ids = (
      sqlite.prepare('SELECT id FROM selfhost_dns_records').all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(ids).not.toContain('dangling');
    expect(ids).toEqual(expect.arrayContaining(['garbled', 'live']));
    expect(result.cycleComplete).toBe(true);
  });
});

describe('Codex review round 4', () => {
  it('accepts only ports buildRouteHostname can write', () => {
    const name = (port: string) => `r1-web-${port}-${ENV_LIVE.toLowerCase()}.apps.${BASE}`;
    expect(parseAppRouteHostname(name('00080'), BASE)).toBeNull();
    expect(parseAppRouteHostname(name('0'), BASE)).toBeNull();
    expect(parseAppRouteHostname(name('70000'), BASE)).toBeNull();
    expect(parseAppRouteHostname(name('65535'), BASE)).toEqual({ environmentId: ENV_LIVE });
    expect(parseAppRouteHostname(name('80'), BASE)).toEqual({ environmentId: ENV_LIVE });
  });

  it('repoints each stale sibling by id, then deletes any that would duplicate a live one', async () => {
    await seedNode('live-node', 'running', LIVE_IP);
    await seedEnvironment(ENV_LIVE, 'live-node');
    // Two stale A records for one name (a node migration can leave this): the first is moved to
    // the live address by id, the second would then duplicate it, so it is deleted.
    const zone = createFakeCloudflareDns({
      zoneId: ZONE,
      token: TOKEN,
      seed: [
        rec('a-stale', host(ENV_LIVE), '10.0.0.8'),
        rec('b-stale', host(ENV_LIVE), RELEASED_IP),
      ],
    });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));

    const result = await runAppRouteDnsReconciliation(env);

    expect([...zone.records.values()].map((r) => [r.id, r.content])).toEqual([
      ['a-stale', LIVE_IP],
    ]);
    expect(result).toMatchObject({ repointed: 1, deleted: 1, failed: 0 });
  });

  it('deletes a stale sibling instead of updating it into a duplicate of a live one', async () => {
    await seedNode('live-node', 'running', LIVE_IP);
    await seedEnvironment(ENV_LIVE, 'live-node');
    const zone = createFakeCloudflareDns({
      zoneId: ZONE,
      token: TOKEN,
      seed: [rec('a-live', host(ENV_LIVE), LIVE_IP), rec('b-stale', host(ENV_LIVE), RELEASED_IP)],
    });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));

    await runAppRouteDnsReconciliation(env);

    expect(zone.records.has('b-stale')).toBe(false);
    expect(zone.records.get('a-live')?.content).toBe(LIVE_IP);
    expect(zone.requests.some((r) => r.method === 'PATCH')).toBe(false);
  });

  it('backs off a record whose delete keeps failing, but keeps reporting it', async () => {
    const zone = createFakeCloudflareDns({ zoneId: ZONE, token: TOKEN, seed: await seedWorld() });
    const deletes: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') deletes.push(String(input).split('/').pop() ?? '');
        if (init?.method === 'DELETE' && String(input).endsWith('/dangling-missing')) {
          return new Response(JSON.stringify({ errors: [{ code: 10000, message: 'boom' }] }), {
            status: 500,
          });
        }
        return zone.fetch(input, init);
      })
    );

    await expect(runAppRouteDnsReconciliation(env)).rejects.toThrow(/failed to delete 1/);
    // Second run: no DNS call for the backed-off record, still a failed sweep.
    await expect(runAppRouteDnsReconciliation(env)).rejects.toThrow(/failed to delete 1/);
    expect(deletes.filter((id) => id === 'dangling-missing')).toHaveLength(1);
    // Once the backoff expires it is tried again.
    await env.KV.delete(`dns:app-route-sweep:backoff:dangling-missing`);
    await expect(runAppRouteDnsReconciliation(env)).rejects.toThrow(/failed to delete 1/);
    expect(deletes.filter((id) => id === 'dangling-missing')).toHaveLength(2);
    expect(zone.records.has('dangling-missing')).toBe(true);
  });
});

describe('Codex review round 5', () => {
  it('accepts only the service part buildRouteHostname can write', () => {
    const name = (service: string) => `r1-${service}-80-${ENV_LIVE.toLowerCase()}.apps.${BASE}`;
    expect(parseAppRouteHostname(name('foo--bar'), BASE)).toBeNull();
    // A trailing hyphen only survives the cut at exactly 24 characters.
    expect(parseAppRouteHostname(name('foo-'), BASE)).toBeNull();
    expect(parseAppRouteHostname(name(`${'a'.repeat(22)}-`), BASE)).toBeNull();
    expect(parseAppRouteHostname(name('a'.repeat(25)), BASE)).toBeNull();
    // Controls: a hyphenated service, and one cut at 24 characters leaving a trailing hyphen.
    expect(parseAppRouteHostname(name('my-api'), BASE)).toEqual({ environmentId: ENV_LIVE });
    expect(parseAppRouteHostname(name(`${'a'.repeat(23)}-`), BASE)).toEqual({
      environmentId: ENV_LIVE,
    });
  });

  it('does nothing on an installation with no DNS API (operator-managed wildcard DNS)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const noApi = { ...env, CF_ZONE_ID: undefined, CF_API_TOKEN: undefined } as unknown as Env;
    await seedNode('releasing', 'destroying', RELEASED_IP);
    expect(
      await releaseNodeAppRouteDnsRecords(noApi, {
        id: 'releasing',
        nodeRole: 'deployment',
        ipAddress: RELEASED_IP,
      })
    ).toBeNull();
    const result = await runAppRouteDnsReconciliation(noApi);
    expect(result.stoppedBy).toBe('no_dns_api');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Codex review round 6', () => {
  it('deletes a repointed record at once when its new target starts teardown mid-repoint', async () => {
    await seedNode('live-node', 'running', LIVE_IP);
    await seedEnvironment(ENV_LIVE, 'live-node');
    const zone = createFakeCloudflareDns({
      zoneId: ZONE,
      token: TOKEN,
      seed: [rec('stale', host(ENV_LIVE), RELEASED_IP)],
      beforeRequest: (method) => {
        // The repoint lands just as the live node begins its own teardown.
        if (method === 'PATCH') {
          sqlite.prepare("UPDATE nodes SET status = 'destroying' WHERE id = 'live-node'").run();
        }
      },
    });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));

    const result = await runAppRouteDnsReconciliation(env);

    expect(zone.records.has('stale')).toBe(false);
    expect(result).toMatchObject({ repointed: 0, deleted: 1 });
  });
});

describe('adversarial re-verification round 2', () => {
  it('keeps a moved record when the environment moved on again during the repoint', async () => {
    await seedNode('live-node', 'running', LIVE_IP);
    await seedNode('next-node', 'running', '10.0.0.4');
    await seedEnvironment(ENV_LIVE, 'live-node');
    const zone = createFakeCloudflareDns({
      zoneId: ZONE,
      token: TOKEN,
      seed: [rec('stale', host(ENV_LIVE), RELEASED_IP)],
      beforeRequest: (method) => {
        if (method === 'PATCH') {
          // The environment moves to another live node; its release fetch will write the record.
          sqlite
            .prepare("UPDATE deployment_environments SET node_id = 'next-node' WHERE id = ?")
            .run(ENV_LIVE);
        }
      },
    });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));

    await runAppRouteDnsReconciliation(env);

    expect(zone.records.has('stale')).toBe(true);
  });

  it('releases every record even when a write in flight moves one off the content filter', async () => {
    settings.values.set('appRouteDns.sweepPageSize', 1);
    await seedNode('releasing', 'destroying', RELEASED_IP);
    await seedEnvironment(ENV_RELEASED, 'releasing', 'stopping');
    const zone = createFakeCloudflareDns({
      zoneId: ZONE,
      token: TOKEN,
      seed: [
        rec('first', host(ENV_RELEASED, 1), RELEASED_IP),
        rec('second', host(ENV_RELEASED, 2), RELEASED_IP),
      ],
      beforeRequest: (method, url) => {
        // The guarded delete's re-read of the first record finds it rewritten elsewhere: it is
        // `changed`, and it no longer matches the release's `content` filter.
        if (method === 'GET' && url.pathname.endsWith('/first')) {
          const first = zone.records.get('first');
          if (first) first.content = '10.0.0.9';
        }
      },
    });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));

    const counts = await releaseNodeAppRouteDnsRecords(env, {
      id: 'releasing',
      nodeRole: 'deployment',
      ipAddress: RELEASED_IP,
    });

    // The second record shifted onto page 1 when the first left the filter; it is still reached.
    expect(zone.records.has('second')).toBe(false);
    expect(counts).toMatchObject({ changed: 1, deleted: 1 });
  });
});

describe('Codex review round 7', () => {
  it('finds the observed record by id even when its name has more records than one list page', async () => {
    const zone = createFakeCloudflareDns({
      zoneId: ZONE,
      token: TOKEN,
      seed: [rec('dangling', host(ENV_MISSING), RELEASED_IP)],
    });
    // The exact-name lookup returns only one page, which does not include the observed record.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.searchParams.get('name') === host(ENV_MISSING)) {
          return new Response(JSON.stringify({ success: true, errors: [], result: [] }), {
            status: 200,
          });
        }
        return zone.fetch(input, init);
      })
    );

    const result = await runAppRouteDnsReconciliation(env);

    expect(zone.records.has('dangling')).toBe(false);
    expect(result).toMatchObject({ deleted: 1, absent: 0 });
  });
});

describe('Codex review round 8', () => {
  it('sees a live sibling the exact-name page would have left out, and deletes the stale one', async () => {
    await seedNode('live-node', 'running', LIVE_IP);
    await seedEnvironment(ENV_LIVE, 'live-node');
    const zone = createFakeCloudflareDns({
      zoneId: ZONE,
      token: TOKEN,
      seed: [rec('a-live', host(ENV_LIVE), LIVE_IP), rec('b-stale', host(ENV_LIVE), RELEASED_IP)],
    });
    // A by-name lookup without an address filter returns only a page without the live sibling.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (
          url.searchParams.get('name') === host(ENV_LIVE) &&
          !url.searchParams.get('content.exact')
        ) {
          return new Response(JSON.stringify({ success: true, errors: [], result: [] }), {
            status: 200,
          });
        }
        return zone.fetch(input, init);
      })
    );

    await runAppRouteDnsReconciliation(env);

    expect(zone.records.has('b-stale')).toBe(false);
    expect(zone.records.get('a-live')?.content).toBe(LIVE_IP);
    expect(zone.requests.some((r) => r.method === 'PATCH')).toBe(false);
  });
});

describe('Codex review round 9', () => {
  it('ends a hung repoint as soon as the caller deadline fires', async () => {
    await seedNode('releasing', 'destroying', RELEASED_IP);
    await seedNode('live-node', 'running', LIVE_IP);
    await seedEnvironment(ENV_LIVE, 'live-node');
    const zone = createFakeCloudflareDns({
      zoneId: ZONE,
      token: TOKEN,
      seed: [rec('moved', host(ENV_LIVE), RELEASED_IP)],
    });
    const deadline = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          // The PATCH stalls; the node teardown's deadline fires meanwhile.
          setTimeout(() => deadline.abort(new Error('teardown deadline')), 50);
          return new Promise<Response>((_, reject) =>
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          );
        }
        return zone.fetch(input, init);
      })
    );

    const started = Date.now();
    await expect(
      releaseNodeAppRouteDnsRecords(
        env,
        { id: 'releasing', nodeRole: 'deployment', ipAddress: RELEASED_IP },
        deadline.signal
      )
    ).rejects.toThrow(/Could not delete 1/);
    // Bounded by the caller's deadline, not the 5 s per-request timeout.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
