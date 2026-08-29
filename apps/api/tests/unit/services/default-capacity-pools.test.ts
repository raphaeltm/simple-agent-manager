import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getProviderInstanceOfferings } from '@simple-agent-manager/providers';
import {
  getDefaultLocationForProvider,
  getLocationsForProvider,
} from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { updateDefaultCapacityPool } from '../../../src/services/default-capacity-pool-updates';
import {
  backfillDefaultCapacityPoolsForExistingCredentials,
  ensureDefaultCapacityPoolsForExistingCredentials,
  resolveEffectiveDefaultCapacityPoolSummary,
} from '../../../src/services/default-capacity-pools';
import {
  capacityPlacementSnapshotForTaskStart,
  PlacementResolutionError,
  resolveCapacityAwareCredentialLookup,
  resolveTaskStartCapacityPoolSelection,
  resolveTaskStartPlacement,
} from '../../../src/services/placement-resolver';

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
const candidateCatalogMetadataMigrationSql = readFileSync(
  join(process.cwd(), 'src/db/migrations/0128_capacity_pool_candidate_catalog_metadata.sql'),
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
  sqlite.exec(candidateSnapshotMigrationSql);
  sqlite.exec(concreteOfferingMigrationSql);
  sqlite.exec(candidateCatalogMetadataMigrationSql);
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
  return (
    sqlite?.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as {
      count: number;
    }
  ).count;
}

function getRows<T>(sql: string): T[] {
  return sqlite?.prepare(sql).all() as T[];
}

function expectedCandidateCount(provider: 'hetzner' | 'vultr' | 'digitalocean'): number {
  return getLocationsForProvider(provider).length * getProviderInstanceOfferings(provider).length;
}

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

describe('default capacity pool creation', () => {
  it('creates project, user, and installation default records from legacy no-pool state when ensure is requested', async () => {
    const db = createDb();
    seedPlatformCredential({ id: 'platform-hetzner' });
    seedUserCredential({ id: 'user-hetzner' });
    seedUserCredential({ id: 'project-hetzner', projectId: 'project-1' });

    const effective = await resolveEffectiveDefaultCapacityPoolSummary(db as never, {
      userId: 'user-1',
      projectId: 'project-1',
      ensure: true,
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

  it('is read-only by default: does not ensure pools unless ensure is requested', async () => {
    const db = createDb();
    seedPlatformCredential({ id: 'platform-hetzner' });
    seedUserCredential({ id: 'user-hetzner' });
    seedUserCredential({ id: 'project-hetzner', projectId: 'project-1' });

    const effective = await resolveEffectiveDefaultCapacityPoolSummary(db as never, {
      userId: 'user-1',
      projectId: 'project-1',
    });

    expect(effective).toBeNull();
    expect(getCount('capacity_pools')).toBe(0);
    expect(getCount('capacity_sources')).toBe(0);
    expect(getCount('capacity_pool_candidates')).toBe(0);
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
      ensure: true,
    });

    expect(effective?.pool.scope).toBe('user');
    expect(getCount('capacity_pools', "scope = 'project' AND owner_project_id = 'project-2'")).toBe(
      0
    );
    expect(getCount('capacity_sources', "scope = 'project'")).toBe(0);
  });

  it('generates candidates from provider-native offerings with provider default location first', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-vultr', provider: 'vultr' });

    const result = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });

    expect(result.user?.activeCandidateCount).toBe(expectedCandidateCount('vultr'));
    expect(
      getRows<{
        id: string;
        location: string;
        machine_size: string;
        provider_instance_type: string;
        provider_instance_sku: string | null;
        provider_instance_display_name: string;
        provider_instance_vcpu_count: number;
        provider_instance_memory_mb: number;
        provider_instance_disk_gb: number;
        provider_instance_price_currency: string;
        provider_instance_price_monthly_cents: number;
        provider_instance_catalog_source: string;
        provider_instance_catalog_last_seen_at: string | null;
        candidate_order: number;
      }>(`
        SELECT
          id,
          location,
          machine_size,
          provider_instance_type,
          provider_instance_sku,
          provider_instance_display_name,
          provider_instance_vcpu_count,
          provider_instance_memory_mb,
          provider_instance_disk_gb,
          provider_instance_price_currency,
          provider_instance_price_monthly_cents,
          provider_instance_catalog_source,
          provider_instance_catalog_last_seen_at,
          candidate_order
        FROM capacity_pool_candidates
        ORDER BY candidate_order
        LIMIT 3
      `)
    ).toEqual([
      {
        id: expect.stringContaining(':vc2-2c-4gb'),
        location: getDefaultLocationForProvider('vultr'),
        machine_size: 'small',
        provider_instance_type: 'vc2-2c-4gb',
        provider_instance_sku: null,
        provider_instance_display_name: 'vc2-2c-4gb · 2 vCPU · 4 GB RAM · 80 GB disk',
        provider_instance_vcpu_count: 2,
        provider_instance_memory_mb: 4096,
        provider_instance_disk_gb: 80,
        provider_instance_price_currency: 'USD',
        provider_instance_price_monthly_cents: 2000,
        provider_instance_catalog_source: 'static',
        provider_instance_catalog_last_seen_at: null,
        candidate_order: 0,
      },
      {
        id: expect.stringContaining(':vc2-4c-8gb'),
        location: getDefaultLocationForProvider('vultr'),
        machine_size: 'medium',
        provider_instance_type: 'vc2-4c-8gb',
        provider_instance_sku: null,
        provider_instance_display_name: 'vc2-4c-8gb · 4 vCPU · 8 GB RAM · 160 GB disk',
        provider_instance_vcpu_count: 4,
        provider_instance_memory_mb: 8192,
        provider_instance_disk_gb: 160,
        provider_instance_price_currency: 'USD',
        provider_instance_price_monthly_cents: 4000,
        provider_instance_catalog_source: 'static',
        provider_instance_catalog_last_seen_at: null,
        candidate_order: 1,
      },
      {
        id: expect.stringContaining(':vc2-6c-16gb'),
        location: getDefaultLocationForProvider('vultr'),
        machine_size: 'large',
        provider_instance_type: 'vc2-6c-16gb',
        provider_instance_sku: null,
        provider_instance_display_name: 'vc2-6c-16gb · 6 vCPU · 16 GB RAM · 320 GB disk',
        provider_instance_vcpu_count: 6,
        provider_instance_memory_mb: 16384,
        provider_instance_disk_gb: 320,
        provider_instance_price_currency: 'USD',
        provider_instance_price_monthly_cents: 8000,
        provider_instance_catalog_source: 'static',
        provider_instance_catalog_last_seen_at: null,
        candidate_order: 2,
      },
    ]);
  });

  it('preserves existing candidate priority and order during default reconciliation', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-vultr', provider: 'vultr' });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });

    const [candidate] = getRows<{
      id: string;
      provider_instance_type: string;
    }>(`
      SELECT id, provider_instance_type
      FROM capacity_pool_candidates
      WHERE provider_instance_type = 'vc2-4c-8gb'
      LIMIT 1
    `);
    expect(candidate).toBeDefined();

    sqlite
      ?.prepare(
        `
        UPDATE capacity_pool_candidates
        SET priority = 42, candidate_order = 17
        WHERE id = ?
      `
      )
      .run(candidate?.id);

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });

    expect(
      sqlite
        ?.prepare(
          `
          SELECT priority, candidate_order
          FROM capacity_pool_candidates
          WHERE id = ?
        `
        )
        .all(candidate?.id)
    ).toEqual([{ priority: 42, candidate_order: 17 }]);
  });

  it('preserves pre-native legacy size candidate removals when reconciling native offerings', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });

    const poolId = 'cap-pool-default:user:user-1';
    const sourceId = 'cap-source-default:user:user-hetzner';
    const legacyCandidateId = `cap-candidate-default:${poolId}:${sourceId}:hetzner:fsn1:small`;
    sqlite
      ?.prepare(
        `
        INSERT INTO capacity_pools (
          id, scope, owner_user_id, name, is_default, revision, status,
          strategy, exhaustion_policy, created_by
        )
        VALUES (?, 'user', 'user-1', 'User default', 1, 1, 'active', 'balanced', 'queue', 'user-1')
      `
      )
      .run(poolId);
    sqlite
      ?.prepare(
        `
        INSERT INTO capacity_sources (
          id, scope, owner_user_id, source_kind, provider, credential_source,
          credential_id, credential_reference, status, created_by
        )
        VALUES (?, 'user', 'user-1', 'cloud-provider-credential', 'hetzner', 'user',
          'user-hetzner', 'credentials:user-hetzner', 'active', 'user-1')
      `
      )
      .run(sourceId);
    sqlite
      ?.prepare(
        `
        INSERT INTO capacity_pool_candidates (
          id, pool_id, capacity_source_id, provider, location, workload_role,
          runtime, machine_class, machine_size, status
        )
        VALUES (?, ?, ?, 'hetzner', 'fsn1', 'workspace', 'vm', 'shared-vm', 'small', 'deleted')
      `
      )
      .run(legacyCandidateId, poolId, sourceId);

    const reconciled = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });

    const nativeCandidateId = `cap-candidate-default:${poolId}:${sourceId}:hetzner:fsn1:cx23`;
    expect(reconciled.user?.activeCandidateCount).toBe(expectedCandidateCount('hetzner') - 1);
    const preservedRows = getRows<{
      id: string;
      status: string;
      provider_instance_type: string | null;
      provider_instance_display_name: string | null;
      provider_instance_catalog_source: string | null;
    }>(`
        SELECT
          id,
          status,
          provider_instance_type,
          provider_instance_display_name,
          provider_instance_catalog_source
        FROM capacity_pool_candidates
        WHERE id IN ('${legacyCandidateId}', '${nativeCandidateId}')
        ORDER BY id
      `);
    expect(preservedRows).toEqual(
      expect.arrayContaining([
        {
          id: legacyCandidateId,
          status: 'deleted',
          provider_instance_type: null,
          provider_instance_display_name: null,
          provider_instance_catalog_source: null,
        },
        {
          id: nativeCandidateId,
          status: 'deleted',
          provider_instance_type: 'cx23',
          provider_instance_display_name: 'cx23 · 2 vCPU · 4 GB RAM · 40 GB disk',
          provider_instance_catalog_source: 'static',
        },
      ])
    );
  });

  it('orders effective default-pool candidates by the selected v1 strategy', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-vultr', provider: 'vultr' });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });

    const placement = resolveTaskStartPlacement({
      entryPoint: 'task-submit',
      taskId: 'strategy-task',
      projectId: 'project-1',
      userId: 'user-1',
      project: {
        id: 'project-1',
        defaultProvider: 'vultr',
        defaultLocation: getDefaultLocationForProvider('vultr'),
        defaultVmSize: 'small',
      },
      credentialProjectPolicy: 'current-project-unless-inherited',
      taskModeDefault: 'task',
      resourceRequirements: {},
    });

    sqlite?.prepare("UPDATE capacity_pools SET strategy = 'pack' WHERE scope = 'user'").run();
    const packSelection = await resolveTaskStartCapacityPoolSelection(db as never, placement, {
      ensure: false,
    });

    expect(packSelection?.strategy).toBe('pack');
    expect(packSelection?.candidates[0]).toMatchObject({
      provider: 'vultr',
      location: getDefaultLocationForProvider('vultr'),
      providerInstanceType: 'vc2-6c-16gb',
      providerInstanceVcpuCount: 6,
      providerInstanceMemoryMb: 16 * 1024,
    });

    sqlite
      ?.prepare("UPDATE capacity_pools SET strategy = 'smallest-fit' WHERE scope = 'user'")
      .run();
    const smallestFitSelection = await resolveTaskStartCapacityPoolSelection(
      db as never,
      placement,
      { ensure: false }
    );

    expect(smallestFitSelection?.strategy).toBe('smallest-fit');
    expect(smallestFitSelection?.candidates[0]).toMatchObject({
      provider: 'vultr',
      location: getDefaultLocationForProvider('vultr'),
      providerInstanceType: 'vc2-2c-4gb',
      providerInstanceVcpuCount: 2,
      providerInstanceMemoryMb: 4 * 1024,
    });
  });

  it('rejects undersized concrete offerings using normalized reservation resources', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-vultr', provider: 'vultr' });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });
    sqlite
      ?.prepare("UPDATE capacity_pools SET strategy = 'smallest-fit' WHERE scope = 'user'")
      .run();

    const placement = resolveTaskStartPlacement({
      entryPoint: 'task-submit',
      taskId: 'resource-heavy-task',
      projectId: 'project-1',
      userId: 'user-1',
      project: {
        id: 'project-1',
        defaultProvider: 'vultr',
        defaultLocation: getDefaultLocationForProvider('vultr'),
        defaultVmSize: 'small',
      },
      credentialProjectPolicy: 'current-project-unless-inherited',
      taskModeDefault: 'task',
      resourceRequirements: {
        task: { minVcpu: 5, minMemoryGb: 12 },
      },
    });

    const selection = await resolveTaskStartCapacityPoolSelection(db as never, placement, {
      ensure: false,
    });

    expect(selection?.candidates.length).toBeGreaterThan(0);
    expect(
      selection?.candidates.every((candidate) => candidate.providerInstanceVcpuCount >= 5)
    ).toBe(true);
    expect(
      selection?.candidates.every((candidate) => candidate.providerInstanceMemoryMb >= 12 * 1024)
    ).toBe(true);
    expect(selection?.candidates[0]).toMatchObject({
      providerInstanceType: 'vc2-6c-16gb',
      machineSize: 'large',
    });
  });

  it('returns an authoritative empty selection when no concrete offering satisfies resources', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-vultr', provider: 'vultr' });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });

    const placement = resolveTaskStartPlacement({
      entryPoint: 'task-submit',
      taskId: 'resource-too-heavy-task',
      projectId: 'project-1',
      userId: 'user-1',
      project: {
        id: 'project-1',
        defaultProvider: 'vultr',
        defaultLocation: getDefaultLocationForProvider('vultr'),
        defaultVmSize: 'small',
      },
      credentialProjectPolicy: 'current-project-unless-inherited',
      taskModeDefault: 'task',
      resourceRequirements: {
        task: { minVcpu: 128, minMemoryGb: 512 },
      },
    });

    const selection = await resolveTaskStartCapacityPoolSelection(db as never, placement, {
      ensure: false,
    });

    expect(selection).toMatchObject({
      scope: 'user',
      poolId: 'cap-pool-default:user:user-1',
      candidates: [],
    });
    expect(capacityPlacementSnapshotForTaskStart(selection)).toMatchObject({
      capacityPoolId: 'cap-pool-default:user:user-1',
      capacityPoolCandidateId: null,
      capacitySourceId: null,
    });
  });

  it('keeps capacity candidates aligned with the resolved provider and explicit location', async () => {
    const providerMismatchDb = createDb();
    const providerMismatchSqlite = sqlite;
    seedUserCredential({ id: 'user-vultr', provider: 'vultr' });
    await ensureDefaultCapacityPoolsForExistingCredentials(providerMismatchDb as never, {
      userId: 'user-1',
      includeInstallation: false,
    });

    const hetznerPlacement = resolveTaskStartPlacement({
      entryPoint: 'task-submit',
      taskId: 'candidate-provider-mismatch-task',
      projectId: 'project-1',
      userId: 'user-1',
      project: {
        id: 'project-1',
        defaultProvider: 'hetzner',
        defaultLocation: 'fsn1',
        defaultVmSize: 'small',
      },
      explicit: { provider: 'hetzner' },
      credentialProjectPolicy: 'current-project-unless-inherited',
      taskModeDefault: 'task',
      resourceRequirements: {},
    });

    const providerMismatchSelection = await resolveTaskStartCapacityPoolSelection(
      providerMismatchDb as never,
      hetznerPlacement,
      { ensure: false }
    );
    expect(providerMismatchSelection?.poolId).toBe('cap-pool-default:user:user-1');
    expect(providerMismatchSelection?.candidates).toHaveLength(0);
    expect(() =>
      resolveCapacityAwareCredentialLookup(hetznerPlacement, providerMismatchSelection)
    ).toThrow(PlacementResolutionError);
    providerMismatchSqlite?.close();
    sqlite = null;

    const locationDb = createDb();
    seedUserCredential({ id: 'user-hetzner', provider: 'hetzner' });
    await ensureDefaultCapacityPoolsForExistingCredentials(locationDb as never, {
      userId: 'user-1',
      includeInstallation: false,
    });
    const hetznerLocations = getLocationsForProvider('hetzner').map((location) => location.id);
    const explicitLocation = hetznerLocations.find((location) => location !== 'fsn1') ?? 'hel1';

    const flexiblePlacement = resolveTaskStartPlacement({
      entryPoint: 'task-submit',
      taskId: 'candidate-flexible-location-task',
      projectId: 'project-1',
      userId: 'user-1',
      project: {
        id: 'project-1',
        defaultProvider: 'hetzner',
        defaultLocation: 'fsn1',
        defaultVmSize: 'small',
      },
      credentialProjectPolicy: 'current-project-unless-inherited',
      taskModeDefault: 'task',
      resourceRequirements: {},
    });
    const flexibleSelection = await resolveTaskStartCapacityPoolSelection(
      locationDb as never,
      flexiblePlacement,
      { ensure: false }
    );
    expect(new Set(flexibleSelection?.candidates.map((candidate) => candidate.location)).size).toBe(
      hetznerLocations.length
    );

    const explicitLocationPlacement = resolveTaskStartPlacement({
      entryPoint: 'task-submit',
      taskId: 'candidate-explicit-location-task',
      projectId: 'project-1',
      userId: 'user-1',
      project: {
        id: 'project-1',
        defaultProvider: 'hetzner',
        defaultLocation: 'fsn1',
        defaultVmSize: 'small',
      },
      explicit: { vmLocation: explicitLocation },
      credentialProjectPolicy: 'current-project-unless-inherited',
      taskModeDefault: 'task',
      resourceRequirements: {},
    });
    const explicitLocationSelection = await resolveTaskStartCapacityPoolSelection(
      locationDb as never,
      explicitLocationPlacement,
      { ensure: false }
    );

    expect(explicitLocationSelection?.candidates.length).toBeGreaterThan(0);
    expect(
      explicitLocationSelection?.candidates.every(
        (candidate) => candidate.location === explicitLocation
      )
    ).toBe(true);
  });

  it('preserves disabled and removed candidates across reconciliation and excludes them from placement', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });

    const ensured = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });
    const usCandidates =
      ensured.user?.candidates.filter(
        (candidate) => candidate.location === 'ash' || candidate.location === 'hil'
      ) ?? [];
    expect(usCandidates.length).toBeGreaterThan(0);
    const removedCandidate = usCandidates.find((candidate) => candidate.location === 'ash');
    expect(removedCandidate).toBeDefined();
    sqlite
      ?.prepare(
        `
        INSERT INTO nodes (
          id,
          user_id,
          name,
          status,
          vm_size,
          vm_location,
          cloud_provider,
          capacity_pool_id,
          capacity_pool_scope,
          capacity_pool_revision,
          capacity_source_id,
          capacity_pool_candidate_id,
          provider_instance_type,
          provider_instance_vcpu_count,
          provider_instance_memory_mb,
          provider_instance_disk_gb,
          provider_instance_price_display,
          provider_instance_price_currency,
          provider_instance_price_monthly_cents,
          provider_instance_price_hourly_micros
        )
        VALUES (?, 'user-1', 'Existing removed candidate node', 'running', ?, ?, ?, ?, 'user', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        'node-removed-candidate',
        removedCandidate?.machineSize ?? 'small',
        removedCandidate?.location ?? 'ash',
        removedCandidate?.provider ?? 'hetzner',
        removedCandidate?.poolId ?? '',
        removedCandidate?.capacitySourceId ?? '',
        removedCandidate?.id ?? '',
        removedCandidate?.providerInstanceType ?? null,
        removedCandidate?.providerInstanceVcpuCount ?? null,
        removedCandidate?.providerInstanceMemoryMb ?? null,
        removedCandidate?.providerInstanceDiskGb ?? null,
        removedCandidate?.providerInstancePriceDisplay ?? null,
        removedCandidate?.providerInstancePriceCurrency ?? null,
        removedCandidate?.providerInstancePriceMonthlyCents ?? null,
        removedCandidate?.providerInstancePriceHourlyMicros ?? null
      );

    const update = await updateDefaultCapacityPool(db as never, {
      scope: 'user',
      ownerUserId: 'user-1',
      ownerProjectId: null,
      policy: { strategy: 'smallest-fit', exhaustionPolicy: 'fail' },
      candidates: usCandidates.map((candidate) => ({
        id: candidate.id,
        status: candidate.location === 'ash' ? 'deleted' : 'disabled',
      })),
    });

    expect(update.poolFound).toBe(true);
    expect(update.summary?.pool).toMatchObject({
      strategy: 'smallest-fit',
      exhaustionPolicy: 'fail',
      revision: 2,
    });
    expect(update.summary?.activeCandidateCount).toBe(
      expectedCandidateCount('hetzner') - usCandidates.length
    );
    expect(getCount('nodes', "id = 'node-removed-candidate' AND status = 'running'")).toBe(1);

    const reconciled = await resolveEffectiveDefaultCapacityPoolSummary(db as never, {
      userId: 'user-1',
      projectId: 'project-1',
      ensure: true,
      includeInstallation: false,
    });
    const candidateStatuses = new Map(
      (reconciled?.candidates ?? []).map((candidate) => [candidate.id, candidate.status])
    );

    for (const candidate of usCandidates) {
      expect(candidateStatuses.get(candidate.id)).toBe(
        candidate.location === 'ash' ? 'deleted' : 'disabled'
      );
    }

    const flexiblePlacement = resolveTaskStartPlacement({
      entryPoint: 'task-submit',
      taskId: 'candidate-edit-flexible-task',
      projectId: 'project-1',
      userId: 'user-1',
      project: {
        id: 'project-1',
        defaultProvider: 'hetzner',
        defaultLocation: 'fsn1',
        defaultVmSize: 'small',
      },
      credentialProjectPolicy: 'current-project-unless-inherited',
      taskModeDefault: 'task',
      resourceRequirements: {},
    });
    const flexibleSelection = await resolveTaskStartCapacityPoolSelection(
      db as never,
      flexiblePlacement,
      { ensure: false }
    );

    expect(
      flexibleSelection?.candidates.some(
        (candidate) => candidate.location === 'ash' || candidate.location === 'hil'
      )
    ).toBe(false);

    const ashPlacement = resolveTaskStartPlacement({
      entryPoint: 'task-submit',
      taskId: 'candidate-edit-ash-task',
      projectId: 'project-1',
      userId: 'user-1',
      explicit: { vmLocation: 'ash' },
      project: {
        id: 'project-1',
        defaultProvider: 'hetzner',
        defaultLocation: 'fsn1',
        defaultVmSize: 'small',
      },
      credentialProjectPolicy: 'current-project-unless-inherited',
      taskModeDefault: 'task',
      resourceRequirements: {},
    });
    const ashSelection = await resolveTaskStartCapacityPoolSelection(db as never, ashPlacement, {
      ensure: false,
    });
    expect(ashSelection?.poolId).toBe('cap-pool-default:user:user-1');
    expect(ashSelection?.candidates).toHaveLength(0);
    expect(() => resolveCapacityAwareCredentialLookup(ashPlacement, ashSelection)).toThrow(
      PlacementResolutionError
    );
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
      ensure: true,
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
      candidate_status: 'active',
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
      ensure: true,
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
