import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(process.cwd(), 'src/db/migrations');
const migrations = readdirSync(migrationsDirectory)
  .filter((filename) => filename.endsWith('.sql'))
  .sort();
const archiveMigration = '0237_archive_reclaim_pending.sql';
const catalogMigration = '0239_capacity_catalog_publication.sql';

function apply(db: DatabaseSync, filenames: string[]): void {
  for (const filename of filenames) {
    try {
      db.exec(readFileSync(join(migrationsDirectory, filename), 'utf8'));
    } catch (cause) {
      throw new Error(`Real migration chain failed at ${filename}`, { cause });
    }
  }
}

function seedIdentity(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO users (id, email) VALUES ('owner', 'catalog-migration@example.test');
    INSERT INTO github_installations
      (id, user_id, installation_id, account_type, account_name)
      VALUES ('installation', 'owner', 'catalog-migration-installation', 'User', 'owner');
    INSERT INTO projects
      (id, user_id, name, normalized_name, installation_id, repository, created_by)
      VALUES ('project', 'owner', 'Catalog migration', 'catalog-migration',
              'installation', 'owner/catalog-migration', 'owner');
    INSERT INTO credentials (id, user_id, provider, encrypted_token, iv)
      VALUES ('credential', 'owner', 'hetzner', 'test-ciphertext', 'test-iv');
    INSERT INTO capacity_sources
      (id, scope, owner_user_id, source_kind, provider, credential_source,
       credential_id, credential_reference, source_generation, authority_generation)
      VALUES ('source', 'user', 'owner', 'cloud-provider-credential', 'hetzner', 'user',
              'credential', 'credentials:credential', 7, 3);
  `);
}

function insertPool(
  db: DatabaseSync,
  id: string,
  configuration: string,
  migration: string,
  reconciledAt: string | null = '2026-11-12T10:00:00.000Z'
): void {
  db.prepare(
    `
    INSERT INTO capacity_pools
      (id, scope, owner_user_id, name, revision, configuration_state, migration_state,
       last_reconciled_at, updated_at, selection_digest)
    VALUES (?, 'user', 'owner', ?, 31, ?, ?, ?, '2026-11-12T10:26:46.000Z', 'committed-digest')
  `
  ).run(id, id, configuration, migration, reconciledAt);
}

function insertArchive(db: DatabaseSync, id: string): void {
  db.prepare(
    `
    INSERT INTO project_data_archive_migrations
      (migration_id, project_id, session_id, state, source_owner_name, target_owner_name,
       target_generation, terminal_version_sha256, target_aggregate_sha256,
       r2_manifest_key, published_at, created_at, updated_at)
    VALUES (?, 'project', ?, 'published', 'project', 'archive-shard', 1,
            'terminal-proof', 'aggregate-proof', 'archive/manifest', 1700000000000,
            1699999999000, 1700000000000)
  `
  ).run(id, `session-${id}`);
}

function assertNewCatalogStorage(db: DatabaseSync, poolId: string): void {
  const payload = JSON.stringify({
    id: 'replacement',
    provider: 'hetzner',
    providerInstanceType: 'cx23',
    providerInstanceVcpuCount: 2,
    providerInstanceMemoryMb: 4096,
    location: 'nbg1',
  });
  db.prepare(
    `
    INSERT INTO capacity_pool_candidate_staging
      (id, pool_id, capacity_source_id, digest, ordinal, generation, payload)
    VALUES ('replacement', ?, 'source', 'replacement-digest', 0, 8, ?)
  `
  ).run(poolId, payload);
  db.prepare(
    `
    INSERT INTO capacity_pool_refreshes
      (pool_id, scope, owner_user_id, state, generation, attempts, started_at,
       deadline_at, next_attempt_at, last_success_at)
    VALUES (?, 'user', 'owner', 'pending', 8, 1, 1700000000000,
            1700007200000, 1700000015000, 1699999999000)
  `
  ).run(poolId);
  expect(db.prepare('SELECT * FROM capacity_pool_candidate_staging').all()).toEqual([
    {
      id: 'replacement',
      pool_id: poolId,
      capacity_source_id: 'source',
      digest: 'replacement-digest',
      ordinal: 0,
      generation: 8,
      payload,
    },
  ]);
  expect(db.prepare('SELECT * FROM capacity_pool_refreshes').all()).toEqual([
    {
      pool_id: poolId,
      scope: 'user',
      owner_user_id: 'owner',
      owner_project_id: null,
      state: 'pending',
      generation: 8,
      attempts: 1,
      started_at: 1700000000000,
      deadline_at: 1700007200000,
      next_attempt_at: 1700000015000,
      last_success_at: 1699999999000,
      last_error: null,
    },
  ]);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

describe('catalog publication on the current real migration chain', () => {
  it('supports a clean install with archive reclaim and private catalog staging', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys=ON');
      apply(db, migrations);
      seedIdentity(db);
      insertPool(db, 'bootstrap', 'migration-pending', 'pending');
      insertArchive(db, 'clean-archive');

      expect(db.prepare('SELECT catalog_published_at FROM capacity_pools').get()).toEqual({
        catalog_published_at: null,
      });
      expect(
        db.prepare('SELECT reclaim_pending FROM project_data_archive_migrations').get()
      ).toEqual({ reclaim_pending: 1 });
      assertNewCatalogStorage(db, 'bootstrap');
      expect(db.prepare('SELECT * FROM capacity_pool_candidates').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('upgrades past applied archive 0237 without losing reclaim or committed capacity evidence', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys=ON');
      const archiveIndex = migrations.indexOf(archiveMigration);
      const catalogIndex = migrations.indexOf(catalogMigration);
      if (archiveIndex < 0 || catalogIndex <= archiveIndex) {
        throw new Error('Expected the applied archive migration before catalog publication');
      }
      apply(db, migrations.slice(0, archiveIndex + 1));
      seedIdentity(db);
      insertArchive(db, 'reclaim-complete');
      insertArchive(db, 'reclaim-unconfirmed');
      db.exec(`UPDATE project_data_archive_migrations SET reclaim_pending = 0
               WHERE migration_id = 'reclaim-complete'`);
      insertPool(db, 'published', 'configured-ready', 'complete');
      insertPool(db, 'published-empty', 'configured-empty', 'complete', null);
      insertPool(db, 'bootstrap', 'migration-pending', 'pending');
      insertPool(db, 'incomplete', 'configured-ready', 'pending');
      insertPool(db, 'unvalidated', 'migration-pending', 'complete');
      db.exec(`
        INSERT INTO capacity_pool_candidates
          (id, pool_id, capacity_source_id, provider, location, runtime,
           provider_instance_type, provider_instance_vcpu_count,
           provider_instance_memory_mb, catalog_generation)
        VALUES ('committed', 'published', 'source', 'hetzner', 'nbg1', 'vm',
                'cx23', 2, 4096, 7);
      `);
      const archiveBefore = db
        .prepare('SELECT * FROM project_data_archive_migrations ORDER BY migration_id')
        .all();
      const sourcesBefore = db.prepare('SELECT * FROM capacity_sources').all();
      const candidatesBefore = db.prepare('SELECT * FROM capacity_pool_candidates').all();
      const poolsBefore = db.prepare('SELECT * FROM capacity_pools ORDER BY id').all();

      apply(db, migrations.slice(archiveIndex + 1));

      expect(
        db.prepare('SELECT * FROM project_data_archive_migrations ORDER BY migration_id').all()
      ).toEqual(archiveBefore);
      expect(db.prepare('SELECT * FROM capacity_sources').all()).toEqual(sourcesBefore);
      expect(db.prepare('SELECT * FROM capacity_pool_candidates').all()).toEqual(candidatesBefore);
      const poolsAfter = db.prepare('SELECT * FROM capacity_pools ORDER BY id').all();
      expect(poolsAfter.map(({ catalog_published_at: _proof, ...pool }) => pool)).toEqual(
        poolsBefore
      );
      expect(
        db.prepare('SELECT id, catalog_published_at FROM capacity_pools ORDER BY id').all()
      ).toEqual([
        { id: 'bootstrap', catalog_published_at: null },
        { id: 'incomplete', catalog_published_at: null },
        { id: 'published', catalog_published_at: '2026-11-12T10:00:00.000Z' },
        { id: 'published-empty', catalog_published_at: '2026-11-12T10:26:46.000Z' },
        { id: 'unvalidated', catalog_published_at: null },
      ]);
      assertNewCatalogStorage(db, 'published');
      expect(
        db.prepare('SELECT id, catalog_generation FROM capacity_pool_candidates').all()
      ).toEqual([{ id: 'committed', catalog_generation: 7 }]);
    } finally {
      db.close();
    }
  });
});
