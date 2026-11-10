/**
 * A pool edit must cost what it changes, not the square of the pool.
 *
 * On 2026-11-10 two saves of a ~3,900-row production pool reset D1 ("exceeded its CPU time
 * limit") and overloaded the database for every other request for about a minute each. The
 * atomic edit matched each row's deployment mirror through a subquery correlated on the source,
 * so SQLite scanned every row of the source for every row of the pool. These tests run the real
 * edit on a real SQLite engine with production's declared indexes, at production's pool shape,
 * and check both the result and the plan of every UPDATE it issues.
 */
import type { ProviderInstanceOffering } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { updateDefaultCapacityPool } from '../../../src/services/default-capacity-pool-updates';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import { offering } from '../../helpers/capacity-pool-offerings';
import {
  createAllSchemaTables,
  createDeclaredIndexes,
  createSqliteD1WithBindLimit,
} from '../../helpers/sqlite-d1';
import { seedCloudCredential, seedUser } from '../routes/capacity-pool-test-seeds';

const POOL_ID = 'cap-pool-default:user:user-1';
const MIRROR_SUFFIX = '#role=deployment';
/** Zones x machine types: 2,100 editor rows plus their 2,100 deployment mirrors. */
const ZONES = ['us-central1-a', 'us-east1-b', 'europe-west1-b'];
const MACHINE_TYPES = 700;
/** Rows one save changes: several bind-limited statements, as a bulk add in the editor makes. */
const EDITED_ROWS = 400;

let sqlite: Database.Database | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

function setup() {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  createDeclaredIndexes(
    sqlite,
    Object.values(schema).filter((value): value is SQLiteTable => is(value, SQLiteTable))
  );
  seedUser(sqlite, 'user-1');
  seedCloudCredential(sqlite, { id: 'gcp-1', userId: 'user-1', provider: 'gcp' });
  const statements: string[] = [];
  const base = createSqliteD1WithBindLimit(sqlite, 100);
  // Records every statement the service prepares, so the test can read each one's plan.
  const d1 = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (query: string) => {
          statements.push(query);
          return target.prepare(query);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: drizzle(d1, { schema }), statements };
}

function largeCatalog(): ProviderInstanceOffering[] {
  return ZONES.flatMap((zone) =>
    Array.from({ length: MACHINE_TYPES }, (_, index) =>
      offering('gcp', zone, `n2-test-${String(index).padStart(4, '0')}`)
    )
  );
}

function rows(where: string, ...params: unknown[]) {
  return sqlite!
    .prepare(`SELECT id, status FROM capacity_pool_candidates WHERE ${where}`)
    .all(...params) as { id: string; status: string }[];
}

function planOf(query: string): string[] {
  const placeholders = (query.match(/\?/g) ?? []).length;
  return (
    sqlite!
      .prepare(`EXPLAIN QUERY PLAN ${query}`)
      .all(...Array.from({ length: placeholders }, () => null)) as { detail: string }[]
  ).map((row) => row.detail);
}

describe('pool edit on a large pool', () => {
  it('updates the edited rows and their mirrors, looking every row up by id', async () => {
    const { db, statements } = setup();
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      candidatePublishBatchSize: 10_000,
      offeringResolver: async () => largeCatalog(),
    });
    const editorRows = rows(`pool_id = ? AND workload_role = 'workspace'`, POOL_ID);
    expect(editorRows).toHaveLength(ZONES.length * MACHINE_TYPES);
    expect(rows(`pool_id = ? AND workload_role = 'deployment'`, POOL_ID)).toHaveLength(
      ZONES.length * MACHINE_TYPES
    );
    expect(editorRows.every((row) => row.status === 'disabled')).toBe(true);

    const edited = editorRows.slice(0, EDITED_ROWS).map((row) => row.id);
    statements.length = 0;
    const result = await updateDefaultCapacityPool(db as never, {
      scope: 'user',
      ownerUserId: 'user-1',
      ownerProjectId: null,
      candidates: edited.map((id) => ({ id, status: 'active' as const })),
    });
    expect(result.conflict).toBe(false);

    // Exactly the edited rows and their mirrors changed.
    const active = rows(`pool_id = ? AND status = 'active'`, POOL_ID).map((row) => row.id);
    expect(new Set(active)).toEqual(
      new Set([...edited, ...edited.map((id) => `${id}${MIRROR_SUFFIX}`)])
    );

    // Every UPDATE of candidate rows finds both the row and its mirror's primary by id. None
    // walks the pool or the source to correlate them.
    const updates = statements.filter((query) =>
      /^update\s+"capacity_pool_candidates"/i.test(query.trim())
    );
    expect(updates.length).toBeGreaterThan(1);
    for (const query of updates) {
      const plan = planOf(query);
      const primaryMember = plan.filter((detail) => detail.includes('primary_member'));
      expect(primaryMember.length, plan.join('\n')).toBeGreaterThan(0);
      for (const detail of primaryMember) expect(detail, plan.join('\n')).toMatch(/\(id=\?\)/);
      expect(
        plan.some((detail) => /^SCAN capacity_pool_candidates/.test(detail)),
        plan.join('\n')
      ).toBe(false);
    }
  });

  it('still refuses to couple a same-suffix row whose native identity differs', async () => {
    const { db } = setup();
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      candidatePublishBatchSize: 10_000,
      offeringResolver: async () => largeCatalog().slice(0, 3),
    });
    const [target] = rows(`pool_id = ? AND workload_role = 'workspace'`, POOL_ID);
    // A mirror-shaped id whose offering does not match its primary must stay untouched.
    sqlite!
      .prepare(
        `UPDATE capacity_pool_candidates SET provider_instance_type = 'someone-else' WHERE id = ?`
      )
      .run(`${target!.id}${MIRROR_SUFFIX}`);

    const result = await updateDefaultCapacityPool(db as never, {
      scope: 'user',
      ownerUserId: 'user-1',
      ownerProjectId: null,
      candidates: [{ id: target!.id, status: 'active' }],
    });

    expect(result.conflict).toBe(false);
    expect(rows('id = ?', target!.id)[0]?.status).toBe('active');
    expect(rows('id = ?', `${target!.id}${MIRROR_SUFFIX}`)[0]?.status).toBe('disabled');
  });
});
