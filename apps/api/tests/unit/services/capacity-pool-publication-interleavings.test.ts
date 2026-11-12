import type { ProviderInstanceOffering } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { capacityPlacementAuthorityGeneration } from '../../../src/services/capacity-pool-authority';
import * as poolClock from '../../../src/services/capacity-pool-clock';
import { ensureCandidatesForSource } from '../../../src/services/default-capacity-pool-candidates';
import { CAPACITY_SOURCE_EXTERNAL_CREDENTIAL_TYPE } from '../../../src/services/default-capacity-pool-helpers';
import { updateDefaultCapacityPool } from '../../../src/services/default-capacity-pool-updates';
import {
  ensureDefaultCapacityPoolsForExistingCredentials,
  reconcileDefaultPoolStatus,
} from '../../../src/services/default-capacity-pools';
import { scrubCapacitySourceCredentialSecrets } from '../../../src/services/default-capacity-source-credentials';
import { createSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';

const databases: Database.Database[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
});

function fixture() {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  createSchemaTables(sqlite, [
    schema.credentials,
    schema.capacitySources,
    schema.capacityPools,
    schema.capacityPoolCandidates,
    schema.capacityPoolCandidateStaging,
    schema.capacityPoolRefreshes,
    schema.platformSettings,
    schema.users,
    schema.projects,
    schema.ccCredentials,
    schema.ccConfigurations,
    schema.ccAttachments,
    schema.platformCredentials,
  ]);
  // Keep the real destructive FK in the anchor race test, unlike the permissive schema helper.
  const sourceDdl = (
    sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'capacity_sources'").get() as {
      sql: string;
    }
  ).sql;
  sqlite.exec('DROP TABLE capacity_sources');
  sqlite.exec(
    sourceDdl.replace(
      '"credential_id" text',
      '"credential_id" text REFERENCES credentials(id) ON DELETE CASCADE'
    )
  );
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`INSERT INTO capacity_pools (id, scope, owner_user_id, is_default, status, revision, strategy, deployment_strategy, exhaustion_policy, updated_at, configuration_state, migration_state)
    VALUES ('pool', 'user', 'user', 1, 'active', 1, 'balanced', 'smallest-fit', 'queue', 'start', 'configured-ready', 'complete');
    INSERT INTO capacity_sources (id, scope, owner_user_id, source_kind, provider, status, source_generation, authority_generation)
    VALUES ('source', 'user', 'user', 'cloud-provider-credential', 'hetzner', 'active', 1, 1);`);
  const database = createSqliteD1WithBindLimit(sqlite, 100);
  return { sqlite, database, db: drizzle(database, { schema }) };
}

function offering(type = 'cx23', price = 10): ProviderInstanceOffering {
  return {
    provider: 'hetzner',
    location: 'nbg1',
    providerInstanceType: type,
    providerInstanceSku: null,
    displayName: type,
    vcpu: 2,
    memoryMb: 4096,
    diskGb: 40,
    currency: 'EUR',
    priceMonthly: price,
    catalogSource: 'api',
    catalogLastSeenAt: '2026-09-07T00:00:00Z',
    available: true,
  };
}

function cursorStore() {
  const values = new Map<string, string>();
  return {
    values,
    read: async (key: string) => values.get(key) ?? null,
    write: async (key: string, value: string | null) => {
      if (value === null) values.delete(key);
      else values.set(key, value);
    },
  };
}

function beforeStatement(database: D1Database, match: RegExp, action: () => void): D1Database {
  let fired = false;
  const queries = new WeakMap<object, string>();
  const fire = (sql: string) => {
    if (!fired && match.test(sql)) {
      fired = true;
      action();
    }
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...params: unknown[]) => wrap(target.bind(...params), sql);
        if (key === 'run' || key === 'all' || key === 'raw')
          return (...args: unknown[]) => {
            fire(sql);
            return Reflect.apply(Reflect.get(target, key), target, args);
          };
        return Reflect.get(target, key);
      },
    });
    queries.set(wrapped, sql);
    return wrapped;
  };
  return {
    ...database,
    prepare: (sql: string) => wrap(database.prepare(sql), sql),
    batch<T = unknown>(statements: D1PreparedStatement[]) {
      // Concurrent edits can precede the transaction, never interleave its statements.
      for (const statement of statements) fire(queries.get(statement) ?? '');
      return database.batch<T>(statements);
    },
  };
}

async function publish(db: ReturnType<typeof drizzle>, offerings = [offering()], options = {}) {
  return ensureCandidatesForSource(db, 'pool', 'source', 'hetzner', offerings, {
    sourceGeneration: 1,
    sourceAuthorityGeneration: 1,
    ...options,
  });
}

describe('pool publication real SQL interleavings', () => {
  it('does not cascade a source attached after anchor discovery and before deletion', async () => {
    const { sqlite, database } = fixture();
    sqlite
      .prepare(
        'INSERT INTO credentials (id, credential_type, encrypted_token, iv) VALUES (?, ?, ?, ?)'
      )
      .run('anchor', CAPACITY_SOURCE_EXTERNAL_CREDENTIAL_TYPE, 'old-secret', 'old-iv');
    const raced = beforeStatement(database, /delete from "credentials"/i, () => {
      sqlite.exec("UPDATE capacity_sources SET credential_id = 'anchor' WHERE id = 'source'");
    });
    const result = await scrubCapacitySourceCredentialSecrets(drizzle(raced, { schema }));
    expect(result.deletedUnreferencedAnchors).toBe(0);
    expect(
      sqlite.prepare("SELECT credential_id FROM capacity_sources WHERE id='source'").get()
    ).toEqual({ credential_id: 'anchor' });
    expect(
      sqlite.prepare("SELECT encrypted_token, iv FROM credentials WHERE id='anchor'").get()
    ).toEqual({ encrypted_token: '', iv: '' });
  });

  it('scrubs past clean referenced anchors and clamps caller batch sizes to the D1 bind ceiling', async () => {
    const { sqlite, db } = fixture();
    for (let i = 0; i < 201; i++) {
      const id = `anchor-${String(i).padStart(3, '0')}`;
      sqlite
        .prepare(
          'INSERT INTO credentials (id, credential_type, encrypted_token, iv) VALUES (?, ?, ?, ?)'
        )
        .run(id, CAPACITY_SOURCE_EXTERNAL_CREDENTIAL_TYPE, i < 50 ? '' : 'secret', '');
      sqlite
        .prepare('INSERT INTO capacity_sources (id, credential_id) VALUES (?, ?)')
        .run(`ref-${i}`, id);
    }
    for (let i = 0; i < 3; i++)
      await scrubCapacitySourceCredentialSecrets(db, { batchSize: 10000 });
    expect(
      sqlite.prepare("SELECT count(*) n FROM credentials WHERE encrypted_token <> ''").get()
    ).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT count(*) n FROM credentials').get()).toEqual({ n: 201 });
  });

  it('uses current primary membership when a previously missing deployment mirror is inserted', async () => {
    const { sqlite, database, db } = fixture();
    await publish(db);
    sqlite.exec("DELETE FROM capacity_pool_candidates WHERE workload_role='deployment'");
    const primary = sqlite
      .prepare("SELECT id FROM capacity_pool_candidates WHERE workload_role='workspace'")
      .get() as { id: string };
    const raced = beforeStatement(
      database,
      /INSERT INTO capacity_pool_candidate(?:s|_staging)/,
      () => {
        sqlite
          .prepare("UPDATE capacity_pool_candidates SET status='deleted' WHERE id=?")
          .run(primary.id);
      }
    );
    await publish(drizzle(raced, { schema }));
    expect(
      sqlite
        .prepare("SELECT status FROM capacity_pool_candidates WHERE workload_role='deployment'")
        .get()
    ).toEqual({ status: 'deleted' });
  });

  it('restarts changed prices but retains completed publication across unchanged refreshes', async () => {
    const { sqlite, db } = fixture();
    const store = cursorStore();
    const options = { publishBatchSize: 2, cursorStore: store };
    expect(
      (await publish(db, [offering('cx23', 10), offering('cx33', 20)], options)).publicationComplete
    ).toBe(false);
    expect(
      (await publish(db, [offering('cx23', 99), offering('cx33', 20)], options)).publicationComplete
    ).toBe(false);
    expect(
      sqlite
        .prepare(
          "SELECT DISTINCT provider_instance_price_monthly_cents AS price FROM capacity_pool_candidates WHERE provider_instance_type='cx23'"
        )
        .all()
    ).toEqual([]); // Replacement remains private until every row is staged.
    const changedCatalog = [offering('cx23', 99), offering('cx33', 20)];
    const completed = await publish(db, changedCatalog, options);
    expect(completed.publicationComplete).toBe(true);
    expect(store.values.size).toBe(1);
    const completedCursor = JSON.parse([...store.values.values()][0]!);
    expect(completedCursor).toEqual({
      digest: expect.any(String),
      published: 4,
      complete: true,
    });
    await reconcileDefaultPoolStatus(db, 'pool', undefined, completed);
    const readyPool = sqlite
      .prepare("SELECT revision, migration_state FROM capacity_pools WHERE id='pool'")
      .get();
    expect(readyPool).toMatchObject({ migration_state: 'complete' });

    // The bounded refresh rotates through both pages without hiding a ready catalog.
    for (const published of [2, 4]) {
      const refreshed = await publish(db, changedCatalog, options);
      expect(refreshed).toMatchObject({ publishedCandidates: 2, publicationComplete: true });
      expect(JSON.parse([...store.values.values()][0]!)).toEqual({
        ...completedCursor,
        published,
      });
      await reconcileDefaultPoolStatus(db, 'pool', undefined, refreshed);
      expect(
        sqlite.prepare("SELECT revision, migration_state FROM capacity_pools WHERE id='pool'").get()
      ).toEqual(readyPool);
    }

    // A price change also invalidates an already-completed semantic catalog.
    const repriced = await publish(db, [offering('cx23', 101), offering('cx33', 20)], options);
    expect(repriced.publicationComplete).toBe(false);
    const repricedCursor = JSON.parse([...store.values.values()][0]!);
    expect(repricedCursor).toEqual({
      digest: expect.any(String),
      published: 2,
      complete: false,
    });
    expect(repricedCursor.digest).not.toBe(completedCursor.digest);
    await reconcileDefaultPoolStatus(db, 'pool', undefined, repriced);
    expect(
      sqlite.prepare("SELECT migration_state FROM capacity_pools WHERE id='pool'").get()
    ).toEqual({ migration_state: 'pending' });
  });

  it('does not rewrite unchanged candidates when only the refresh generation advances', async () => {
    const { sqlite, db } = fixture();
    await publish(db);
    const before = sqlite
      .prepare(
        `
        SELECT catalog_generation, updated_at
        FROM capacity_pool_candidates
        ORDER BY id
      `
      )
      .all();

    sqlite.exec("UPDATE capacity_sources SET source_generation=2 WHERE id='source'");
    const refreshed = await ensureCandidatesForSource(
      db,
      'pool',
      'source',
      'hetzner',
      [offering()],
      {
        sourceGeneration: 2,
        sourceAuthorityGeneration: 1,
      }
    );

    expect(refreshed).toMatchObject({
      publishedCandidates: 2,
      publicationComplete: true,
      markedMissing: true,
    });
    expect(
      sqlite
        .prepare(
          `
          SELECT catalog_generation, updated_at
          FROM capacity_pool_candidates
          ORDER BY id
        `
        )
        .all()
    ).toEqual(before);
  });

  it('does not count generation-rejected writes as published progress', async () => {
    const { sqlite, database } = fixture();
    const store = cursorStore();
    const raced = beforeStatement(
      database,
      /INSERT INTO capacity_pool_candidate(?:s|_staging)/,
      () => {
        sqlite.exec("UPDATE capacity_sources SET source_generation=2 WHERE id='source'");
      }
    );
    const result = await publish(drizzle(raced, { schema }), [offering()], { cursorStore: store });
    expect(result).toMatchObject({
      publishedCandidates: 0,
      publicationComplete: false,
      markedMissing: false,
    });
    expect(JSON.parse([...store.values.values()][0]!).published).toBe(0);
    expect(sqlite.prepare('SELECT count(*) n FROM capacity_pool_candidates').get()).toEqual({
      n: 0,
    });
  });

  it('preserves native configuration edited between the catalog read and publication', async () => {
    const { sqlite, database, db } = fixture();
    await publish(db);
    sqlite.exec(
      "UPDATE capacity_pool_candidates SET provider_instance_image='old', provider_instance_boot_disk_size_gb=50, provider_instance_architecture='x86'"
    );
    const raced = beforeStatement(
      database,
      /INSERT INTO capacity_pool_candidate(?:s|_staging)/,
      () => {
        sqlite.exec(
          "UPDATE capacity_pool_candidates SET provider_instance_image='new', provider_instance_boot_disk_size_gb=90, provider_instance_architecture='arm'"
        );
      }
    );
    expect((await publish(drizzle(raced, { schema }))).publicationComplete).toBe(false);
    expect(
      sqlite
        .prepare(
          'SELECT DISTINCT provider_instance_image image, provider_instance_boot_disk_size_gb disk, provider_instance_architecture arch FROM capacity_pool_candidates'
        )
        .all()
    ).toEqual([{ image: 'new', disk: 90, arch: 'arm' }]);
    expect((await publish(db)).publicationComplete).toBe(true);
  });

  it('invalidates an unknown upgrade selection baseline once and preserves later identical refreshes', async () => {
    const { sqlite, db } = fixture();
    await publish(db);
    await reconcileDefaultPoolStatus(db, 'pool');
    const first = sqlite.prepare("SELECT revision FROM capacity_pools WHERE id='pool'").get();
    expect(first).toEqual({ revision: 2 });
    await reconcileDefaultPoolStatus(db, 'pool');
    expect(sqlite.prepare("SELECT revision FROM capacity_pools WHERE id='pool'").get()).toEqual(
      first
    );
    await publish(db, [offering('cx23', 90)]);
    await reconcileDefaultPoolStatus(db, 'pool');
    expect(sqlite.prepare("SELECT revision FROM capacity_pools WHERE id='pool'").get()).toEqual({
      revision: 3,
    });
  });

  it('keeps partial publication migration pending until completion is proved', async () => {
    const { sqlite, db } = fixture();
    await publish(db);
    await reconcileDefaultPoolStatus(db, 'pool', undefined, { publicationComplete: false });
    expect(
      sqlite.prepare("SELECT migration_state FROM capacity_pools WHERE id='pool'").get()
    ).toEqual({ migration_state: 'pending' });
    await reconcileDefaultPoolStatus(db, 'pool', undefined, { publicationComplete: true });
    expect(
      sqlite.prepare("SELECT migration_state FROM capacity_pools WHERE id='pool'").get()
    ).toEqual({ migration_state: 'complete' });
  });

  it('reports a winning edit accurately when another editor commits before its response', async () => {
    const { database, db } = fixture();
    const originalBatch = database.batch.bind(database);
    let entered = false;
    const raced = {
      ...database,
      batch: async (...args: Parameters<D1Database['batch']>) => {
        const result = await originalBatch(...args);
        if (!entered) {
          entered = true;
          await updateDefaultCapacityPool(db, {
            scope: 'user',
            ownerUserId: 'user',
            ownerProjectId: null,
            policy: { strategy: 'spread' },
          });
        }
        return result;
      },
    };
    const result = await updateDefaultCapacityPool(drizzle(raced, { schema }), {
      scope: 'user',
      ownerUserId: 'user',
      ownerProjectId: null,
      policy: { strategy: 'pack' },
    });
    expect(result.conflict).toBe(false);
  });
  it('rejects a losing edit even when another isolate publishes in the exact same millisecond', async () => {
    vi.spyOn(poolClock, 'nextCapacityPoolTimestamp').mockReturnValue('2026-09-07T12:00:00.000Z');
    const { database, db } = fixture();
    const originalBatch = database.batch.bind(database);
    let entered = false;
    const raced = {
      ...database,
      batch: async (...args: Parameters<D1Database['batch']>) => {
        if (!entered) {
          entered = true;
          await updateDefaultCapacityPool(db, {
            scope: 'user',
            ownerUserId: 'user',
            ownerProjectId: null,
            policy: { strategy: 'spread' },
          });
        }
        return originalBatch(...args);
      },
    };
    const result = await updateDefaultCapacityPool(drizzle(raced, { schema }), {
      scope: 'user',
      ownerUserId: 'user',
      ownerProjectId: null,
      policy: { strategy: 'pack' },
    });
    expect(result.conflict).toBe(true);
  });
  it('the reconciliation caller keeps its initial migration pending across bounded publication ticks', async () => {
    const { sqlite, db } = fixture();
    sqlite.exec('DELETE FROM capacity_sources; DELETE FROM capacity_pools;');
    sqlite.exec(`INSERT INTO credentials (id, user_id, provider, credential_type, is_active, encrypted_token, iv, created_at, updated_at)
      VALUES ('credential', 'user', 'hetzner', 'cloud-provider', 1, 'ciphertext', 'iv', '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z')`);
    const options = {
      userId: 'user',
      includeInstallation: false,
      candidatePublishBatchSize: 1,
      candidatePublishBudgetMs: 0,
      offeringResolver: async () => [offering()],
    };
    await ensureDefaultCapacityPoolsForExistingCredentials(db, options);
    expect(sqlite.prepare('SELECT migration_state FROM capacity_pools').get()).toEqual({
      migration_state: 'pending',
    });
    await ensureDefaultCapacityPoolsForExistingCredentials(db, {
      ...options,
      offeringResolver: async () => ({ offerings: [], refreshSucceeded: false }),
    });
    expect(sqlite.prepare('SELECT migration_state FROM capacity_pools').get()).toEqual({
      migration_state: 'pending',
    });
    await ensureDefaultCapacityPoolsForExistingCredentials(db, options);
    expect(sqlite.prepare('SELECT migration_state FROM capacity_pools').get()).toEqual({
      migration_state: 'complete',
    });
    expect(sqlite.prepare('SELECT count(*) n FROM capacity_pool_candidates').get()).toEqual({
      n: 2,
    });
  });

  it.each(['resources', 'credential authority'] as const)(
    'restarts publication when %s change with identical candidate IDs',
    async (change) => {
      const { sqlite, db } = fixture();
      const store = cursorStore();
      await publish(db, [offering('cx23'), offering('cx33')], {
        publishBatchSize: 2,
        cursorStore: store,
      });
      const updated =
        change === 'resources' ? { ...offering('cx23'), memoryMb: 8192 } : offering('cx23');
      const result = await publish(db, [updated, offering('cx33')], {
        publishBatchSize: 2,
        cursorStore: store,
        sourceAuthorityGeneration: change === 'credential authority' ? 2 : 1,
      });
      expect(result.publicationComplete).toBe(false);
      expect(
        sqlite.prepare('SELECT count(*) n FROM capacity_pool_candidate_staging').get()
      ).toEqual({
        n: 2,
      });
      if (change === 'resources')
        expect(
          sqlite
            .prepare(
              "SELECT DISTINCT json_extract(payload, '$.providerInstanceMemoryMb') memory FROM capacity_pool_candidate_staging"
            )
            .all()
        ).toEqual([{ memory: 8192 }]);
      expect(sqlite.prepare('SELECT count(*) n FROM capacity_pool_candidates').get()).toEqual({
        n: 0,
      });
      const completed = await publish(db, [updated, offering('cx33')], {
        publishBatchSize: 2,
        cursorStore: store,
        sourceAuthorityGeneration: change === 'credential authority' ? 2 : 1,
      });
      expect(completed.publicationComplete).toBe(true);
      expect(sqlite.prepare('SELECT count(*) n FROM capacity_pool_candidates').get()).toEqual({
        n: 4,
      });
      if (change === 'resources')
        expect(
          sqlite
            .prepare(
              "SELECT DISTINCT provider_instance_memory_mb memory FROM capacity_pool_candidates WHERE provider_instance_type = 'cx23'"
            )
            .all()
        ).toEqual([{ memory: 8192 }]);
    }
  );

  it('removes a mirror published after the editor reads membership but before its atomic batch', async () => {
    const { sqlite, database, db } = fixture();
    await publish(db);
    const primary = sqlite
      .prepare("SELECT id FROM capacity_pool_candidates WHERE workload_role='workspace'")
      .get() as { id: string };
    sqlite.exec("DELETE FROM capacity_pool_candidates WHERE workload_role='deployment'");
    const originalBatch = database.batch.bind(database);
    let entered = false;
    const raced = {
      ...database,
      batch: async (...args: Parameters<D1Database['batch']>) => {
        if (!entered) {
          entered = true;
          await publish(db);
        }
        return originalBatch(...args);
      },
    };
    const result = await updateDefaultCapacityPool(drizzle(raced, { schema }), {
      scope: 'user',
      ownerUserId: 'user',
      ownerProjectId: null,
      candidates: [{ id: primary.id, status: 'deleted' }],
    });
    expect(result.conflict).toBe(false);
    expect(sqlite.prepare('SELECT DISTINCT status FROM capacity_pool_candidates').all()).toEqual([
      { status: 'deleted' },
    ]);
  });
  it('does not turn a known empty API catalog into static membership on a later outage', async () => {
    const { sqlite, db } = fixture();
    sqlite.exec('DELETE FROM capacity_sources; DELETE FROM capacity_pools;');
    sqlite.exec(`INSERT INTO credentials (id, user_id, provider, credential_type, is_active, encrypted_token, iv, created_at, updated_at)
      VALUES ('credential', 'user', 'hetzner', 'cloud-provider', 1, 'ciphertext', 'iv', '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z')`);
    const scope = { userId: 'user', includeInstallation: false };
    await ensureDefaultCapacityPoolsForExistingCredentials(db, {
      ...scope,
      offeringResolver: async () => ({
        offerings: [],
        refreshSucceeded: true,
        catalogComplete: true,
      }),
    });
    await ensureDefaultCapacityPoolsForExistingCredentials(db, {
      ...scope,
      offeringResolver: async () => ({
        offerings: [{ ...offering(), catalogSource: 'static' as const }],
        refreshSucceeded: false,
        catalogComplete: false,
      }),
    });
    expect(sqlite.prepare('SELECT count(*) n FROM capacity_pool_candidates').get()).toEqual({
      n: 0,
    });
  });
});

describe('pool publication pass budget (incident 2026-11-09)', () => {
  // 5 offerings x 2 workload roles = 10 rows; batch size 2 makes every count in the path smaller
  // than the catalog, so only a multi-batch pass can finish it.
  const catalog = () =>
    Array.from({ length: 5 }, (_, index) => offering(`cx${index}3`, 10 + index));

  function countingBatches(database: D1Database) {
    const counter = { batches: 0 };
    const counted: D1Database = {
      ...database,
      batch<T = unknown>(statements: D1PreparedStatement[]) {
        counter.batches += 1;
        return database.batch<T>(statements);
      },
    };
    return { counter, counted };
  }

  function failingNthCandidateBatch(database: D1Database, failAt: number): D1Database {
    const sqlOf = new WeakMap<object, string>();
    let candidateBatches = 0;
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
      const wrapped = new Proxy(statement, {
        get(target, key) {
          if (key === 'bind') return (...params: unknown[]) => wrap(target.bind(...params), sql);
          if (key === 'run' || key === 'all' || key === 'raw' || key === 'first')
            return (...args: unknown[]) => Reflect.apply(Reflect.get(target, key), target, args);
          return Reflect.get(target, key);
        },
      });
      sqlOf.set(wrapped, sql);
      return wrapped;
    };
    return {
      ...database,
      prepare: (sql: string) => wrap(database.prepare(sql), sql),
      batch<T = unknown>(statements: D1PreparedStatement[]) {
        if (
          statements.some((s) =>
            /INSERT INTO capacity_pool_candidate(?:s|_staging)/.test(sqlOf.get(s) ?? '')
          )
        ) {
          candidateBatches += 1;
          if (candidateBatches === failAt) {
            return Promise.reject(new Error('D1_ERROR: simulated batch failure'));
          }
        }
        return database.batch<T>(statements);
      },
    };
  }

  it('finishes an incomplete catalog in one pass while the deadline allows', async () => {
    const { db } = fixture();
    const store = cursorStore();
    const result = await publish(db, catalog(), {
      publishBatchSize: 2,
      cursorStore: store,
      publishDeadlineAt: Number.POSITIVE_INFINITY,
    });
    expect(result).toMatchObject({
      totalCandidates: 10,
      publishedCandidates: 10,
      publicationComplete: true,
      markedMissing: true,
    });
  });

  it('stops at the deadline with a durable cursor, and the next pass resumes instead of restarting', async () => {
    const { database } = fixture();
    const store = cursorStore();
    const { counter, counted } = countingBatches(database);
    // The clock reads the number of batches written, so the deadline admits exactly two.
    const first = await publish(drizzle(counted, { schema }), catalog(), {
      publishBatchSize: 2,
      cursorStore: store,
      publishDeadlineAt: 2,
      now: () => counter.batches,
    });
    expect(counter.batches).toBe(2);
    expect(first).toMatchObject({ publishedCandidates: 4, publicationComplete: false });
    expect(JSON.parse([...store.values.values()][0]!)).toMatchObject({
      published: 4,
      complete: false,
    });

    const second = await publish(drizzle(database, { schema }), catalog(), {
      publishBatchSize: 2,
      cursorStore: store,
      publishDeadlineAt: Number.POSITIVE_INFINITY,
    });
    // Only the remaining 6 rows: progress resumed from the cursor.
    expect(second).toMatchObject({ publishedCandidates: 6, publicationComplete: true });
  });

  it('a pass that dies mid-loop keeps the cursor at its last complete batch, and the next pass resumes there', async () => {
    const { database } = fixture();
    const store = cursorStore();
    await expect(
      publish(drizzle(failingNthCandidateBatch(database, 3), { schema }), catalog(), {
        publishBatchSize: 2,
        cursorStore: store,
        publishDeadlineAt: Number.POSITIVE_INFINITY,
      })
    ).rejects.toThrow('simulated batch failure');
    expect(JSON.parse([...store.values.values()][0]!)).toMatchObject({
      published: 4,
      complete: false,
    });

    const resumed = await publish(drizzle(database, { schema }), catalog(), {
      publishBatchSize: 2,
      cursorStore: store,
      publishDeadlineAt: Number.POSITIVE_INFINITY,
    });
    expect(resumed).toMatchObject({ publishedCandidates: 6, publicationComplete: true });
  });

  it('marks offerings that left the catalog only after a multi-batch pass completes', async () => {
    const { sqlite, db } = fixture();
    const store = cursorStore();
    await publish(db, [offering('cx99', 10)], { cursorStore: store });
    sqlite.exec("UPDATE capacity_sources SET source_generation=2 WHERE id='source'");
    const result = await publish(db, catalog(), {
      sourceGeneration: 2,
      publishBatchSize: 2,
      cursorStore: store,
      publishDeadlineAt: Number.POSITIVE_INFINITY,
    });
    expect(result).toMatchObject({ publishedCandidates: 10, markedMissing: true });
    expect(
      sqlite
        .prepare(
          "SELECT DISTINCT catalog_availability AS availability FROM capacity_pool_candidates WHERE provider_instance_type='cx99'"
        )
        .all()
    ).toEqual([{ availability: 'last-known-unavailable' }]);
  });

  it('a past deadline writes exactly one batch per pass', async () => {
    const { db } = fixture();
    const store = cursorStore();
    const result = await publish(db, catalog(), {
      publishBatchSize: 2,
      cursorStore: store,
      publishDeadlineAt: 0,
    });
    expect(result).toMatchObject({ publishedCandidates: 2, publicationComplete: false });
  });

  it('keeps one batch per pass for a complete, unchanged catalog even with time left', async () => {
    const { db } = fixture();
    const store = cursorStore();
    const options = {
      publishBatchSize: 2,
      cursorStore: store,
      publishDeadlineAt: Number.POSITIVE_INFINITY,
    };
    expect(await publish(db, catalog(), options)).toMatchObject({
      publishedCandidates: 10,
      publicationComplete: true,
    });
    // Already placeable: the steady-state refresh keeps its round-robin cost.
    expect(await publish(db, catalog(), options)).toMatchObject({
      publishedCandidates: 2,
      publicationComplete: true,
    });
  });

  it('stops the loop when a newer publisher fences the batch, even with time left', async () => {
    const { sqlite, database } = fixture();
    const store = cursorStore();
    const raced = beforeStatement(
      database,
      /INSERT INTO capacity_pool_candidate(?:s|_staging)/,
      () => {
        sqlite.exec("UPDATE capacity_sources SET source_generation=2 WHERE id='source'");
      }
    );
    const { counter, counted } = countingBatches(raced);
    let tick = 0;
    const result = await publish(drizzle(counted, { schema }), catalog(), {
      publishBatchSize: 2,
      cursorStore: store,
      // A finite horizon keeps a regression from spinning forever: without the fence check the
      // loop would retry the same rejected slice until this runs out.
      publishDeadlineAt: 50,
      now: () => tick++,
    });
    expect(result).toMatchObject({ publishedCandidates: 0, publicationComplete: false });
    // One candidate write batch plus its one verification read, nothing more.
    expect(counter.batches).toBeLessThanOrEqual(2);
    expect(JSON.parse([...store.values.values()][0]!).published).toBe(0);
  });
});

describe('atomic replacement publication', () => {
  it('publishes an explicitly validated static bootstrap without treating enumeration as complete', async () => {
    const { db, sqlite } = fixture();
    const result = await publish(db, [{ ...offering(), catalogSource: 'static' }], {
      catalogComplete: false,
      catalogValidated: true,
    });
    expect(result).toMatchObject({ publicationComplete: true, markedMissing: false });
    expect(sqlite.prepare('SELECT count(*) n FROM capacity_pool_candidates').get()).toEqual({
      n: 2,
    });
    expect(sqlite.prepare('SELECT DISTINCT status FROM capacity_pool_candidates').all()).toEqual([
      { status: 'disabled' },
    ]);
  });

  it('atomically publishes trusted static references while preserving stronger API presence and absence', async () => {
    const { db, sqlite } = fixture();
    const store = cursorStore();
    await publish(db, [offering('cx23', 10), offering('cx33', 20), offering('cx53', 40)]);
    sqlite.exec(
      "UPDATE capacity_pool_candidates SET status='active'; UPDATE capacity_pool_candidates SET catalog_availability='last-known-unavailable' WHERE provider_instance_type='cx53'"
    );
    await reconcileDefaultPoolStatus(db, 'pool');
    const before = sqlite
      .prepare(
        'SELECT id, status, catalog_availability, provider_instance_memory_mb, provider_instance_price_monthly_cents FROM capacity_pool_candidates ORDER BY id'
      )
      .all();
    const references = [
      { ...offering('cx23', 999), catalogSource: 'static' as const, memoryMb: 8192 },
      { ...offering('cx43', 30), catalogSource: 'static' as const },
      { ...offering('cx53', 999), catalogSource: 'static' as const },
    ];
    const options = {
      catalogComplete: false,
      catalogValidated: true,
      publishBatchSize: 2,
      cursorStore: store,
    };
    for (let pass = 0; pass < 2; pass++) {
      expect((await publish(db, references, options)).publicationComplete).toBe(false);
      expect(
        sqlite
          .prepare(
            'SELECT id, status, catalog_availability, provider_instance_memory_mb, provider_instance_price_monthly_cents FROM capacity_pool_candidates ORDER BY id'
          )
          .all()
      ).toEqual(before);
    }
    const result = await publish(db, references, options);
    expect(result).toMatchObject({ publicationComplete: true, markedMissing: false });
    expect(
      sqlite
        .prepare(
          'SELECT DISTINCT provider_instance_type type, provider_instance_catalog_source source, catalog_availability availability, provider_instance_price_monthly_cents price FROM capacity_pool_candidates ORDER BY type'
        )
        .all()
    ).toEqual([
      { type: 'cx23', source: 'api', availability: 'available', price: 1000 },
      { type: 'cx33', source: 'api', availability: 'available', price: 2000 },
      { type: 'cx43', source: 'static', availability: 'available', price: 3000 },
      { type: 'cx53', source: 'api', availability: 'last-known-unavailable', price: 4000 },
    ]);
    const committed = sqlite
      .prepare("SELECT revision, selection_digest FROM capacity_pools WHERE id='pool'")
      .get();
    await reconcileDefaultPoolStatus(db, 'pool', result.poolPublicationGuard);
    expect(
      sqlite.prepare("SELECT revision, selection_digest FROM capacity_pools WHERE id='pool'").get()
    ).toEqual(committed);
    expect((await publish(db, references, options)).publicationComplete).toBe(true);
    expect(
      sqlite.prepare("SELECT revision, selection_digest FROM capacity_pools WHERE id='pool'").get()
    ).toEqual(committed);
  });

  it('does not publish explicitly invalid metadata even if enumeration is complete', async () => {
    const { db, sqlite } = fixture();
    expect(
      (await publish(db, [offering()], { catalogComplete: true, catalogValidated: false }))
        .publicationComplete
    ).toBe(false);
    expect(sqlite.prepare('SELECT count(*) n FROM capacity_pool_candidates').get()).toEqual({
      n: 0,
    });
  });

  it('keeps partial API resource and price replacements private until a complete catalog returns', async () => {
    const { db, sqlite } = fixture();
    const store = cursorStore();
    const original = [offering('cx23', 10), offering('cx33', 20)];
    await publish(db, original, { cursorStore: store });
    sqlite.exec("UPDATE capacity_pool_candidates SET status='active'");
    await reconcileDefaultPoolStatus(db, 'pool');
    const beforeRows = sqlite
      .prepare(
        'SELECT id, status, provider_instance_memory_mb, provider_instance_price_monthly_cents FROM capacity_pool_candidates ORDER BY id'
      )
      .all();
    const beforePool = sqlite
      .prepare("SELECT revision, selection_digest FROM capacity_pools WHERE id='pool'")
      .get();
    const replacement = { ...offering('cx23', 99), memoryMb: 8192 };
    const partial = await publish(db, [replacement], {
      cursorStore: store,
      catalogComplete: false,
    });
    expect(partial).toMatchObject({ publicationComplete: false, markedMissing: false });
    expect(partial.poolPublicationGuard).toBeUndefined();
    expect(
      sqlite
        .prepare(
          'SELECT id, status, provider_instance_memory_mb, provider_instance_price_monthly_cents FROM capacity_pool_candidates ORDER BY id'
        )
        .all()
    ).toEqual(beforeRows);
    expect(
      sqlite.prepare("SELECT revision, selection_digest FROM capacity_pools WHERE id='pool'").get()
    ).toEqual(beforePool);
    expect(
      sqlite
        .prepare(
          "SELECT DISTINCT json_extract(payload, '$.providerInstanceMemoryMb') AS memory FROM capacity_pool_candidate_staging WHERE digest = ?"
        )
        .all(JSON.parse([...store.values.values()][0]!).digest)
    ).toEqual([{ memory: 8192 }]);
    expect(
      (await publish(db, [replacement, original[1]!], { cursorStore: store })).publicationComplete
    ).toBe(true);
    expect(
      sqlite
        .prepare(
          "SELECT DISTINCT provider_instance_memory_mb memory, provider_instance_price_monthly_cents price FROM capacity_pool_candidates WHERE provider_instance_type='cx23'"
        )
        .all()
    ).toEqual([{ memory: 8192, price: 9900 }]);
  });

  it('never exposes initial partial API or static fallback rows even when they fit in one batch', async () => {
    const { db, sqlite } = fixture();
    for (const catalogSource of ['api', 'static'] as const) {
      const result = await publish(db, [{ ...offering(), catalogSource }], {
        catalogComplete: false,
      });
      expect(result).toMatchObject({ publicationComplete: false, markedMissing: false });
      expect(sqlite.prepare('SELECT count(*) n FROM capacity_pool_candidates').get()).toEqual({
        n: 0,
      });
    }
  });

  it('invalidates competing allocation plans atomically before summary reconciliation', async () => {
    const { db, sqlite } = fixture();
    const catalog = [offering('cx23', 10), offering('cx33', 20)];
    await publish(db, catalog);
    await reconcileDefaultPoolStatus(db, 'pool');
    const before = sqlite
      .prepare("SELECT revision, updated_at FROM capacity_pools WHERE id='pool'")
      .get() as { revision: number; updated_at: string };
    const unchangedCandidate = sqlite
      .prepare(
        "SELECT authority_generation FROM capacity_pool_candidates WHERE provider_instance_type='cx33' AND workload_role='workspace'"
      )
      .get() as { authority_generation: number };
    const result = await publish(db, [offering('cx23', 1), catalog[1]!], {
      poolPublicationGuard: {
        revision: before.revision,
        updatedAt: before.updated_at,
        status: 'active',
      },
    });
    // The caller can crash here: no summary call has run, yet the old paid allocation
    // token is already invalid, including a token for the untouched competing cx33.
    const after = sqlite.prepare("SELECT revision FROM capacity_pools WHERE id='pool'").get() as {
      revision: number;
    };
    expect(after.revision).toBe(before.revision + 1);
    expect(result.poolPublicationGuard).toMatchObject({
      revision: after.revision,
      status: 'active',
    });
    expect(
      sqlite
        .prepare(
          "SELECT authority_generation FROM capacity_pool_candidates WHERE provider_instance_type='cx33' AND workload_role='workspace'"
        )
        .get()
    ).toEqual(unchangedCandidate);
    const generation = (revision: number) =>
      capacityPlacementAuthorityGeneration({
        poolRevision: revision,
        selectionSettingsGeneration: 1,
        sourceAuthorityGeneration: 1,
        candidateAuthorityGeneration: unchangedCandidate.authority_generation,
      });
    expect(generation(after.revision)).not.toBe(generation(before.revision));
    await reconcileDefaultPoolStatus(db, 'pool', result.poolPublicationGuard);
    expect(sqlite.prepare("SELECT revision FROM capacity_pools WHERE id='pool'").get()).toEqual(
      after
    );
  });

  it('rolls the revision and every live row back if promotion fails midway', async () => {
    const { db, sqlite } = fixture();
    await publish(db, [offering('cx23', 10), offering('cx33', 20)]);
    const beforePool = sqlite
      .prepare("SELECT revision, selection_digest, updated_at FROM capacity_pools WHERE id='pool'")
      .get();
    const beforeRows = sqlite
      .prepare(
        'SELECT id, provider_instance_price_monthly_cents FROM capacity_pool_candidates ORDER BY id'
      )
      .all();
    sqlite.exec(`CREATE TRIGGER interrupt_promotion BEFORE INSERT ON capacity_pool_candidates
      WHEN NEW.provider_instance_type = 'cx33' BEGIN SELECT RAISE(ABORT, 'interrupted publication'); END;`);
    await expect(publish(db, [offering('cx23', 11), offering('cx33', 21)])).rejects.toThrow(
      'interrupted publication'
    );
    expect(
      sqlite
        .prepare(
          "SELECT revision, selection_digest, updated_at FROM capacity_pools WHERE id='pool'"
        )
        .get()
    ).toEqual(beforePool);
    expect(
      sqlite
        .prepare(
          'SELECT id, provider_instance_price_monthly_cents FROM capacity_pool_candidates ORDER BY id'
        )
        .all()
    ).toEqual(beforeRows);
    sqlite.exec('DROP TRIGGER interrupt_promotion');
    expect(
      (await publish(db, [offering('cx23', 11), offering('cx33', 21)])).publicationComplete
    ).toBe(true);
  });

  it('does not adopt a concurrent pool edit when its promotion CAS loses', async () => {
    const { db, database, sqlite } = fixture();
    await publish(db, [offering('cx23', 10)]);
    const before = sqlite
      .prepare("SELECT revision, updated_at FROM capacity_pools WHERE id='pool'")
      .get() as { revision: number; updated_at: string };
    const raced = beforeStatement(database, /UPDATE capacity_pools SET revision/, () => {
      sqlite.exec(
        "UPDATE capacity_pools SET revision=revision+1, updated_at='editor' WHERE id='pool'"
      );
    });
    const result = await publish(drizzle(raced, { schema }), [offering('cx23', 11)], {
      poolPublicationGuard: {
        revision: before.revision,
        updatedAt: before.updated_at,
        status: 'active',
      },
    });
    expect(result.publicationComplete).toBe(false);
    expect(result.poolPublicationGuard).toBeUndefined();
    expect(
      sqlite
        .prepare(
          'SELECT DISTINCT provider_instance_price_monthly_cents price FROM capacity_pool_candidates'
        )
        .all()
    ).toEqual([{ price: 1000 }]);
    expect(sqlite.prepare("SELECT updated_at FROM capacity_pools WHERE id='pool'").get()).toEqual({
      updated_at: 'editor',
    });
  });

  it.each([
    "UPDATE capacity_sources SET source_generation=2 WHERE id='source'",
    "UPDATE capacity_sources SET status='disabled' WHERE id='source'",
  ])('rejects source authority lost after staging and before promotion: %s', async (mutation) => {
    const { db, database, sqlite } = fixture();
    await publish(db, [offering('cx23', 10)]);
    const before = sqlite
      .prepare("SELECT revision, selection_digest FROM capacity_pools WHERE id='pool'")
      .get();
    const raced = beforeStatement(database, /UPDATE capacity_pools SET revision/, () => {
      sqlite.exec(mutation);
    });
    const result = await publish(drizzle(raced, { schema }), [offering('cx23', 11)]);
    expect(result.publicationComplete).toBe(false);
    expect(result.poolPublicationGuard).toBeUndefined();
    expect(
      sqlite.prepare("SELECT revision, selection_digest FROM capacity_pools WHERE id='pool'").get()
    ).toEqual(before);
    expect(
      sqlite
        .prepare(
          'SELECT DISTINCT provider_instance_price_monthly_cents price FROM capacity_pool_candidates'
        )
        .all()
    ).toEqual([{ price: 1000 }]);
  });

  it('returns its own committed guard even if another edit wins before the response arrives', async () => {
    const { db, database, sqlite } = fixture();
    await publish(db, [offering('cx23', 10)]);
    const before = sqlite.prepare("SELECT revision FROM capacity_pools WHERE id='pool'").get() as {
      revision: number;
    };
    const batch = database.batch.bind(database);
    let intervened = false;
    const raced = {
      ...database,
      batch: async (...args: Parameters<D1Database['batch']>) => {
        const result = await batch(...args);
        if (!intervened && result[0]?.results?.length) {
          intervened = true;
          sqlite.exec(
            "UPDATE capacity_pools SET revision=revision+1, updated_at='later-editor' WHERE id='pool'"
          );
        }
        return result;
      },
    };
    const result = await publish(drizzle(raced, { schema }), [offering('cx23', 11)]);
    expect(result.poolPublicationGuard?.revision).toBe(before.revision + 1);
    expect(result.poolPublicationGuard?.updatedAt).not.toBe('later-editor');
    expect(
      sqlite.prepare("SELECT revision, updated_at FROM capacity_pools WHERE id='pool'").get()
    ).toEqual({ revision: before.revision + 2, updated_at: 'later-editor' });
    await reconcileDefaultPoolStatus(db, 'pool', result.poolPublicationGuard);
    expect(sqlite.prepare("SELECT updated_at FROM capacity_pools WHERE id='pool'").get()).toEqual({
      updated_at: 'later-editor',
    });
  });

  it.each([
    'missing batch entry',
    'missing returned row',
    'missing revision',
    'missing timestamp',
    'missing status',
    'wrong revision',
    'wrong timestamp',
    'wrong status',
    'string revision',
  ])('does not adopt a promotion acknowledgement with %s', async (fault) => {
    const { db, database, sqlite } = fixture();
    await publish(db, [offering('cx23', 10)]);
    const before = sqlite.prepare("SELECT revision FROM capacity_pools WHERE id='pool'").get();
    const batch = database.batch.bind(database);
    let tampered = false;
    const malformed = {
      ...database,
      batch: async (...args: Parameters<D1Database['batch']>) => {
        const result = await batch(...args);
        const first = result[0];
        const raw = first?.results?.[0];
        if (
          !tampered &&
          first &&
          raw &&
          typeof raw === 'object' &&
          'revision' in raw &&
          'updatedAt' in raw &&
          'status' in raw
        ) {
          // The actual atomic SQLite promotion committed. Only its external acknowledgement
          // is damaged; rejecting it cannot rely on rolling back or re-reading a later edit.
          tampered = true;
          const acknowledgement: Record<string, unknown> = { ...raw };
          if (fault === 'missing batch entry') result.shift();
          else if (fault === 'missing returned row') first.results = [];
          else {
            if (fault === 'missing revision') delete acknowledgement.revision;
            if (fault === 'missing timestamp') delete acknowledgement.updatedAt;
            if (fault === 'missing status') delete acknowledgement.status;
            if (fault === 'wrong revision')
              acknowledgement.revision = Number(acknowledgement.revision) + 1;
            if (fault === 'wrong timestamp')
              acknowledgement.updatedAt = `${String(acknowledgement.updatedAt)}-other-publication`;
            if (fault === 'wrong status') acknowledgement.status = 'disabled';
            if (fault === 'string revision')
              acknowledgement.revision = String(acknowledgement.revision);
            first.results = [acknowledgement];
          }
        }
        return result;
      },
    };
    const store = cursorStore();
    const result = await publish(drizzle(malformed, { schema }), [offering('cx23', 11)], {
      cursorStore: store,
    });
    expect(tampered).toBe(true);
    expect(result.publicationComplete).toBe(false);
    expect(result.poolPublicationGuard).toBeUndefined();
    expect([...store.values.values()].map((value) => JSON.parse(value).complete)).toEqual([false]);
    const committed = sqlite.prepare("SELECT revision FROM capacity_pools WHERE id='pool'").get();
    expect(committed).not.toEqual(before);
    expect(
      sqlite
        .prepare(
          'SELECT DISTINCT provider_instance_price_monthly_cents price FROM capacity_pool_candidates'
        )
        .all()
    ).toEqual([{ price: 1100 }]);
    const recovered = await publish(db, [offering('cx23', 11)], { cursorStore: store });
    expect(recovered.publicationComplete).toBe(true);
    expect(recovered.poolPublicationGuard).toBeDefined();
    expect(sqlite.prepare("SELECT revision FROM capacity_pools WHERE id='pool'").get()).toEqual(
      committed
    );
  });

  it('restarts after promotion committed but cursor persistence was interrupted without rebumping', async () => {
    const { db, sqlite } = fixture();
    const store = cursorStore();
    const catalog = [offering('cx23', 10), offering('cx33', 20)];
    await publish(db, catalog, {
      cursorStore: store,
      publishBatchSize: 2,
      publishDeadlineAt: Infinity,
    });
    const replacement = [offering('cx23', 11), offering('cx33', 21)];
    const interrupted = {
      ...store,
      write: async (key: string, value: string | null) => {
        if (value && JSON.parse(value).complete) throw new Error('lost completion');
        await store.write(key, value);
      },
    };
    await expect(
      publish(db, replacement, {
        cursorStore: interrupted,
        publishBatchSize: 2,
        publishDeadlineAt: Infinity,
      })
    ).rejects.toThrow('lost completion');
    const committed = sqlite
      .prepare("SELECT revision, selection_digest FROM capacity_pools WHERE id='pool'")
      .get();
    expect(
      (
        await publish(db, replacement, {
          cursorStore: store,
          publishBatchSize: 2,
          publishDeadlineAt: Infinity,
        })
      ).publicationComplete
    ).toBe(true);
    expect(
      sqlite.prepare("SELECT revision, selection_digest FROM capacity_pools WHERE id='pool'").get()
    ).toEqual(committed);
  });

  it('retains the committed rows across an interrupted replacement and promotes together', async () => {
    const { db, sqlite } = fixture();
    const store = cursorStore();
    const initial = [offering('cx23', 10), offering('cx33', 20)];
    await publish(db, initial, { cursorStore: store, publishDeadlineAt: Infinity });
    const committed = sqlite
      .prepare(
        'SELECT id, provider_instance_price_monthly_cents FROM capacity_pool_candidates ORDER BY id'
      )
      .all();
    const replacement = [offering('cx23', 11), offering('cx33', 21), offering('cx43', 30)];
    const partial = await publish(db, replacement, { cursorStore: store, publishBatchSize: 2 });
    expect(partial.publicationComplete).toBe(false);
    expect(
      sqlite
        .prepare(
          'SELECT id, provider_instance_price_monthly_cents FROM capacity_pool_candidates ORDER BY id'
        )
        .all()
    ).toEqual(committed);
    // A fresh entry-point call resumes its saved cursor, rather than exposing the staged prefix.
    await publish(db, replacement, {
      cursorStore: store,
      publishBatchSize: 2,
      publishDeadlineAt: Infinity,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM capacity_pool_candidates').get()).toEqual({
      n: 6,
    });
    expect(
      sqlite
        .prepare(
          "SELECT DISTINCT provider_instance_price_monthly_cents AS price FROM capacity_pool_candidates WHERE provider_instance_type='cx23'"
        )
        .all()
    ).toEqual([{ price: 1100 }]);
  });

  it('never exposes a partially published first catalog', async () => {
    const { db, sqlite } = fixture();
    const store = cursorStore();
    await publish(db, [offering('cx23'), offering('cx33')], {
      cursorStore: store,
      publishBatchSize: 2,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM capacity_pool_candidates').get()).toEqual({
      n: 0,
    });
  });
});
