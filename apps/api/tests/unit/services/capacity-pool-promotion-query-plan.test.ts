/**
 * Real publication SQL, real declared indexes, and the outer 3,600-offering / 7,200-row
 * catalog. better-sqlite3 enforces SQL semantics and our adapter enforces D1's 100 binds;
 * it does NOT enforce D1 CPU, writer latency, memory or subrequest limits. Final-head
 * staging must measure the real GCP promotion batch separately.
 */
import type { ProviderInstanceOffering } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { ensureCandidatesForSource } from '../../../src/services/default-capacity-pool-candidates';
import { offering } from '../../helpers/capacity-pool-offerings';
import {
  createDeclaredIndexes,
  createSchemaTables,
  createSqliteD1WithBindLimit,
} from '../../helpers/sqlite-d1';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

interface IssuedQuery {
  sql: string;
  changes?: number;
}

function fixture() {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  const tables = [
    schema.capacitySources,
    schema.capacityPools,
    schema.capacityPoolCandidates,
    schema.capacityPoolCandidateStaging,
  ];
  createSchemaTables(sqlite, tables);
  createDeclaredIndexes(sqlite, tables);
  sqlite.exec(`
    INSERT INTO capacity_pools (id, scope, owner_user_id, is_default, status, revision,
      updated_at, configuration_state, migration_state)
      VALUES ('pool', 'user', 'owner', 1, 'active', 1, 'start', 'configured-ready', 'complete');
    INSERT INTO capacity_sources (id, scope, owner_user_id, source_kind, provider, status,
      source_generation, authority_generation)
      VALUES ('source', 'user', 'owner', 'cloud-provider-credential', 'gcp', 'active', 1, 1);
  `);
  const statements: IssuedQuery[] = [];
  const promotionDurations: number[] = [];
  const database = createSqliteD1WithBindLimit(sqlite, 100);
  const records = new WeakMap<object, IssuedQuery>();
  const d1 = new Proxy(database, {
    get(target, key, receiver) {
      if (key === 'prepare')
        return (query: string) => {
          const record: IssuedQuery = { sql: query };
          statements.push(record);
          const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
            const wrapped = new Proxy(statement, {
              get(item, prop) {
                if (prop === 'bind') return (...params: unknown[]) => wrap(item.bind(...params));
                const value = Reflect.get(item, prop);
                return typeof value === 'function' ? value.bind(item) : value;
              },
            });
            records.set(wrapped, record);
            return wrapped;
          };
          return wrap(target.prepare(query));
        };
      if (key === 'batch')
        return async (queries: D1PreparedStatement[]) => {
          const started = performance.now();
          const results = await target.batch(queries);
          for (const [index, result] of results.entries()) {
            const record = records.get(queries[index]!);
            if (record) record.changes = result.meta.changes;
          }
          if (/^UPDATE capacity_pools SET revision/.test(records.get(queries[0]!)?.sql ?? ''))
            promotionDurations.push(performance.now() - started);
          return results;
        };
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const values = new Map<string, string>();
  const cursorStore = {
    read: async (key: string) => values.get(key) ?? null,
    write: async (key: string, value: string | null) => {
      if (value === null) values.delete(key);
      else values.set(key, value);
    },
  };
  const db = drizzle(d1, { schema });
  const publish = (catalog: ProviderInstanceOffering[], options = {}) =>
    ensureCandidatesForSource(db, 'pool', 'source', 'gcp', catalog, {
      sourceGeneration: 1,
      sourceAuthorityGeneration: 1,
      cursorStore,
      publishDeadlineAt: Number.POSITIVE_INFINITY,
      ...options,
    });
  return { sqlite, statements, promotionDurations, publish };
}

function catalog(size: number, offset = 0): ProviderInstanceOffering[] {
  return Array.from({ length: size }, (_, index) =>
    offering('gcp', 'us-central1-a', `n2-test-${String(index + offset).padStart(4, '0')}`)
  );
}

function queryPlan(sqlite: Database.Database, sql: string): string[] {
  return (
    sqlite
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => null)) as {
      detail: string;
    }[]
  ).map((row) => row.detail);
}

describe('catalog promotion at the outer materialized row count', () => {
  it('publishes 7,200 rows with indexed staging ranges and primary-key correlated lookups', async () => {
    const { sqlite, statements, promotionDurations, publish } = fixture();
    expect((await publish(catalog(3_600))).publicationComplete).toBe(true);
    expect(sqlite.prepare('SELECT count(*) n FROM capacity_pool_candidates').get()).toEqual({
      n: 7_200,
    });
    statements.length = 0;
    expect((await publish(catalog(3_600, 1))).publicationComplete).toBe(true);
    expect(
      sqlite
        .prepare(
          "SELECT count(*) n FROM capacity_pool_candidates WHERE catalog_availability='available'"
        )
        .get()
    ).toEqual({ n: 7_200 });
    expect(
      sqlite
        .prepare(
          "SELECT count(*) n FROM capacity_pool_candidates WHERE catalog_availability='last-known-unavailable'"
        )
        .get()
    ).toEqual({ n: 2 });
    const promotion = statements.filter(({ sql }) =>
      /^UPDATE capacity_pools SET revision|^INSERT INTO capacity_pool_candidates|^UPDATE capacity_pool_candidates|^DELETE FROM capacity_pool_candidate_staging/.test(
        sql
      )
    );
    expect(promotion).toHaveLength(5);
    const plans = promotion.map(({ sql }) => queryPlan(sqlite, sql));
    process.stdout.write(
      JSON.stringify({
        kind: 'sqlite-promotion-benchmark',
        materializedRows: 7_200,
        promotionBatchMs: promotionDurations,
        queryPlans: plans,
        sql: promotion.map(({ sql }) => sql),
      }) + '\n'
    );
    for (const [index, plan] of plans.entries()) {
      expect(
        plan.some((detail) =>
          /^SCAN (?:capacity_pool_candidates|capacity_pool_candidate_staging|staged|live)\b/.test(
            detail
          )
        ),
        plan.join('\n')
      ).toBe(false);
      const liveLookups = plan.filter((detail) => /^SEARCH live\b/.test(detail));
      expect(liveLookups.length, plan.join('\n')).toBeGreaterThan(0);
      for (const detail of liveLookups) expect(detail, plan.join('\n')).toMatch(/\(id=\?\)/);
      if (promotion[index]!.sql.startsWith('INSERT INTO capacity_pool_candidates')) {
        const membership = plan.filter((detail) =>
          /^SEARCH capacity_pool_candidates\b/.test(detail)
        );
        expect(membership.length, plan.join('\n')).toBeGreaterThan(0);
        for (const detail of membership) expect(detail, plan.join('\n')).toMatch(/\(id=\?\)/);
      }
    }
    // Candidate fields are bound directly; the atomic writer never decodes JSON
    // once for every projected field and guard.
    expect(promotion.some(({ sql }) => /json_extract/i.test(sql))).toBe(false);
    expect(sqlite.prepare('SELECT count(*) n FROM capacity_pool_candidate_staging').get()).toEqual({
      n: 0,
    });
  }, 30_000);

  it('does not rewrite already unavailable offerings on a later changed publication', async () => {
    const { sqlite, publish } = fixture();
    await publish(catalog(2));
    await publish(catalog(1));
    const absent = () =>
      sqlite
        .prepare(
          "SELECT id, catalog_unavailable_at, updated_at FROM capacity_pool_candidates WHERE catalog_availability='last-known-unavailable' ORDER BY id"
        )
        .all();
    const before = absent();
    expect(before).toHaveLength(2);
    await publish(catalog(1).map((row) => ({ ...row, memoryMb: 32_768 })));
    expect(absent()).toEqual(before);
  });

  it('refreshes unchanged validated non-exhaustive catalogs without staging or promoting them again', async () => {
    const { sqlite, statements, publish } = fixture();
    const references = catalog(2).map((row) => ({ ...row, catalogSource: 'static' as const }));
    const options = {
      catalogComplete: false,
      catalogValidated: true,
      publishBatchSize: 2,
      publishDeadlineAt: 0,
    };
    expect((await publish(references, options)).publicationComplete).toBe(false);
    expect((await publish(references, options)).publicationComplete).toBe(true);
    statements.length = 0;
    expect(await publish(references, options)).toMatchObject({
      publicationComplete: true,
      publishedCandidates: 0,
      markedMissing: false,
    });
    expect(
      statements.filter(({ sql }) =>
        /^(?:UPDATE capacity_pools SET revision|INSERT INTO capacity_pool_candidate_staging)/.test(
          sql
        )
      )
    ).toEqual([]);
    expect(sqlite.prepare('SELECT count(*) n FROM capacity_pool_candidate_staging').get()).toEqual({
      n: 0,
    });
  });

  it('remembers a one-batch validated reference and still fences a stale source generation', async () => {
    const { sqlite, statements, publish } = fixture();
    const references = catalog(1).map((row) => ({ ...row, catalogSource: 'static' as const }));
    const options = { catalogComplete: false, catalogValidated: true };
    expect((await publish(references, options)).publicationComplete).toBe(true);
    statements.length = 0;
    expect(await publish(references, options)).toMatchObject({
      publicationComplete: true,
      publishedCandidates: 0,
      markedMissing: false,
    });
    expect(statements.some(({ sql }) => /^INSERT|^UPDATE|^DELETE/.test(sql))).toBe(false);
    sqlite.exec("UPDATE capacity_sources SET source_generation=2 WHERE id='source'");
    expect(await publish(references, options)).toMatchObject({
      publicationComplete: false,
      publishedCandidates: 0,
      markedMissing: false,
    });
  });

  it('does missing cleanup when the same validated reference later becomes exhaustive', async () => {
    const { sqlite, publish } = fixture();
    await publish(catalog(2));
    const references = catalog(1).map((row) => ({ ...row, catalogSource: 'static' as const }));
    expect(
      await publish(references, { catalogComplete: false, catalogValidated: true })
    ).toMatchObject({ publicationComplete: true, markedMissing: false });
    expect(
      sqlite
        .prepare(
          "SELECT count(*) n FROM capacity_pool_candidates WHERE catalog_availability='available'"
        )
        .get()
    ).toEqual({ n: 4 });
    expect(
      await publish(references, { catalogComplete: true, catalogValidated: true })
    ).toMatchObject({ publicationComplete: true, markedMissing: true });
    expect(
      sqlite
        .prepare(
          "SELECT count(*) n FROM capacity_pool_candidates WHERE catalog_availability='last-known-unavailable'"
        )
        .get()
    ).toEqual({ n: 2 });
  });

  it('restages a reference if a committed member was removed after cursor persistence', async () => {
    const { sqlite, publish } = fixture();
    const references = catalog(1).map((row) => ({ ...row, catalogSource: 'static' as const }));
    const options = { catalogComplete: false, catalogValidated: true };
    await publish(references, options);
    sqlite.exec("DELETE FROM capacity_pool_candidates WHERE workload_role='deployment'");
    expect(await publish(references, options)).toMatchObject({ publicationComplete: true });
    expect(sqlite.prepare('SELECT count(*) n FROM capacity_pool_candidates').get()).toEqual({
      n: 2,
    });
  });

  it.each(['pool_id', 'capacity_source_id'] as const)(
    'refuses an id conflict belonging to another %s',
    async (identity) => {
      const { sqlite, publish } = fixture();
      const options = { publishBatchSize: 2, publishDeadlineAt: 0 };
      await publish(catalog(2), options);
      sqlite.exec(
        `UPDATE capacity_pool_candidate_staging SET ${identity}='foreign-identity'; UPDATE capacity_sources SET source_generation=2`
      );
      const foreign = sqlite
        .prepare('SELECT * FROM capacity_pool_candidate_staging ORDER BY id')
        .all();
      expect(foreign).toHaveLength(2);
      expect(
        await publish(
          catalog(2).map((row) => ({ ...row, memoryMb: 32_768 })),
          { ...options, sourceGeneration: 2 }
        )
      ).toMatchObject({ publicationComplete: false, publishedCandidates: 0 });
      expect(
        sqlite.prepare('SELECT * FROM capacity_pool_candidate_staging ORDER BY id').all()
      ).toEqual(foreign);
    }
  );
});
