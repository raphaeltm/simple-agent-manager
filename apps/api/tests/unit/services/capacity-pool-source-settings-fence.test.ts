/**
 * Account switches (`excluded_source_ids_json`) and provider order on a real SQLite engine:
 *
 * - the safe effective summary lists only the offerings of accounts that are on;
 * - every write that depends on the stored settings is a compare-and-set, including an edit that
 *   merely ACTIVATES a machine (the activation race);
 * - an edit that activates many machines and rewrites the settings stays inside the 100-bind D1
 *   ceiling (the SQLite helper enforces it);
 * - the column CHECK and the TypeScript reader agree on which ids are excluded.
 *
 * Rule 28 (real SQL engine, attack + control pairs) and rule 62 (enter through the real trigger):
 * the interleavings below happen inside `updateDefaultCapacityPool` itself, not by calling the
 * lower-level helpers in a hand-picked order.
 */
import { MAX_CAPACITY_POOL_SOURCE_ORDER_LENGTH } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { parseCapacityPoolExcludedSources } from '../../../src/services/capacity-pools';
import {
  publishSourceSettingsOnly,
  resolveSourceSettingsUpdate,
} from '../../../src/services/default-capacity-pool-source-settings';
import { toSafeEffectiveCapacityPoolSummary } from '../../../src/services/default-capacity-pool-summaries';
import { updateDefaultCapacityPool } from '../../../src/services/default-capacity-pool-updates';
import {
  ensureDefaultCapacityPoolsForExistingCredentials,
  findDefaultPool,
  readDefaultCapacityPoolSummaries,
} from '../../../src/services/default-capacity-pools';
import { capacityPoolExcludedSourcesMigrationSql } from '../../helpers/capacity-pool-migrations';
import { offering } from '../../helpers/capacity-pool-offerings';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';
import { seedCloudCredential, seedUser } from '../routes/capacity-pool-test-seeds';

let sqlite: Database.Database | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

const SCOPE = { scope: 'user', ownerUserId: 'user-1', ownerProjectId: null } as const;

type OfferingsByProvider = Record<string, ReturnType<typeof offering>[]>;

function fixture(offeringsByProvider: OfferingsByProvider, providers: string[]) {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  seedUser(sqlite, 'user-1');
  providers.forEach((provider, index) =>
    seedCloudCredential(sqlite!, { id: `cred-${index}`, userId: 'user-1', provider })
  );
  const raw = createSqliteD1WithBindLimit(sqlite, 100);
  const d1 = drizzle(raw, { schema });
  return { raw, d1 };
}

async function refresh(d1: ReturnType<typeof fixture>['d1'], offerings: OfferingsByProvider) {
  await ensureDefaultCapacityPoolsForExistingCredentials(d1 as never, {
    userId: 'user-1',
    includeInstallation: false,
    candidatePublishBatchSize: 1000,
    offeringResolver: async (seed) => offerings[seed.provider] ?? [],
  });
}

function sourceIdByProvider(provider: string): string {
  return (
    sqlite!.prepare('SELECT id FROM capacity_sources WHERE provider = ?').get(provider) as {
      id: string;
    }
  ).id;
}

function excludedColumn(): string | null {
  return (
    sqlite!.prepare('SELECT excluded_source_ids_json AS v FROM capacity_pools').get() as {
      v: string | null;
    }
  ).v;
}

function sourceOrderColumn(): string | null {
  return (
    sqlite!.prepare('SELECT source_order_json AS v FROM capacity_pools').get() as {
      v: string | null;
    }
  ).v;
}

function workspaceStatus(where: string): string {
  return (
    sqlite!
      .prepare(
        `SELECT status FROM capacity_pool_candidates WHERE workload_role = 'workspace' AND ${where}`
      )
      .get() as { status: string }
  ).status;
}

async function activateAllWorkspaceRows(d1: ReturnType<typeof fixture>['d1']) {
  const ids = (
    sqlite!
      .prepare("SELECT id FROM capacity_pool_candidates WHERE workload_role = 'workspace'")
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
  const result = await updateDefaultCapacityPool(d1 as never, {
    ...SCOPE,
    candidates: ids.map((id) => ({ id, status: 'active' as const })),
  });
  expect(result.conflict).toBe(false);
  return ids;
}

/** Runs `competingWrite` once, just before the first statement that writes the pool. */
function withInterleavedWrite(
  database: D1Database,
  competingWrite: () => void
): { database: D1Database; fired: () => boolean } {
  let fired = false;
  const prepare = (query: string) => {
    if (!fired && /^\s*update\s+"capacity_pool/i.test(query)) {
      fired = true;
      competingWrite();
    }
    return database.prepare(query);
  };
  return { database: { ...database, prepare } as unknown as D1Database, fired: () => fired };
}

describe('safe effective summary skips switched-off accounts', () => {
  const OFFERINGS: OfferingsByProvider = {
    hetzner: [offering('hetzner', 'fsn1', 'cx33', { currency: 'EUR' })],
    gcp: [offering('gcp', 'europe-west1-b', 'e2-standard-4')],
  };

  async function twoAccountSummary() {
    const { d1 } = fixture(OFFERINGS, ['hetzner', 'gcp']);
    await refresh(d1, OFFERINGS);
    await activateAllWorkspaceRows(d1);
    const hetznerSource = sourceIdByProvider('hetzner');
    const gcpSource = sourceIdByProvider('gcp');
    const safe = async (excludedSourceIds: string[]) => {
      const result = await updateDefaultCapacityPool(d1 as never, { ...SCOPE, excludedSourceIds });
      expect(result).toMatchObject({ conflict: false, missingSourceIds: [] });
      // Read back from the database, as the route does, rather than trusting the write result.
      const read = await readDefaultCapacityPoolSummaries(d1 as never, {
        userId: 'user-1',
        includeInstallation: false,
        includeDisabled: true,
      });
      return toSafeEffectiveCapacityPoolSummary(read.user);
    };
    return { hetznerSource, gcpSource, safe };
  }

  const keys = (summary: ReturnType<typeof toSafeEffectiveCapacityPoolSummary>) =>
    (summary.nativeOfferings ?? []).map(
      (o) => `${o.provider}/${o.location}/${o.providerInstanceType}`
    );

  it('lists both accounts when none is switched off (control)', async () => {
    const { safe } = await twoAccountSummary();
    const summary = await safe([]);
    expect(summary.state).toBe('configured-ready');
    expect(keys(summary).sort()).toEqual(['gcp/europe-west1-b/e2-standard-4', 'hetzner/fsn1/cx33']);
  });

  it('lists only account B when account A is switched off', async () => {
    const { hetznerSource, safe } = await twoAccountSummary();
    const summary = await safe([hetznerSource]);
    expect(summary.state).toBe('configured-ready');
    expect(keys(summary)).toEqual(['gcp/europe-west1-b/e2-standard-4']);
  });

  it('lists only account A when account B is switched off', async () => {
    const { gcpSource, safe } = await twoAccountSummary();
    expect(keys(await safe([gcpSource]))).toEqual(['hetzner/fsn1/cx33']);
  });

  it('is configured-empty with no native offerings when every account is switched off', async () => {
    const { hetznerSource, gcpSource, safe } = await twoAccountSummary();
    const summary = await safe([hetznerSource, gcpSource]);
    expect(summary.state).toBe('configured-empty');
    expect(summary.reason).toBe('configured-default-pool-has-no-active-candidates');
    expect(summary.nativeOfferings).toEqual([]);
    // Their picks are kept, so the empty state is the switch, not lost machines.
    expect(workspaceStatus("provider = 'hetzner'")).toBe('active');
    expect(workspaceStatus("provider = 'gcp'")).toBe('active');
  });
});

describe('compare-and-set on the stored account settings', () => {
  const OFFERINGS: OfferingsByProvider = {
    hetzner: [
      offering('hetzner', 'fsn1', 'cx33', { currency: 'EUR' }),
      offering('hetzner', 'nbg1', 'cx33', { currency: 'EUR' }),
    ],
    gcp: [offering('gcp', 'europe-west1-b', 'e2-standard-4')],
  };

  async function setup() {
    const f = fixture(OFFERINGS, ['hetzner', 'gcp']);
    await refresh(f.d1, OFFERINGS);
    return { ...f, hz: sourceIdByProvider('hetzner'), gcp: sourceIdByProvider('gcp') };
  }

  it('publishes a fresh read (control)', async () => {
    const { d1, hz } = await setup();
    const pool = (await findDefaultPool(d1 as never, SCOPE))!;
    const update = await resolveSourceSettingsUpdate(
      d1 as never,
      pool,
      { ...SCOPE, excludedSourceIds: [hz] },
      []
    );
    expect(update).toMatchObject({ changed: true, missingSourceIds: [] });

    expect(await publishSourceSettingsOnly(d1 as never, pool, update)).toBe(true);
    expect(excludedColumn()).toBe(JSON.stringify([hz]));
  });

  it('conflicts on a stale sourceOrder write and keeps the first writer', async () => {
    const { d1, hz, gcp } = await setup();
    const pool = (await findDefaultPool(d1 as never, SCOPE))!;
    const first = await resolveSourceSettingsUpdate(
      d1 as never,
      pool,
      { ...SCOPE, sourceOrder: [hz, gcp] },
      []
    );
    const stale = await resolveSourceSettingsUpdate(
      d1 as never,
      pool,
      { ...SCOPE, sourceOrder: [gcp, hz] },
      []
    );

    expect(await publishSourceSettingsOnly(d1 as never, pool, first)).toBe(true);
    expect(await publishSourceSettingsOnly(d1 as never, pool, stale)).toBe(false);
    expect(sourceOrderColumn()).toBe(JSON.stringify([hz, gcp]));
  });

  it('conflicts through updateDefaultCapacityPool when a writer lands between its read and its write', async () => {
    const { raw, hz, gcp } = await setup();
    const racing = withInterleavedWrite(raw, () =>
      sqlite!
        .prepare('UPDATE capacity_pools SET excluded_source_ids_json = ?')
        .run(JSON.stringify([gcp]))
    );

    const result = await updateDefaultCapacityPool(drizzle(racing.database, { schema }) as never, {
      ...SCOPE,
      excludedSourceIds: [hz],
    });

    expect(racing.fired()).toBe(true);
    expect(result.conflict).toBe(true);
    // The first writer's value survives; the losing edit changed nothing.
    expect(excludedColumn()).toBe(JSON.stringify([gcp]));
  });

  it('conflicts through updateDefaultCapacityPool on an interleaved sourceOrder write', async () => {
    const { raw, hz, gcp } = await setup();
    const racing = withInterleavedWrite(raw, () =>
      sqlite!
        .prepare('UPDATE capacity_pools SET source_order_json = ?')
        .run(JSON.stringify([gcp, hz]))
    );

    const result = await updateDefaultCapacityPool(drizzle(racing.database, { schema }) as never, {
      ...SCOPE,
      sourceOrder: [hz, gcp],
    });

    expect(result.conflict).toBe(true);
    expect(sourceOrderColumn()).toBe(JSON.stringify([gcp, hz]));
  });

  describe('activation race', () => {
    /** Account X (hetzner) is on with one active pick; its second machine is not picked yet. */
    async function activationSetup() {
      const f = await setup();
      const fsn = sqlite!
        .prepare(
          "SELECT id FROM capacity_pool_candidates WHERE workload_role = 'workspace' AND location = 'fsn1'"
        )
        .get() as { id: string };
      const nbg = sqlite!
        .prepare(
          "SELECT id FROM capacity_pool_candidates WHERE workload_role = 'workspace' AND location = 'nbg1'"
        )
        .get() as { id: string };
      const first = await updateDefaultCapacityPool(f.d1 as never, {
        ...SCOPE,
        candidates: [{ id: fsn.id, status: 'active' }],
      });
      expect(first.conflict).toBe(false);
      return { ...f, nbgId: nbg.id };
    }

    it('activates the machine when nobody switched the account off in between (control)', async () => {
      const { d1, nbgId } = await activationSetup();
      const revisionBefore = (
        sqlite!.prepare('SELECT revision AS r FROM capacity_pools').get() as { r: number }
      ).r;

      const result = await updateDefaultCapacityPool(d1 as never, {
        ...SCOPE,
        candidates: [{ id: nbgId, status: 'active' }],
      });

      expect(result.conflict).toBe(false);
      expect(workspaceStatus("location = 'nbg1'")).toBe('active');
      expect(excludedColumn()).toBeNull();
      expect(
        (sqlite!.prepare('SELECT revision AS r FROM capacity_pools').get() as { r: number }).r
      ).toBeGreaterThan(revisionBefore);
    });

    it('conflicts when a settings-only edit switches the account off before the activation publishes', async () => {
      const { raw, hz, nbgId } = await activationSetup();
      const revisionBefore = (
        sqlite!.prepare('SELECT revision AS r FROM capacity_pools').get() as { r: number }
      ).r;
      // The competing edit is exactly what the settings-only path stores: the switch, no revision bump.
      const racing = withInterleavedWrite(raw, () =>
        sqlite!
          .prepare('UPDATE capacity_pools SET excluded_source_ids_json = ?')
          .run(JSON.stringify([hz]))
      );

      const result = await updateDefaultCapacityPool(
        drizzle(racing.database, { schema }) as never,
        {
          ...SCOPE,
          candidates: [{ id: nbgId, status: 'active' }],
        }
      );

      expect(racing.fired()).toBe(true);
      expect(result.conflict).toBe(true);
      // The account stays off, the machine was NOT activated, and the revision did not move.
      expect(excludedColumn()).toBe(JSON.stringify([hz]));
      expect(workspaceStatus("location = 'nbg1'")).toBe('disabled');
      expect(
        (sqlite!.prepare('SELECT revision AS r FROM capacity_pools').get() as { r: number }).r
      ).toBe(revisionBefore);
    });
  });
});

describe('an edit that activates many machines stays inside the 100-bind ceiling', () => {
  // One hetzner account with 60 machine types: more than the 46 ids one statement can carry once
  // its fixed binds and both settings guards are counted ((100 - 8) / 2 = 46). Before the guard
  // budget was reserved, a 47-id chunk plus a guard was 101 binds.
  const TYPES = 60;
  const OFFERINGS: OfferingsByProvider = {
    hetzner: Array.from({ length: TYPES }, (_, index) =>
      offering('hetzner', 'fsn1', `cx${index}`, { currency: 'EUR' })
    ),
    gcp: [offering('gcp', 'europe-west1-b', 'e2-standard-4')],
  };

  async function setup() {
    const f = fixture(OFFERINGS, ['hetzner', 'gcp']);
    await refresh(f.d1, OFFERINGS);
    const hetznerIds = (
      sqlite!
        .prepare(
          "SELECT id FROM capacity_pool_candidates WHERE workload_role = 'workspace' AND provider = 'hetzner'"
        )
        .all() as Array<{ id: string }>
    ).map((row) => row.id);
    expect(hetznerIds).toHaveLength(TYPES);
    return { ...f, hetznerIds, hz: sourceIdByProvider('hetzner'), gcp: sourceIdByProvider('gcp') };
  }

  it.each([
    ['excludedSourceIds', (ids: { hz: string; gcp: string }) => ({ excludedSourceIds: [ids.gcp] })],
    ['sourceOrder', (ids: { hz: string; gcp: string }) => ({ sourceOrder: [ids.gcp, ids.hz] })],
    [
      'both settings',
      (ids: { hz: string; gcp: string }) => ({
        excludedSourceIds: [ids.gcp],
        sourceOrder: [ids.gcp, ids.hz],
      }),
    ],
    ['neither (the activation still fences on the switched-off column)', () => ({})],
  ])('activates 60 machines together with %s', async (_label, settings) => {
    const { d1, hetznerIds, hz, gcp } = await setup();

    const result = await updateDefaultCapacityPool(d1 as never, {
      ...SCOPE,
      candidates: hetznerIds.map((id) => ({ id, status: 'active' as const })),
      ...settings({ hz, gcp }),
    });

    expect(result).toMatchObject({ conflict: false, missingSourceIds: [] });
    expect(
      (
        sqlite!
          .prepare(
            "SELECT COUNT(*) AS n FROM capacity_pool_candidates WHERE provider = 'hetzner' AND status = 'active'"
          )
          .get() as { n: number }
      ).n
    ).toBe(TYPES * 2); // each machine and its coupled deployment-role mirror
    const wantsExclusion = 'excludedSourceIds' in settings({ hz, gcp });
    expect(excludedColumn()).toBe(wantsExclusion ? JSON.stringify([gcp]) : null);
    const wantsOrder = 'sourceOrder' in settings({ hz, gcp });
    expect(sourceOrderColumn()).toBe(wantsOrder ? JSON.stringify([gcp, hz]) : null);
  });

  it('sizes the test past the per-statement chunk', () => {
    // 46 = floor((100 - 6 fixed binds - 2 settings guards) / 2); TYPES must exceed it.
    expect(TYPES).toBeGreaterThan(46);
    expect(TYPES).toBeLessThanOrEqual(MAX_CAPACITY_POOL_SOURCE_ORDER_LENGTH * 2);
  });
});

describe('excluded_source_ids_json CHECK and its readers', () => {
  function poolsTable() {
    sqlite = new Database(':memory:');
    sqlite.exec('CREATE TABLE capacity_pools (id TEXT PRIMARY KEY)');
    sqlite.exec(capacityPoolExcludedSourcesMigrationSql);
    sqlite.exec("INSERT INTO capacity_pools (id) VALUES ('pool-1')");
    return sqlite;
  }
  const write = (db: Database.Database, value: string | null) =>
    db
      .prepare('UPDATE capacity_pools SET excluded_source_ids_json = ? WHERE id = ?')
      .run(value, 'pool-1');

  it.each([['not-json'], ['{}'], ['"x"'], ['1'], ['null'], ['']])(
    'rejects %j, which is not a JSON array',
    (value) => {
      const db = poolsTable();
      expect(() => write(db, value)).toThrow(/CHECK constraint failed/);
      expect(db.prepare('SELECT excluded_source_ids_json AS v FROM capacity_pools').get()).toEqual({
        v: null,
      });
    }
  );

  it.each([['[]'], ['["a"]'], ['["a","b"]'], [null]])('accepts %j', (value) => {
    const db = poolsTable();
    write(db, value);
    expect(db.prepare('SELECT excluded_source_ids_json AS v FROM capacity_pools').get()).toEqual({
      v: value,
    });
  });

  it('reads ["a", 1, ""] as exactly the ids the placement json_each match would exclude', () => {
    const db = poolsTable();
    const raw = '["a", 1, ""]';
    write(db, raw); // the CHECK admits any array, so the reader must tolerate the entries

    const parsed = parseCapacityPoolExcludedSources('pool-1', raw);
    expect(parsed).toEqual(['a']);

    // The placement predicate (placement-authority.ts) compares json_each.value with the source
    // id as text. Real source ids are non-empty strings; run the same comparison on a few.
    db.exec('CREATE TABLE sources (id TEXT PRIMARY KEY)');
    for (const id of ['a', '1', 'b']) db.prepare('INSERT INTO sources (id) VALUES (?)').run(id);
    const excludedBySql = (
      db
        .prepare(
          `SELECT s.id FROM sources s, capacity_pools p
           WHERE EXISTS (SELECT 1 FROM json_each(COALESCE(p.excluded_source_ids_json, '[]')) AS excluded
                         WHERE excluded.value = s.id)
           ORDER BY s.id`
        )
        .all() as Array<{ id: string }>
    ).map((row) => row.id);
    expect(excludedBySql).toEqual(parsed);
  });
});
