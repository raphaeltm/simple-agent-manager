import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  chooseCandidatesToActivate,
  readPrimaryPoolPicks,
  seedInstallationPool,
} from '../deploy/bootstrap-installation-pool';
import type { D1Like } from '../deploy/bootstrap-staging-installation';

const SOURCE = 'cap-source-default:platform:staging2-bootstrap-cloud';
const LIMITS = { minMemoryMb: 8192, minVcpu: 2, fallbackPerRole: 2 };

function candidate(overrides: Record<string, unknown>) {
  return {
    id: 'c',
    capacitySourceId: SOURCE,
    provider: 'hetzner',
    location: 'fsn1',
    workloadRole: 'workspace',
    providerInstanceType: 'cx33',
    providerInstanceVcpuCount: 4,
    providerInstanceMemoryMb: 8192,
    providerInstancePriceHourlyMicros: 10,
    status: 'disabled',
    catalogAvailability: 'available',
    ...overrides,
  };
}

const PRIMARY_PICKS = [
  {
    provider: 'hetzner',
    location: 'fsn1',
    providerInstanceType: 'cx33',
    workloadRole: 'workspace',
  },
  {
    provider: 'hetzner',
    location: 'nbg1',
    providerInstanceType: 'cx43',
    workloadRole: 'deployment',
  },
];

describe('chooseCandidatesToActivate', () => {
  it('mirrors the primary pool for the same provider, region, type and role', () => {
    const chosen = chooseCandidatesToActivate(
      [
        candidate({ id: 'mirror-1' }),
        candidate({
          id: 'mirror-2',
          location: 'nbg1',
          providerInstanceType: 'cx43',
          workloadRole: 'deployment',
        }),
        candidate({ id: 'other-role', workloadRole: 'deployment' }),
        candidate({ id: 'other-source', capacitySourceId: 'cap-source-default:platform:manual' }),
        candidate({
          id: 'unavailable',
          location: 'nbg1',
          providerInstanceType: 'cx43',
          workloadRole: 'deployment',
          catalogAvailability: 'last-known-unavailable',
        }),
      ],
      PRIMARY_PICKS,
      SOURCE,
      LIMITS
    );
    expect(chosen.map((c) => c.id)).toEqual(['mirror-1', 'mirror-2']);
  });

  it('falls back to the cheapest fitting machines per role when the providers differ', () => {
    const chosen = chooseCandidatesToActivate(
      [
        candidate({
          id: 'small',
          provider: 'gcp',
          providerInstanceType: 'e2-medium',
          providerInstanceMemoryMb: 4096,
          providerInstancePriceHourlyMicros: 1,
        }),
        candidate({
          id: 'cheap',
          provider: 'gcp',
          providerInstanceType: 'e2-standard-2',
          providerInstancePriceHourlyMicros: 5,
        }),
        candidate({
          id: 'mid',
          provider: 'gcp',
          providerInstanceType: 'n2-standard-2',
          providerInstancePriceHourlyMicros: 7,
        }),
        candidate({
          id: 'dear',
          provider: 'gcp',
          providerInstanceType: 'n2-standard-8',
          providerInstancePriceHourlyMicros: 90,
        }),
        candidate({
          id: 'one-cpu',
          provider: 'gcp',
          providerInstanceVcpuCount: 1,
          providerInstancePriceHourlyMicros: 2,
        }),
        candidate({
          id: 'deploy',
          provider: 'gcp',
          workloadRole: 'deployment',
          providerInstancePriceHourlyMicros: 6,
        }),
      ],
      PRIMARY_PICKS,
      SOURCE,
      LIMITS
    );
    expect(chosen.map((c) => c.id).sort()).toEqual(['cheap', 'deploy', 'mid']);
  });

  it('returns nothing when no machine fits', () => {
    expect(
      chooseCandidatesToActivate(
        [candidate({ providerInstanceMemoryMb: 2048 })],
        [],
        SOURCE,
        LIMITS
      )
    ).toEqual([]);
  });
});

describe('seedInstallationPool', () => {
  function fakeApi(catalogAfter: number, candidates: ReturnType<typeof candidate>[]) {
    const calls: Array<{ method: string; url: string; body?: unknown; cookie?: string | null }> =
      [];
    let reconciles = 0;
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const headers = new Headers(init.headers);
      calls.push({
        method,
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        cookie: headers.get('cookie'),
      });
      if (url.endsWith('/api/auth/token-login')) {
        return new Response('{}', {
          status: 200,
          headers: { 'Set-Cookie': '__Secure-better-auth.session_token=abc; Path=/; HttpOnly' },
        });
      }
      if (url.endsWith('/defaults/reconcile')) {
        reconciles++;
        const published = reconciles >= catalogAfter ? candidates : [];
        return Response.json({ effective: { candidates: published } });
      }
      if (url.endsWith('/defaults') && method === 'PATCH') {
        return Response.json({ effective: { candidates } });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  const base = {
    apiBaseUrl: 'https://api.sammy2.party',
    appOrigin: 'https://app.sammy2.party',
    smokeTestToken: 'sam_x',
    primaryPicks: PRIMARY_PICKS,
    credentialId: 'staging2-bootstrap-cloud',
    catalogWaitMs: 0,
    sleep: async () => {},
    log: () => {},
  };

  it('signs in, waits for the catalog and activates only machines not already active', async () => {
    const { calls, fetchImpl } = fakeApi(3, [
      candidate({ id: 'a' }),
      candidate({
        id: 'b',
        location: 'nbg1',
        providerInstanceType: 'cx43',
        workloadRole: 'deployment',
        status: 'active',
      }),
    ]);
    const result = await seedInstallationPool({ ...base, fetchImpl });

    expect(result).toEqual({ activated: 1, alreadyActive: 1, mirrored: true });
    expect(calls.filter((c) => c.url.endsWith('/reconcile'))).toHaveLength(3);
    const patch = calls.find((c) => c.method === 'PATCH');
    // One machine was already active, so this is not the first seeding: no node cap is written.
    expect(patch?.body).toEqual({ candidates: [{ id: 'a', status: 'active' }] });
    expect(patch?.cookie).toBe('__Secure-better-auth.session_token=abc');
  });

  it('caps the node count on the first seeding only', async () => {
    const { calls, fetchImpl } = fakeApi(1, [
      candidate({ id: 'a' }),
      candidate({
        id: 'b',
        location: 'nbg1',
        providerInstanceType: 'cx43',
        workloadRole: 'deployment',
      }),
    ]);
    await seedInstallationPool({ ...base, fetchImpl });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      policy: { maxNodes: 2 },
      candidates: [
        { id: 'a', status: 'active' },
        { id: 'b', status: 'active' },
      ],
    });
  });

  it('does not write when everything chosen is already active', async () => {
    const { calls, fetchImpl } = fakeApi(1, [candidate({ id: 'a', status: 'active' })]);
    await seedInstallationPool({ ...base, fetchImpl });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('fails rather than leave the pool empty', async () => {
    const { fetchImpl } = fakeApi(99, [candidate({ id: 'a' })]);
    await expect(
      seedInstallationPool({ ...base, fetchImpl, catalogWaitAttempts: 2 })
    ).rejects.toThrow(/pool would stay empty/);
  });

  it('fails when the bootstrap admin cannot sign in', async () => {
    const fetchImpl = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch;
    await expect(seedInstallationPool({ ...base, fetchImpl })).rejects.toThrow(
      /sign-in failed: HTTP 401/
    );
  });
});

describe('readPrimaryPoolPicks on the real migration chain', () => {
  it('reads the active machines of the installation pool only', async () => {
    const dir = new URL('../../apps/api/src/db/migrations/', import.meta.url);
    const db = new DatabaseSync(':memory:');
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      db.exec(readFileSync(new URL(file, dir), 'utf8'));
    }
    // The read under test only needs pool and candidate rows, not their sources.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(
      `INSERT INTO users (id, email, role, status, created_at, updated_at) VALUES ('owner', 'o@x', 'superadmin', 'active', 1, 1)`
    );
    const pool = db.prepare(
      `INSERT INTO capacity_pools (id, scope, owner_user_id, owner_project_id, name, is_default, status, strategy, exhaustion_policy, created_by)
       VALUES (?, ?, ?, NULL, 'p', 1, 'active', 'balanced', 'queue', 'owner')`
    );
    pool.run('installation-pool', 'installation', null);
    pool.run('user-pool', 'user', 'owner');
    const add = db.prepare(
      `INSERT INTO capacity_pool_candidates (id, pool_id, capacity_source_id, provider, location, workload_role, provider_instance_type, status)
       VALUES (?, ?, 'src', 'hetzner', ?, 'workspace', ?, ?)`
    );
    add.run('1', 'installation-pool', 'fsn1', 'cx33', 'active');
    add.run('2', 'installation-pool', 'fsn1', 'cx53', 'disabled');
    add.run('3', 'user-pool', 'hel1', 'cx43', 'active');
    const d1: D1Like = {
      all: async <T>(sql: string) => db.prepare(sql).all() as T[],
      run: async () => {},
    };

    expect(await readPrimaryPoolPicks(d1)).toEqual([
      {
        provider: 'hetzner',
        location: 'fsn1',
        providerInstanceType: 'cx33',
        workloadRole: 'workspace',
      },
    ]);
  });
});
