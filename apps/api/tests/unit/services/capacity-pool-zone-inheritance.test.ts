/**
 * Which status a never-seen pool row starts with, through the real catalog publication path on a
 * real SQLite engine (rule 28, rule 62):
 *
 * - nothing joins a pool on its own, except a new zone of a region the person already picked for
 *   the SAME account and machine type (`initialStatusForProviderOffering`, `pickedRegionKeys`);
 * - a coupled-role (deployment) row mirrors its workspace row;
 * - a row a person removed is never revived by a refresh, whatever else is in the pool.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { initialStatusForProviderOffering } from '../../../src/services/default-capacity-pool-candidates-values';
import { updateDefaultCapacityPool } from '../../../src/services/default-capacity-pool-updates';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import { offering } from '../../helpers/capacity-pool-offerings';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';
import { seedCloudCredential, seedUser } from '../routes/capacity-pool-test-seeds';

let sqlite: Database.Database | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

const SCOPE = { scope: 'user', ownerUserId: 'user-1', ownerProjectId: null } as const;

function fixture(credentials: Array<{ id: string; provider: string }>) {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  seedUser(sqlite, 'user-1');
  for (const credential of credentials) {
    seedCloudCredential(sqlite, { ...credential, userId: 'user-1' });
  }
  return drizzle(createSqliteD1WithBindLimit(sqlite, 100), { schema });
}

type Db = ReturnType<typeof fixture>;
type Offering = ReturnType<typeof offering>;

function refresh(d1: Db, offerings: Offering[]) {
  return ensureDefaultCapacityPoolsForExistingCredentials(d1 as never, {
    userId: 'user-1',
    includeInstallation: false,
    candidatePublishBatchSize: 1000,
    offeringResolver: async () => offerings,
  });
}

interface Row {
  id: string;
  sourceId: string;
  role: string;
  location: string;
  type: string;
  sku: string | null;
  status: string;
}

function rows(): Row[] {
  return sqlite!
    .prepare(
      `SELECT id, capacity_source_id AS sourceId, workload_role AS role, location,
              provider_instance_type AS type, provider_instance_sku AS sku, status
       FROM capacity_pool_candidates WHERE provider_instance_type IS NOT NULL
       ORDER BY capacity_source_id, location, provider_instance_type, workload_role`
    )
    .all() as Row[];
}

const sourceIds = () =>
  (
    sqlite!.prepare('SELECT id FROM capacity_sources ORDER BY credential_id').all() as Array<{
      id: string;
    }>
  ).map((row) => row.id);

function workspaceRow(sourceId: string, location: string, type: string, sku: string | null = null) {
  const row = rows().find(
    (r) =>
      r.role === 'workspace' &&
      r.sourceId === sourceId &&
      r.location === location &&
      r.type === type &&
      r.sku === sku
  );
  if (!row) throw new Error(`no workspace row for ${sourceId} ${location} ${type} ${sku}`);
  return row;
}

async function setStatus(d1: Db, ids: string[], status: 'active' | 'disabled' | 'deleted') {
  const result = await updateDefaultCapacityPool(d1 as never, {
    ...SCOPE,
    candidates: ids.map((id) => ({ id, status })),
  });
  expect(result.conflict).toBe(false);
  expect(result.missingCandidateIds).toEqual([]);
}

describe('initialStatusForProviderOffering', () => {
  it.each([
    // An existing concrete status always wins, picked region or not.
    ['deleted', true, 'deleted'],
    ['deleted', false, 'deleted'],
    ['disabled', true, 'disabled'],
    ['disabled', false, 'disabled'],
    ['active', true, 'active'],
    ['active', false, 'active'],
    // A never-seen row: a picked region activates it, anything else leaves it unselected.
    [null, true, 'active'],
    [undefined, true, 'active'],
    [null, false, 'disabled'],
    [undefined, false, 'disabled'],
    // A value that is not a canonical status is "never seen", not a status.
    ['', true, 'active'],
    ['bogus', false, 'disabled'],
  ] as const)('maps existing %j, picked region %j to %s', (existing, pickedRegion, expected) => {
    expect(initialStatusForProviderOffering(existing, pickedRegion)).toBe(expected);
  });
});

describe('zone inheritance across accounts and machine variants', () => {
  it('lets a new zone join only the account that picked its region', async () => {
    const d1 = fixture([
      { id: 'gcp-1', provider: 'gcp' },
      { id: 'gcp-2', provider: 'gcp' },
    ]);
    const initial = [offering('gcp', 'europe-west1-b', 'e2-standard-4')];
    await refresh(d1, initial);
    const [one, two] = sourceIds();
    // Account 1 picks europe-west1; account 2 has the same machine listed and not picked.
    await setStatus(d1, [workspaceRow(one!, 'europe-west1-b', 'e2-standard-4').id], 'active');

    await refresh(d1, [...initial, offering('gcp', 'europe-west1-c', 'e2-standard-4')]);

    expect(workspaceRow(one!, 'europe-west1-c', 'e2-standard-4').status).toBe('active');
    expect(workspaceRow(two!, 'europe-west1-c', 'e2-standard-4').status).toBe('disabled');
    // Liveness: account 2's existing row was neither activated nor lost.
    expect(workspaceRow(two!, 'europe-west1-b', 'e2-standard-4').status).toBe('disabled');
    expect(workspaceRow(one!, 'europe-west1-b', 'e2-standard-4').status).toBe('active');
  });

  it('still lets a third zone join a region that has one active and one deleted zone', async () => {
    const d1 = fixture([{ id: 'gcp-1', provider: 'gcp' }]);
    const zones = ['europe-west1-b', 'europe-west1-c'].map((zone) =>
      offering('gcp', zone, 'e2-standard-4')
    );
    await refresh(d1, zones);
    const [source] = sourceIds();
    await setStatus(d1, [workspaceRow(source!, 'europe-west1-b', 'e2-standard-4').id], 'active');
    await setStatus(d1, [workspaceRow(source!, 'europe-west1-c', 'e2-standard-4').id], 'deleted');

    await refresh(d1, [...zones, offering('gcp', 'europe-west1-d', 'e2-standard-4')]);

    expect(workspaceRow(source!, 'europe-west1-d', 'e2-standard-4').status).toBe('active');
    // The zone the person removed stays removed.
    expect(workspaceRow(source!, 'europe-west1-c', 'e2-standard-4').status).toBe('deleted');
  });

  it('does not let a new zone join once every picked zone of the region is gone (control)', async () => {
    const d1 = fixture([{ id: 'gcp-1', provider: 'gcp' }]);
    const zones = ['europe-west1-b', 'europe-west1-c'].map((zone) =>
      offering('gcp', zone, 'e2-standard-4')
    );
    await refresh(d1, zones);
    const [source] = sourceIds();
    await setStatus(d1, [workspaceRow(source!, 'europe-west1-b', 'e2-standard-4').id], 'active');
    await setStatus(d1, [workspaceRow(source!, 'europe-west1-b', 'e2-standard-4').id], 'deleted');

    await refresh(d1, [...zones, offering('gcp', 'europe-west1-d', 'e2-standard-4')]);

    expect(workspaceRow(source!, 'europe-west1-d', 'e2-standard-4').status).toBe('disabled');
  });

  it('gives the coupled deployment row of a new zone the status of its workspace row', async () => {
    const d1 = fixture([{ id: 'gcp-1', provider: 'gcp' }]);
    const initial = [
      offering('gcp', 'europe-west1-b', 'e2-standard-4'),
      offering('gcp', 'us-central1-a', 'e2-standard-4'),
    ];
    await refresh(d1, initial);
    const [source] = sourceIds();
    await setStatus(d1, [workspaceRow(source!, 'europe-west1-b', 'e2-standard-4').id], 'active');

    await refresh(d1, [
      ...initial,
      offering('gcp', 'europe-west1-c', 'e2-standard-4'), // zone of the picked region
      offering('gcp', 'us-central1-b', 'e2-standard-4'), // zone of an unpicked region
    ]);

    const roleStatus = (location: string) =>
      rows()
        .filter((r) => r.location === location)
        .map((r) => `${r.role}:${r.status}`)
        .sort();
    expect(roleStatus('europe-west1-c')).toEqual(['deployment:active', 'workspace:active']);
    expect(roleStatus('us-central1-b')).toEqual(['deployment:disabled', 'workspace:disabled']);
  });

  it('does not let a SKU variant inherit the pick of the plain machine type', async () => {
    const d1 = fixture([{ id: 'gcp-1', provider: 'gcp' }]);
    const plain = offering('gcp', 'europe-west1-b', 'e2-standard-4');
    await refresh(d1, [plain]);
    const [source] = sourceIds();
    await setStatus(d1, [workspaceRow(source!, 'europe-west1-b', 'e2-standard-4').id], 'active');

    await refresh(d1, [
      plain,
      offering('gcp', 'europe-west1-b', 'e2-standard-4', { providerInstanceSku: 'spot' }),
      offering('gcp', 'europe-west1-c', 'e2-standard-4', { providerInstanceSku: 'spot' }),
      // Control: the same plain machine type in a new zone does inherit.
      offering('gcp', 'europe-west1-c', 'e2-standard-4'),
    ]);

    expect(workspaceRow(source!, 'europe-west1-b', 'e2-standard-4', 'spot').status).toBe(
      'disabled'
    );
    expect(workspaceRow(source!, 'europe-west1-c', 'e2-standard-4', 'spot').status).toBe(
      'disabled'
    );
    expect(workspaceRow(source!, 'europe-west1-c', 'e2-standard-4').status).toBe('active');
  });
});

describe('a removed native row is never revived by a refresh', () => {
  /** A pre-redesign row: no native machine type, only a legacy size, and switched on. */
  function insertActiveLegacyRow(template: Row) {
    const columns = (
      sqlite!.prepare('PRAGMA table_info(capacity_pool_candidates)').all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    const source = sqlite!
      .prepare('SELECT * FROM capacity_pool_candidates WHERE id = ?')
      .get(template.id) as Record<string, unknown>;
    const legacy: Record<string, unknown> = {
      ...source,
      id: 'legacy-medium-row',
      machine_size: 'medium',
      provider_instance_type: null,
      provider_instance_sku: null,
      provider_instance_catalog_source: null,
      status: 'active',
    };
    sqlite!
      .prepare(
        `INSERT INTO capacity_pool_candidates (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      )
      .run(...columns.map((column) => legacy[column] as never));
  }

  it('keeps a deleted native row deleted while a legacy row of the same size is active', async () => {
    const d1 = fixture([{ id: 'gcp-1', provider: 'gcp' }]);
    const catalog = [offering('gcp', 'europe-west1-b', 'e2-standard-4', { machineSize: 'medium' })];
    await refresh(d1, catalog);
    const [source] = sourceIds();
    const native = workspaceRow(source!, 'europe-west1-b', 'e2-standard-4');
    await setStatus(d1, [native.id], 'active');
    await setStatus(d1, [native.id], 'deleted');
    insertActiveLegacyRow(native);
    expect(
      sqlite!
        .prepare("SELECT status FROM capacity_pool_candidates WHERE id = 'legacy-medium-row'")
        .get()
    ).toEqual({ status: 'active' });

    await refresh(d1, catalog);
    await refresh(d1, catalog);

    expect(workspaceRow(source!, 'europe-west1-b', 'e2-standard-4').status).toBe('deleted');
    // The legacy row is a different row: it is left exactly as it was.
    expect(
      sqlite!
        .prepare("SELECT status FROM capacity_pool_candidates WHERE id = 'legacy-medium-row'")
        .get()
    ).toEqual({ status: 'active' });
  });

  it('does not let an active legacy row of the same size activate a brand new native row', async () => {
    const d1 = fixture([{ id: 'gcp-1', provider: 'gcp' }]);
    const first = offering('gcp', 'europe-west1-b', 'e2-standard-4', { machineSize: 'medium' });
    await refresh(d1, [first]);
    const [source] = sourceIds();
    insertActiveLegacyRow(workspaceRow(source!, 'europe-west1-b', 'e2-standard-4'));

    await refresh(d1, [
      first,
      offering('gcp', 'us-central1-a', 'e2-standard-4', { machineSize: 'medium' }),
    ]);

    expect(workspaceRow(source!, 'us-central1-a', 'e2-standard-4').status).toBe('disabled');
  });
});
