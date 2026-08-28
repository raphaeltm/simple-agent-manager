import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  getDefaultLocationForProvider,
  getLocationsForProvider,
  VM_SIZE_LABELS,
} from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import {
  backfillDefaultCapacityPoolsForExistingCredentials,
  ensureDefaultCapacityPoolsForExistingCredentials,
  resolveEffectiveDefaultCapacityPoolSummary,
} from '../../../src/services/default-capacity-pools';

const migrationSql = readFileSync(
  join(process.cwd(), 'src/db/migrations/0125_compute_pool_foundation.sql'),
  'utf8'
);

let sqlite: Database.Database | null = null;

function createDb() {
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
      agent_type TEXT,
      credential_kind TEXT NOT NULL DEFAULT 'api-key',
      is_active INTEGER NOT NULL DEFAULT 1,
      encrypted_token TEXT NOT NULL,
      iv TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE platform_credentials (
      id TEXT PRIMARY KEY,
      credential_type TEXT NOT NULL,
      provider TEXT,
      agent_type TEXT,
      credential_kind TEXT NOT NULL DEFAULT 'api-key',
      label TEXT NOT NULL,
      encrypted_token TEXT NOT NULL,
      iv TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  seedIdentity();
  sqlite.exec(migrationSql);
  return drizzle(sqlite, { schema });
}

function seedIdentity(): void {
  sqlite?.exec(`
    INSERT INTO users (id) VALUES ('user-1'), ('user-2'), ('admin-1');

    INSERT INTO github_installations (id, user_id, installation_id, account_type, account_name)
    VALUES ('installation-1', 'user-1', '1001', 'User', 'sam-user');

    INSERT INTO projects (id, user_id, name, normalized_name, installation_id, repository, created_by)
    VALUES
      ('project-1', 'user-1', 'Project 1', 'project-1', 'installation-1', 'repo-1', 'user-1'),
      ('project-2', 'user-1', 'Project 2', 'project-2', 'installation-1', 'repo-2', 'user-1');
  `);
}

function seedUserCredential(input: {
  id: string;
  userId?: string;
  projectId?: string | null;
  provider?: string;
  isActive?: 0 | 1;
  updatedAt?: string;
}): void {
  sqlite
    ?.prepare(
      `
      INSERT INTO credentials (
        id, user_id, project_id, provider, credential_type, is_active,
        encrypted_token, iv, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 'cloud-provider', ?, 'ciphertext-secret', 'iv-secret', ?, ?)
    `
    )
    .run(
      input.id,
      input.userId ?? 'user-1',
      input.projectId ?? null,
      input.provider ?? 'hetzner',
      input.isActive ?? 1,
      '2026-08-28T00:00:00.000Z',
      input.updatedAt ?? '2026-08-28T00:00:00.000Z'
    );
}

function seedPlatformCredential(input: {
  id: string;
  provider?: string | null;
  isEnabled?: 0 | 1;
  updatedAt?: string;
}): void {
  sqlite
    ?.prepare(
      `
      INSERT INTO platform_credentials (
        id, credential_type, provider, label, encrypted_token, iv, is_enabled,
        created_by, created_at, updated_at
      )
      VALUES (?, 'cloud-provider', ?, ?, 'platform-ciphertext', 'platform-iv', ?, 'admin-1', ?, ?)
    `
    )
    .run(
      input.id,
      input.provider ?? 'hetzner',
      `${input.provider ?? 'hetzner'} platform`,
      input.isEnabled ?? 1,
      '2026-08-28T00:00:00.000Z',
      input.updatedAt ?? '2026-08-28T00:00:00.000Z'
    );
}

function getCount(table: string, where = '1 = 1'): number {
  return (sqlite?.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as {
    count: number;
  }).count;
}

function getRows<T>(sql: string): T[] {
  return sqlite?.prepare(sql).all() as T[];
}

function expectedCandidateCount(provider: 'hetzner' | 'vultr' | 'digitalocean'): number {
  return getLocationsForProvider(provider).length * Object.keys(VM_SIZE_LABELS).length;
}

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

describe('default capacity pool creation', () => {
  it('lazily creates project, user, and installation default records from legacy no-pool state', async () => {
    const db = createDb();
    seedPlatformCredential({ id: 'platform-hetzner' });
    seedUserCredential({ id: 'user-hetzner' });
    seedUserCredential({ id: 'project-hetzner', projectId: 'project-1' });

    const effective = await resolveEffectiveDefaultCapacityPoolSummary(db as never, {
      userId: 'user-1',
      projectId: 'project-1',
    });

    expect(effective?.pool.scope).toBe('project');
    expect(effective?.sources).toHaveLength(1);
    expect(effective?.sources[0]).toMatchObject({
      scope: 'project',
      ownerUserId: null,
      ownerProjectId: 'project-1',
      provider: 'hetzner',
      credentialSource: 'project',
      credentialId: 'project-hetzner',
      platformCredentialId: null,
      credentialReference: 'credentials:project-hetzner',
      credentialVersion: Date.parse('2026-08-28T00:00:00.000Z'),
      status: 'active',
    });
    expect(effective?.activeCandidateCount).toBe(expectedCandidateCount('hetzner'));

    expect(getCount('capacity_pools')).toBe(3);
    expect(getCount('capacity_sources')).toBe(3);
    expect(getCount('capacity_pool_candidates')).toBe(expectedCandidateCount('hetzner') * 3);
    expect(
      getRows<{
        scope: string;
        credential_source: string;
        credential_id: string | null;
        platform_credential_id: string | null;
        credential_reference: string;
      }>(`
        SELECT scope, credential_source, credential_id, platform_credential_id, credential_reference
        FROM capacity_sources
        WHERE scope = 'installation'
      `)[0]
    ).toEqual({
      scope: 'installation',
      credential_source: 'platform',
      credential_id: null,
      platform_credential_id: 'platform-hetzner',
      credential_reference: 'platform_credentials:platform-hetzner',
    });

    const sourceColumns = Object.keys(
      getRows<Record<string, unknown>>('SELECT * FROM capacity_sources LIMIT 1')[0] ?? {}
    );
    expect(sourceColumns).not.toContain('encrypted_token');
    expect(sourceColumns).not.toContain('iv');
  });

  it('is idempotent across repeated ensures', async () => {
    const db = createDb();
    seedPlatformCredential({ id: 'platform-hetzner' });
    seedUserCredential({ id: 'user-hetzner' });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, { userId: 'user-1' });
    const firstCounts = {
      pools: getCount('capacity_pools'),
      sources: getCount('capacity_sources'),
      candidates: getCount('capacity_pool_candidates'),
    };

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, { userId: 'user-1' });

    expect({
      pools: getCount('capacity_pools'),
      sources: getCount('capacity_sources'),
      candidates: getCount('capacity_pool_candidates'),
    }).toEqual(firstCounts);
  });

  it('keeps one default pool per scope while allowing multiple credential-backed sources', async () => {
    const db = createDb();
    seedPlatformCredential({ id: 'platform-hetzner' });
    seedUserCredential({ id: 'user-hetzner' });
    seedUserCredential({ id: 'user-vultr', provider: 'vultr' });
    seedUserCredential({ id: 'project-hetzner', projectId: 'project-1' });
    seedUserCredential({ id: 'project-vultr', projectId: 'project-1', provider: 'vultr' });

    const result = await backfillDefaultCapacityPoolsForExistingCredentials(db as never);

    expect(result.usersEnsured).toBe(1);
    expect(result.projectsEnsured).toBe(1);
    expect(
      getRows<{ scope: string; defaults: number }>(`
        SELECT scope, COUNT(*) AS defaults
        FROM capacity_pools
        WHERE is_default = 1
        GROUP BY scope
        ORDER BY scope
      `)
    ).toEqual([
      { scope: 'installation', defaults: 1 },
      { scope: 'project', defaults: 1 },
      { scope: 'user', defaults: 1 },
    ]);
    expect(getCount('capacity_sources', "scope = 'user'")).toBe(2);
    expect(getCount('capacity_sources', "scope = 'project'")).toBe(2);
  });

  it('does not seed project pools from personal user credentials', async () => {
    const db = createDb();
    seedPlatformCredential({ id: 'platform-hetzner' });
    seedUserCredential({ id: 'personal-hetzner' });

    const effective = await resolveEffectiveDefaultCapacityPoolSummary(db as never, {
      userId: 'user-1',
      projectId: 'project-2',
    });

    expect(effective?.pool.scope).toBe('user');
    expect(getCount('capacity_pools', "scope = 'project' AND owner_project_id = 'project-2'")).toBe(
      0
    );
    expect(getCount('capacity_sources', "scope = 'project'")).toBe(0);
  });

  it('generates candidates from provider location and VM-size catalogs with provider default first', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-vultr', provider: 'vultr' });

    const result = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });

    expect(result.user?.activeCandidateCount).toBe(expectedCandidateCount('vultr'));
    expect(
      getRows<{ location: string; machine_size: string; candidate_order: number }>(`
        SELECT location, machine_size, candidate_order
        FROM capacity_pool_candidates
        ORDER BY candidate_order
        LIMIT 3
      `)
    ).toEqual([
      { location: getDefaultLocationForProvider('vultr'), machine_size: 'small', candidate_order: 0 },
      { location: getDefaultLocationForProvider('vultr'), machine_size: 'medium', candidate_order: 1 },
      { location: getDefaultLocationForProvider('vultr'), machine_size: 'large', candidate_order: 2 },
    ]);
  });

  it('disables pool availability when a backing credential is disabled', async () => {
    const db = createDb();
    seedPlatformCredential({ id: 'platform-hetzner' });
    seedUserCredential({ id: 'user-hetzner' });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, { userId: 'user-1' });
    sqlite
      ?.prepare("UPDATE credentials SET is_active = 0, updated_at = ? WHERE id = 'user-hetzner'")
      .run('2026-08-28T01:00:00.000Z');

    const effective = await resolveEffectiveDefaultCapacityPoolSummary(db as never, {
      userId: 'user-1',
    });

    expect(effective?.pool.scope).toBe('installation');
    expect(
      getRows<{ source_status: string; candidate_status: string; pool_status: string }>(`
        SELECT src.status AS source_status, cand.status AS candidate_status, pool.status AS pool_status
        FROM capacity_pools pool
        JOIN capacity_pool_candidates cand ON cand.pool_id = pool.id
        JOIN capacity_sources src ON src.id = cand.capacity_source_id
        WHERE pool.scope = 'user'
        LIMIT 1
      `)[0]
    ).toEqual({
      source_status: 'disabled',
      candidate_status: 'disabled',
      pool_status: 'disabled',
    });
  });

  it('disables an empty default pool after backing credential deletion cascades sources', async () => {
    const db = createDb();
    seedPlatformCredential({ id: 'platform-hetzner' });
    seedUserCredential({ id: 'user-hetzner' });
    seedUserCredential({ id: 'project-hetzner', projectId: 'project-1' });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      projectId: 'project-1',
    });
    sqlite?.prepare("DELETE FROM credentials WHERE id = 'project-hetzner'").run();

    const effective = await resolveEffectiveDefaultCapacityPoolSummary(db as never, {
      userId: 'user-1',
      projectId: 'project-1',
    });

    expect(effective?.pool.scope).toBe('user');
    expect(getCount('capacity_sources', "credential_id = 'project-hetzner'")).toBe(0);
    expect(
      getRows<{ status: string }>(
        "SELECT status FROM capacity_pools WHERE scope = 'project' AND owner_project_id = 'project-1'"
      )[0]
    ).toEqual({ status: 'disabled' });
  });
});
