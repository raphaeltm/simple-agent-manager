import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const migrationSql = readFileSync(
  join(process.cwd(), 'src/db/migrations/0125_compute_pool_foundation.sql'),
  'utf8'
);
const candidateSnapshotMigrationSql = readFileSync(
  join(process.cwd(), 'src/db/migrations/0126_capacity_pool_candidate_snapshots.sql'),
  'utf8'
);
const concreteOfferingMigrationSql = readFileSync(
  join(process.cwd(), 'src/db/migrations/0127_concrete_capacity_pool_offerings.sql'),
  'utf8'
);

let sqlite: Database.Database | null = null;

function db(): Database.Database {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE github_installations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      installation_id TEXT NOT NULL UNIQUE,
      account_type TEXT NOT NULL,
      account_name TEXT NOT NULL
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      installation_id TEXT NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
      repository TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      credential_type TEXT NOT NULL DEFAULT 'cloud-provider',
      encrypted_token TEXT NOT NULL,
      iv TEXT NOT NULL
    );

    CREATE TABLE platform_credentials (
      id TEXT PRIMARY KEY,
      credential_type TEXT NOT NULL,
      provider TEXT,
      label TEXT NOT NULL,
      encrypted_token TEXT NOT NULL,
      iv TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL REFERENCES users(id)
    );

    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      vm_size TEXT NOT NULL DEFAULT 'medium',
      vm_location TEXT NOT NULL DEFAULT 'nbg1',
      cloud_provider TEXT,
      credential_source TEXT DEFAULT 'user',
      node_role TEXT NOT NULL DEFAULT 'workspace',
      runtime TEXT NOT NULL DEFAULT 'vm',
      node_class TEXT NOT NULL DEFAULT 'managed',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      repository TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT 'main',
      status TEXT NOT NULL DEFAULT 'pending',
      vm_size TEXT NOT NULL,
      vm_location TEXT NOT NULL,
      placement_explanation_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      placement_explanation_json TEXT,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  seedIdentity(sqlite);
  return sqlite;
}

function seedIdentity(database: Database.Database): void {
  database.exec(`
    INSERT INTO users (id) VALUES ('user-1'), ('user-2');

    INSERT INTO github_installations (id, user_id, installation_id, account_type, account_name)
    VALUES ('installation-1', 'user-1', '1001', 'User', 'sam-user');

    INSERT INTO projects (id, user_id, name, normalized_name, installation_id, repository, created_by)
    VALUES
      ('project-1', 'user-1', 'Project 1', 'project-1', 'installation-1', 'repo-1', 'user-1'),
      ('project-2', 'user-1', 'Project 2', 'project-2', 'installation-1', 'repo-2', 'user-1');

    INSERT INTO credentials (id, user_id, project_id, provider, encrypted_token, iv)
    VALUES
      ('credential-user-1', 'user-1', NULL, 'hetzner', 'ciphertext', 'iv'),
      ('credential-project-1', 'user-1', 'project-1', 'hetzner', 'ciphertext', 'iv');

    INSERT INTO platform_credentials
      (id, credential_type, provider, label, encrypted_token, iv, created_by)
    VALUES
      ('credential-platform-1', 'cloud-provider', 'hetzner', 'Platform Hetzner', 'ciphertext', 'iv', 'user-1');
  `);
}

function run(sql: string): void {
  sqlite?.prepare(sql).run();
}

function insertPool(values: {
  id: string;
  scope: 'installation' | 'user' | 'project';
  ownerUserId?: string;
  ownerProjectId?: string;
  isDefault?: 0 | 1;
  revision?: number;
}): void {
  sqlite
    ?.prepare(
      `
      INSERT INTO capacity_pools
        (id, scope, owner_user_id, owner_project_id, name, is_default, revision)
      VALUES
        (@id, @scope, @ownerUserId, @ownerProjectId, @id, @isDefault, @revision)
    `
    )
    .run({
      id: values.id,
      scope: values.scope,
      ownerUserId: values.ownerUserId ?? null,
      ownerProjectId: values.ownerProjectId ?? null,
      isDefault: values.isDefault ?? 0,
      revision: values.revision ?? 1,
    });
}

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

describe('0125_compute_pool_foundation migration', () => {
  it('is additive and leaves existing node/workspace/task rows valid with null pool snapshots', () => {
    const database = db();
    database.exec(`
      INSERT INTO nodes (id, user_id, name, status)
      VALUES ('node-existing', 'user-1', 'Existing node', 'running');

      INSERT INTO workspaces
        (id, node_id, project_id, user_id, name, repository, status, vm_size, vm_location, placement_explanation_json)
      VALUES
        ('workspace-existing', 'node-existing', 'project-1', 'user-1', 'Existing workspace', 'repo-1', 'running', 'medium', 'nbg1', '{"legacy":true}');

      INSERT INTO tasks
        (id, project_id, user_id, workspace_id, title, status, placement_explanation_json, created_by)
      VALUES
        ('task-existing', 'project-1', 'user-1', 'workspace-existing', 'Existing task', 'queued', '{"legacy":true}', 'user-1');
    `);

    database.exec(migrationSql);

    expect(
      database
        .prepare(
          `
          SELECT
            capacity_pool_id,
            capacity_pool_scope,
            capacity_pool_revision,
            capacity_source_id,
            placement_credential_source,
            placement_credential_reference,
            placement_credential_version,
            capacity_pool_project_id,
            workload_role,
            placement_explanation_json
          FROM nodes
          WHERE id = 'node-existing'
        `
        )
        .get()
    ).toEqual({
      capacity_pool_id: null,
      capacity_pool_scope: null,
      capacity_pool_revision: null,
      capacity_source_id: null,
      placement_credential_source: null,
      placement_credential_reference: null,
      placement_credential_version: null,
      capacity_pool_project_id: null,
      workload_role: null,
      placement_explanation_json: null,
    });

    expect(
      database
        .prepare(
          `
          SELECT
            capacity_pool_id,
            capacity_pool_scope,
            capacity_pool_revision,
            capacity_source_id,
            placement_credential_source,
            placement_credential_reference,
            placement_credential_version,
            capacity_pool_project_id,
            workload_role,
            placement_explanation_json
          FROM workspaces
          WHERE id = 'workspace-existing'
        `
        )
        .get()
    ).toEqual({
      capacity_pool_id: null,
      capacity_pool_scope: null,
      capacity_pool_revision: null,
      capacity_source_id: null,
      placement_credential_source: null,
      placement_credential_reference: null,
      placement_credential_version: null,
      capacity_pool_project_id: null,
      workload_role: null,
      placement_explanation_json: '{"legacy":true}',
    });

    expect(
      database
        .prepare(
          `
          SELECT
            capacity_pool_id,
            capacity_pool_scope,
            capacity_pool_revision,
            capacity_source_id,
            placement_credential_source,
            placement_credential_reference,
            placement_credential_version,
            capacity_pool_project_id,
            workload_role,
            placement_explanation_json
          FROM tasks
          WHERE id = 'task-existing'
        `
        )
        .get()
    ).toEqual({
      capacity_pool_id: null,
      capacity_pool_scope: null,
      capacity_pool_revision: null,
      capacity_source_id: null,
      placement_credential_source: null,
      placement_credential_reference: null,
      placement_credential_version: null,
      capacity_pool_project_id: null,
      workload_role: null,
      placement_explanation_json: '{"legacy":true}',
    });
  });

  it('allows multiple pools per scope while enforcing one default per owner/scope', () => {
    const database = db();
    database.exec(migrationSql);

    insertPool({ id: 'user-default-1', scope: 'user', ownerUserId: 'user-1', isDefault: 1 });
    insertPool({ id: 'user-non-default-1', scope: 'user', ownerUserId: 'user-1' });
    insertPool({ id: 'user-default-2', scope: 'user', ownerUserId: 'user-2', isDefault: 1 });
    insertPool({
      id: 'project-default-1',
      scope: 'project',
      ownerProjectId: 'project-1',
      isDefault: 1,
    });
    insertPool({ id: 'project-non-default-1', scope: 'project', ownerProjectId: 'project-1' });
    insertPool({ id: 'installation-default-1', scope: 'installation', isDefault: 1 });
    insertPool({ id: 'installation-non-default-1', scope: 'installation' });

    expect(() =>
      insertPool({ id: 'user-default-dupe', scope: 'user', ownerUserId: 'user-1', isDefault: 1 })
    ).toThrow();
    expect(() =>
      insertPool({
        id: 'project-default-dupe',
        scope: 'project',
        ownerProjectId: 'project-1',
        isDefault: 1,
      })
    ).toThrow();
    expect(() =>
      insertPool({ id: 'installation-default-dupe', scope: 'installation', isDefault: 1 })
    ).toThrow();

    const count = database.prepare('SELECT count(*) AS count FROM capacity_pools').get() as {
      count: number;
    };
    expect(count.count).toBe(7);
  });

  it('enforces pool owner shape by scope and revision bounds', () => {
    const database = db();
    database.exec(migrationSql);

    expect(() => insertPool({ id: 'user-without-owner', scope: 'user' })).toThrow();
    expect(() =>
      insertPool({ id: 'project-with-user-owner', scope: 'project', ownerUserId: 'user-1' })
    ).toThrow();
    expect(() =>
      insertPool({ id: 'installation-with-owner', scope: 'installation', ownerUserId: 'user-1' })
    ).toThrow();
    expect(() =>
      insertPool({ id: 'bad-revision', scope: 'user', ownerUserId: 'user-1', revision: 0 })
    ).toThrow();
  });

  it('stores cloud capacity sources as references to canonical credential rows only', () => {
    const database = db();
    database.exec(migrationSql);

    run(`
      INSERT INTO capacity_sources
        (id, scope, owner_user_id, source_kind, provider, credential_source, credential_id, credential_reference)
      VALUES
        ('source-user-credential', 'user', 'user-1', 'cloud-provider-credential', 'hetzner', 'user', 'credential-user-1', 'credentials:credential-user-1')
    `);
    run(`
      INSERT INTO capacity_sources
        (id, scope, owner_project_id, source_kind, provider, credential_source, credential_id, credential_reference)
      VALUES
        ('source-project-credential', 'project', 'project-1', 'cloud-provider-credential', 'hetzner', 'project', 'credential-project-1', 'credentials:credential-project-1')
    `);
    run(`
      INSERT INTO capacity_sources
        (id, scope, source_kind, provider, credential_source, platform_credential_id, credential_reference)
      VALUES
        ('source-platform-credential', 'installation', 'cloud-provider-credential', 'hetzner', 'platform', 'credential-platform-1', 'platform_credentials:credential-platform-1')
    `);
    run(`
      INSERT INTO capacity_sources
        (id, scope, owner_user_id, source_kind, external_source_ref)
      VALUES
        ('source-registered-runner', 'user', 'user-1', 'registered-runner', 'runner:runner-1')
    `);

    expect(() =>
      run(`
        INSERT INTO capacity_sources
          (id, scope, owner_user_id, source_kind, provider, credential_source)
        VALUES
          ('source-missing-credential', 'user', 'user-1', 'cloud-provider-credential', 'hetzner', 'user')
      `)
    ).toThrow();
    expect(() =>
      run(`
        INSERT INTO capacity_sources
          (id, scope, owner_user_id, source_kind, provider, credential_source, credential_id, platform_credential_id)
        VALUES
          ('source-both-credentials', 'user', 'user-1', 'cloud-provider-credential', 'hetzner', 'user', 'credential-user-1', 'credential-platform-1')
      `)
    ).toThrow();
    expect(() =>
      run(`
        INSERT INTO capacity_sources
          (id, scope, owner_user_id, source_kind, credential_source, credential_id)
        VALUES
          ('source-runner-with-credential', 'user', 'user-1', 'registered-runner', 'user', 'credential-user-1')
      `)
    ).toThrow();

    const stored = database
      .prepare(
        `
        SELECT capacity_sources.id AS id, credentials.encrypted_token, credentials.iv
        FROM capacity_sources
        LEFT JOIN credentials ON capacity_sources.credential_id = credentials.id
        WHERE capacity_sources.id = 'source-user-credential'
      `
      )
      .get() as { id: string; encrypted_token: string; iv: string };
    expect(stored).toEqual({
      id: 'source-user-credential',
      encrypted_token: 'ciphertext',
      iv: 'iv',
    });

    const sourceColumns = database
      .prepare(`PRAGMA table_info(capacity_sources)`)
      .all()
      .map((row) => (row as { name: string }).name);
    expect(sourceColumns).not.toContain('encrypted_token');
    expect(sourceColumns).not.toContain('iv');
  });

  it('supports pool candidates and future fallback-chain links without scheduler reads', () => {
    const database = db();
    database.exec(migrationSql);
    insertPool({ id: 'pool-primary', scope: 'user', ownerUserId: 'user-1', isDefault: 1 });
    insertPool({ id: 'pool-fallback', scope: 'user', ownerUserId: 'user-1' });
    run(`
      INSERT INTO capacity_sources
        (id, scope, owner_user_id, source_kind, provider, credential_source, credential_id)
      VALUES
        ('source-user-credential', 'user', 'user-1', 'cloud-provider-credential', 'hetzner', 'user', 'credential-user-1')
    `);

    run(`
      INSERT INTO capacity_pool_candidates
        (id, pool_id, capacity_source_id, provider, location, workload_role, runtime, machine_class, machine_size, priority, candidate_order)
      VALUES
        ('candidate-1', 'pool-primary', 'source-user-credential', 'hetzner', 'nbg1', 'workspace', 'vm', 'shared-vm', 'medium', 10, 0)
    `);
    run(`
      INSERT INTO capacity_pool_fallbacks (pool_id, fallback_pool_id, fallback_order, condition)
      VALUES ('pool-primary', 'pool-fallback', 0, 'capacity_exhausted')
    `);

    expect(() =>
      run(`
        INSERT INTO capacity_pool_fallbacks (pool_id, fallback_pool_id, fallback_order)
        VALUES ('pool-primary', 'pool-primary', 1)
      `)
    ).toThrow();

    const candidate = database
      .prepare(
        `
        SELECT provider, location, workload_role, runtime, machine_class, machine_size, priority, candidate_order
        FROM capacity_pool_candidates
        WHERE id = 'candidate-1'
      `
      )
      .get();
    expect(candidate).toEqual({
      provider: 'hetzner',
      location: 'nbg1',
      workload_role: 'workspace',
      runtime: 'vm',
      machine_class: 'shared-vm',
      machine_size: 'medium',
      priority: 10,
      candidate_order: 0,
    });
  });

  it('contains no destructive statements', () => {
    const sql = migrationSql.toUpperCase();
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('DELETE FROM');
    expect(sql).not.toContain('PRAGMA FOREIGN_KEYS = OFF');
    expect(sql).toContain('ALTER TABLE NODES ADD COLUMN CAPACITY_POOL_ID');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS CAPACITY_SOURCES');
  });
});

describe('0126_capacity_pool_candidate_snapshots migration', () => {
  it('adds nullable candidate snapshot columns and indexes without rewriting existing rows', () => {
    const database = db();
    database.exec(`
      INSERT INTO nodes (id, user_id, name, status)
      VALUES ('node-existing', 'user-1', 'Existing node', 'running');

      INSERT INTO workspaces
        (id, node_id, project_id, user_id, name, repository, status, vm_size, vm_location)
      VALUES
        ('workspace-existing', 'node-existing', 'project-1', 'user-1', 'Existing workspace', 'repo-1', 'running', 'medium', 'nbg1');

      INSERT INTO tasks
        (id, project_id, user_id, workspace_id, title, status, created_by)
      VALUES
        ('task-existing', 'project-1', 'user-1', 'workspace-existing', 'Existing task', 'queued', 'user-1');
    `);
    database.exec(migrationSql);
    database.exec(candidateSnapshotMigrationSql);

    for (const table of ['nodes', 'workspaces', 'tasks']) {
      const columns = database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => (row as { name: string }).name);
      expect(columns).toContain('capacity_pool_candidate_id');
      expect(
        database.prepare(`SELECT capacity_pool_candidate_id FROM ${table} LIMIT 1`).get()
      ).toEqual({ capacity_pool_candidate_id: null });
    }

    expect(
      database
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'index'
             AND name IN (
               'idx_nodes_capacity_pool_candidate',
               'idx_workspaces_capacity_pool_candidate',
               'idx_tasks_capacity_pool_candidate'
             )
           ORDER BY name`
        )
        .all()
    ).toEqual([
      { name: 'idx_nodes_capacity_pool_candidate' },
      { name: 'idx_tasks_capacity_pool_candidate' },
      { name: 'idx_workspaces_capacity_pool_candidate' },
    ]);
  });

  it('stores candidate IDs as snapshots rather than live candidate foreign keys', () => {
    const database = db();
    database.exec(migrationSql);
    database.exec(candidateSnapshotMigrationSql);
    database.exec(`
      INSERT INTO nodes (id, user_id, name, status, capacity_pool_candidate_id)
      VALUES ('node-snapshot', 'user-1', 'Snapshot node', 'running', 'deleted-candidate-id');
    `);

    expect(
      database
        .prepare(
          `SELECT capacity_pool_candidate_id
           FROM nodes
           WHERE id = 'node-snapshot'`
        )
        .get()
    ).toEqual({ capacity_pool_candidate_id: 'deleted-candidate-id' });
  });
});

describe('0127_concrete_capacity_pool_offerings migration', () => {
  it('adds nullable concrete offering columns without rewriting existing placement rows', () => {
    const database = db();
    database.exec(migrationSql);
    database.exec(candidateSnapshotMigrationSql);
    insertPool({ id: 'pool-primary', scope: 'user', ownerUserId: 'user-1', isDefault: 1 });
    run(`
      INSERT INTO capacity_sources
        (id, scope, owner_user_id, source_kind, provider, credential_source, credential_id)
      VALUES
        ('source-user-credential', 'user', 'user-1', 'cloud-provider-credential', 'hetzner', 'user', 'credential-user-1')
    `);
    run(`
      INSERT INTO capacity_pool_candidates
        (id, pool_id, capacity_source_id, provider, location, workload_role, runtime, machine_class, machine_size)
      VALUES
        ('candidate-legacy', 'pool-primary', 'source-user-credential', 'hetzner', 'nbg1', 'workspace', 'vm', 'shared-vm', 'medium')
    `);
    database.exec(`
      INSERT INTO nodes (id, user_id, name, status)
      VALUES ('node-existing', 'user-1', 'Existing node', 'running');

      INSERT INTO workspaces
        (id, node_id, project_id, user_id, name, repository, status, vm_size, vm_location)
      VALUES
        ('workspace-existing', 'node-existing', 'project-1', 'user-1', 'Existing workspace', 'repo-1', 'running', 'medium', 'nbg1');

      INSERT INTO tasks
        (id, project_id, user_id, workspace_id, title, status, created_by)
      VALUES
        ('task-existing', 'project-1', 'user-1', 'workspace-existing', 'Existing task', 'queued', 'user-1');
    `);

    database.exec(concreteOfferingMigrationSql);

    const offeringColumns = [
      'provider_instance_type',
      'provider_instance_vcpu_count',
      'provider_instance_memory_mb',
      'provider_instance_disk_gb',
      'provider_instance_price_display',
      'provider_instance_price_currency',
      'provider_instance_price_monthly_cents',
      'provider_instance_price_hourly_micros',
    ];

    for (const table of ['capacity_pool_candidates', 'nodes', 'workspaces', 'tasks']) {
      const columns = database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => (row as { name: string }).name);
      for (const column of offeringColumns) {
        expect(columns).toContain(column);
      }
    }

    expect(
      database
        .prepare(
          `
          SELECT ${offeringColumns.join(', ')}
          FROM capacity_pool_candidates
          WHERE id = 'candidate-legacy'
        `
        )
        .get()
    ).toEqual(Object.fromEntries(offeringColumns.map((column) => [column, null])));

    for (const table of ['nodes', 'workspaces', 'tasks']) {
      expect(
        database.prepare(`SELECT ${offeringColumns.join(', ')} FROM ${table} LIMIT 1`).get()
      ).toEqual(Object.fromEntries(offeringColumns.map((column) => [column, null])));
    }
  });

  it('contains no destructive statements', () => {
    const sql = concreteOfferingMigrationSql.toUpperCase();
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('DELETE FROM');
    expect(sql).not.toContain('PRAGMA FOREIGN_KEYS = OFF');
    expect(sql).toContain('ALTER TABLE CAPACITY_POOL_CANDIDATES ADD COLUMN PROVIDER_INSTANCE_TYPE');
    expect(sql).toContain('ALTER TABLE NODES ADD COLUMN PROVIDER_INSTANCE_TYPE');
  });
});
