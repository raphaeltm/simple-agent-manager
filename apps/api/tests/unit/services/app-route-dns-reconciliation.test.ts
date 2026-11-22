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

const DANGLING_IDS = [
  'dangling-stopped',
  'dangling-missing',
  'dangling-released',
  'dangling-mismatch',
];
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
    // A truncated service can end in a hyphen.
    expect(
      parseAppRouteHostname(`r12-my-svc--3000-${ENV_LIVE.toLowerCase()}.apps.${BASE}`, BASE)
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
      })
    ).toEqual({ live: true });
    // A stopped node keeps its provider IP; its routes are not dangling.
    expect(
      judgeAppRouteRecord(record, {
        nodeId: 'n',
        nodeStatus: 'stopped',
        ipAddress: LIVE_IP,
        terminationConfirmedAt: null,
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
      })
    ).toEqual({ live: false, reason: 'node_released' });
    expect(
      judgeAppRouteRecord(record, {
        nodeId: 'n',
        nodeStatus: 'error',
        ipAddress: LIVE_IP,
        terminationConfirmedAt: null,
      })
    ).toEqual({ live: true });
    for (const status of ['destroying', 'deleting', 'deleted', 'destroyed']) {
      expect(
        judgeAppRouteRecord(record, {
          nodeId: 'n',
          nodeStatus: status,
          ipAddress: LIVE_IP,
          terminationConfirmedAt: null,
        })
      ).toEqual({ live: false, reason: 'node_released' });
    }
  });
});

describe('runAppRouteDnsReconciliation against Cloudflare', () => {
  it('deletes each dangling app-route record and nothing else in the zone', async () => {
    const zone = createFakeCloudflareDns({ zoneId: ZONE, token: TOKEN, seed: await seedWorld() });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));

    const result = await runAppRouteDnsReconciliation(env);

    for (const id of DANGLING_IDS) expect(zone.records.has(id), id).toBe(false);
    for (const id of KEPT_IDS) expect(zone.records.has(id), id).toBe(true);
    expect(result).toMatchObject({
      deleted: 4,
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

    for (const id of DANGLING_IDS) expect(zone.records.has(id), id).toBe(false);
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
    for (let i = 0; i < 10 && DANGLING_IDS.some((id) => zone.records.has(id)); i++) {
      runs.push(await runAppRouteDnsReconciliation(env));
    }
    expect(runs.length).toBe(4);
    expect(runs.map((r) => r.deleted)).toEqual([1, 1, 1, 1]);
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
        if (method === 'GET' && url.searchParams.get('name') === host(ENV_STOPPED)) {
          const record = zone.records.get('dangling-stopped');
          if (record) record.content = '10.0.0.77';
        }
      },
    });
    vi.stubGlobal('fetch', vi.fn(zone.fetch));

    const result = await runAppRouteDnsReconciliation(env);

    expect(zone.records.get('dangling-stopped')?.content).toBe('10.0.0.77');
    expect(result.changed).toBe(1);
    expect(result.deleted).toBe(3);
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
    for (const id of ['dangling-stopped', 'dangling-released', 'dangling-mismatch']) {
      expect(zone.records.has(id), id).toBe(false);
    }
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
    for (const id of DANGLING_IDS) expect(zone.records.has(id), id).toBe(false);
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
    expect(result).toMatchObject({ deleted: 4, failed: 0, cycleComplete: true });
    for (const id of DANGLING_IDS) expect(remaining).not.toContain(id);
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
    expect(counts?.deleted).toBe(2);
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
        if (method === 'GET' && url.searchParams.get('name') === host(ENV_STOPPED)) {
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

    for (
      let i = 0;
      i < 10 && (zone.records.has('dangling-released') || zone.records.has('dangling-mismatch'));
      i++
    ) {
      await runAppRouteDnsReconciliation(env).catch(() => undefined);
    }

    expect(zone.records.has('dangling-released')).toBe(false);
    expect(zone.records.has('dangling-mismatch')).toBe(false);
    for (const id of stuck) expect(zone.records.has(id)).toBe(true);
    for (const id of KEPT_IDS) expect(zone.records.has(id), id).toBe(true);
  });
});
