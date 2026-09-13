import type { ProviderInstanceOffering } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
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
  sqlite.exec(`INSERT INTO capacity_pools (id, scope, owner_user_id, is_default, status, revision, strategy, exhaustion_policy, updated_at, configuration_state, migration_state)
    VALUES ('pool', 'user', 'user', 1, 'active', 1, 'balanced', 'queue', 'start', 'configured-ready', 'complete');
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
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...params: unknown[]) => wrap(target.bind(...params), sql);
        if (key === 'run' || key === 'all' || key === 'raw')
          return (...args: unknown[]) => {
            if (!fired && match.test(sql)) {
              fired = true;
              action();
            }
            return Reflect.apply(Reflect.get(target, key), target, args);
          };
        return Reflect.get(target, key);
      },
    });
  return { ...database, prepare: (sql: string) => wrap(database.prepare(sql), sql) };
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
    const raced = beforeStatement(database, /INSERT INTO capacity_pool_candidates/, () => {
      sqlite
        .prepare("UPDATE capacity_pool_candidates SET status='deleted' WHERE id=?")
        .run(primary.id);
    });
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
    ).toEqual([{ price: 9900 }]);
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
    const raced = beforeStatement(database, /INSERT INTO capacity_pool_candidates/, () => {
      sqlite.exec("UPDATE capacity_sources SET source_generation=2 WHERE id='source'");
    });
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
    const raced = beforeStatement(database, /INSERT INTO capacity_pool_candidates/, () => {
      sqlite.exec(
        "UPDATE capacity_pool_candidates SET provider_instance_image='new', provider_instance_boot_disk_size_gb=90, provider_instance_architecture='arm'"
      );
    });
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
      expect(sqlite.prepare('SELECT count(*) n FROM capacity_pool_candidates').get()).toEqual({
        n: 2,
      });
      if (change === 'resources')
        expect(
          sqlite
            .prepare(
              'SELECT DISTINCT provider_instance_memory_mb memory FROM capacity_pool_candidates'
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
