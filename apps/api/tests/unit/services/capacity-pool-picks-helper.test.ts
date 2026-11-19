/**
 * `pickStarterMachines` is fixture plumbing, and a pick that finds nothing used to be silent: the
 * test then ran against an empty pool and could pass for the wrong reason. It throws now, unless
 * the caller opts out.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import { offering } from '../../helpers/capacity-pool-offerings';
import { pickStarterMachines } from '../../helpers/capacity-pool-picks';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
import { seedCloudCredential, seedUser } from '../routes/capacity-pool-test-seeds';

let sqlite: Database.Database | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

async function userPool(offerings: ReturnType<typeof offering>[]) {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  seedUser(sqlite, 'user-1');
  seedCloudCredential(sqlite, { id: 'cred-1', userId: 'user-1', provider: 'gcp' });
  const d1 = drizzle(createSqliteD1(sqlite), { schema });
  await ensureDefaultCapacityPoolsForExistingCredentials(d1 as never, {
    userId: 'user-1',
    includeInstallation: false,
    offeringResolver: async () => offerings,
    env: {} as Env,
  });
  return d1;
}

const activeCount = () =>
  (
    sqlite!
      .prepare("SELECT COUNT(*) AS n FROM capacity_pool_candidates WHERE status = 'active'")
      .get() as {
      n: number;
    }
  ).n;

describe('pickStarterMachines', () => {
  it('picks the machines a legacy size maps to (control)', async () => {
    const d1 = await userPool([
      offering('gcp', 'europe-west1-b', 'e2-standard-4', { machineSize: 'medium' }),
    ]);
    await expect(pickStarterMachines(d1 as never)).resolves.toBeUndefined();
    expect(activeCount()).toBeGreaterThan(0);
  });

  it('throws when no pool has anything to pick', async () => {
    // No legacy size maps to this machine, so there is nothing a starter pick can choose.
    const d1 = await userPool([offering('gcp', 'europe-west1-b', 'custom-type')]);
    await expect(pickStarterMachines(d1 as never)).rejects.toThrow(/found no machines to pick/);
    expect(activeCount()).toBe(0);
  });

  it('throws when there is no pool at all', async () => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    const d1 = drizzle(createSqliteD1(sqlite), { schema });
    await expect(pickStarterMachines(d1 as never)).rejects.toThrow(/found no machines to pick/);
  });

  it('throws for a requested scope that picked nothing, even when another scope could pick', async () => {
    const d1 = await userPool([
      offering('gcp', 'europe-west1-b', 'e2-standard-4', { machineSize: 'medium' }),
    ]);
    await expect(pickStarterMachines(d1 as never, { scopes: ['user', 'project'] })).rejects.toThrow(
      /in the project default pool/
    );
  });

  it('lets a caller opt out explicitly', async () => {
    const d1 = await userPool([offering('gcp', 'europe-west1-b', 'custom-type')]);
    await expect(
      pickStarterMachines(d1 as never, { allowNothingToPick: true })
    ).resolves.toBeUndefined();
    expect(activeCount()).toBe(0);
  });
});
