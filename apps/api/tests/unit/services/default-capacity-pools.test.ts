import { Buffer } from 'node:buffer';

import { getProviderInstanceOfferings } from '@simple-agent-manager/providers';
import {
  getDefaultLocationForProvider,
  getLocationsForProvider,
  type ProviderInstanceOffering,
} from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { runScheduledCapacityPoolReconciliation } from '../../../src/scheduled/capacity-pool-reconciliation';
import { reconcileCapacityPoolsForCredentialMutation } from '../../../src/services/capacity-pool-credential-lifecycle';
import { resolveCapacityPoolPlacementSettings } from '../../../src/services/capacity-pool-placement-settings';
import {
  capacityCandidateBaseId,
  capacityCandidateIdForRole,
  capacityCandidateRoleFromId,
  capacityCandidateSatisfiesWorkloadRole,
} from '../../../src/services/capacity-pool-workload-roles';
import { initialStatusForProviderOffering } from '../../../src/services/default-capacity-pool-candidates';
import { externalCapacitySourceCredentialId } from '../../../src/services/default-capacity-pool-helpers';
import { updateDefaultCapacityPool } from '../../../src/services/default-capacity-pool-updates';
import {
  backfillDefaultCapacityPoolsForExistingCredentials,
  ensureDefaultCapacityPoolsForExistingCredentials,
  readDefaultCapacityPoolSummaries,
  requestDefaultCapacityPoolBackfillRetry,
  resolveEffectiveDefaultCapacityPoolSummary,
} from '../../../src/services/default-capacity-pools';
import {
  clearCapacityCatalogCache,
  scrubCapacitySourceCredentialSecrets,
} from '../../../src/services/default-capacity-source-credentials';
import { encrypt } from '../../../src/services/encryption';
import {
  capacityPlacementSnapshotForTaskStart,
  PlacementResolutionError,
  resolveCapacityAwareCredentialLookup,
  resolveTaskStartCapacityPoolSelection,
  resolveTaskStartPlacement,
} from '../../../src/services/placement-resolver';
import { buildCapacityPoolSelection } from '../../../src/services/placement-resolver-capacity';
import { applyCapacityPoolSchemaMigrations } from '../../helpers/capacity-pool-migrations';
import { createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';

let sqlite: Database.Database | null = null;
const TEST_ENCRYPTION_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const originalFetch = globalThis.fetch;

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

	    CREATE TABLE platform_settings (
	      key TEXT PRIMARY KEY,
	      value TEXT NOT NULL,
	      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
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

    CREATE TABLE compute_usage (
      id TEXT PRIMARY KEY
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

    CREATE TABLE cc_credentials (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      encrypted_token TEXT NOT NULL,
      iv TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE cc_configurations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      consumer_kind TEXT NOT NULL,
      consumer_target TEXT NOT NULL,
      credential_id TEXT REFERENCES cc_credentials(id) ON DELETE SET NULL,
      settings_json TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE cc_attachments (
      id TEXT PRIMARY KEY,
      configuration_id TEXT NOT NULL REFERENCES cc_configurations(id) ON DELETE CASCADE,
      consumer_kind TEXT NOT NULL,
      consumer_target TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  seedIdentity();
  applyCapacityPoolSchemaMigrations(sqlite);
  return poolDb();
}

/**
 * Production always drives these services through the D1 driver, so the fixture must too:
 * the better-sqlite3 driver has no `batch()`, and an atomic pool edit is exactly the thing a
 * substituting harness cannot observe (.claude/rules/69). The bind limit is enforced at the
 * same 100-parameter ceiling Cloudflare applies.
 */
function poolDb() {
  return drizzleD1(createSqliteD1WithBindLimit(sqlite!, 100), { schema });
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
  credentialActive?: 0 | 1;
  configurationActive?: 0 | 1;
  attachmentActive?: 0 | 1;
  encryptedToken?: string;
  iv?: string;
  updatedAt?: string;
}): void {
  sqlite
    ?.prepare(
      `
      INSERT INTO credentials (
        id, user_id, project_id, provider, credential_type, is_active,
        encrypted_token, iv, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 'cloud-provider', ?, ?, ?, ?, ?)
    `
    )
    .run(
      input.id,
      input.userId ?? 'user-1',
      input.projectId ?? null,
      input.provider ?? 'hetzner',
      input.isActive ?? 1,
      input.encryptedToken ?? 'ciphertext-secret',
      input.iv ?? 'iv-secret',
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

function seedComposableCloudCredential(input: {
  credentialId: string;
  configurationId: string;
  attachmentId: string;
  userId?: string;
  projectId?: string | null;
  provider?: string;
  isActive?: 0 | 1;
  encryptedToken?: string;
  iv?: string;
  updatedAt?: string;
}): void {
  const userId = input.userId ?? 'user-1';
  const provider = input.provider ?? 'hetzner';
  const active = input.isActive ?? 1;
  sqlite
    ?.prepare(
      `
      INSERT INTO cc_credentials (
        id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at
      )
      VALUES (?, ?, ?, 'cloud-provider', ?, ?, ?, ?, ?)
    `
    )
    .run(
      input.credentialId,
      userId,
      `${provider} composable credential`,
      input.encryptedToken ?? `encrypted-token-for-${input.credentialId}`,
      input.iv ?? `iv-for-${input.credentialId}`,
      input.credentialActive ?? active,
      input.updatedAt ?? '2026-08-28T00:00:00.000Z',
      input.updatedAt ?? '2026-08-28T00:00:00.000Z'
    );
  sqlite
    ?.prepare(
      `
      INSERT INTO cc_configurations (
        id, owner_id, name, consumer_kind, consumer_target, credential_id, settings_json,
        is_active, created_at, updated_at
      )
      VALUES (?, ?, ?, 'compute', ?, ?, NULL, ?, ?, ?)
    `
    )
    .run(
      input.configurationId,
      userId,
      `${provider} compute`,
      provider,
      input.credentialId,
      input.configurationActive ?? active,
      input.updatedAt ?? '2026-08-28T00:00:00.000Z',
      input.updatedAt ?? '2026-08-28T00:00:00.000Z'
    );
  sqlite
    ?.prepare(
      `
      INSERT INTO cc_attachments (
        id, configuration_id, consumer_kind, consumer_target, user_id, project_id,
        is_active, created_at, updated_at
      )
      VALUES (?, ?, 'compute', ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      input.attachmentId,
      input.configurationId,
      provider,
      userId,
      input.projectId ?? null,
      input.attachmentActive ?? active,
      input.updatedAt ?? '2026-08-28T00:00:00.000Z',
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

type CatalogCandidateRow = {
  location: string;
  machine_size: string | null;
  provider_instance_type: string;
  provider_instance_display_name: string;
  provider_instance_vcpu_count: number;
  provider_instance_memory_mb: number;
  provider_instance_disk_gb: number;
  provider_instance_price_display: string;
  provider_instance_price_currency: string;
  provider_instance_price_monthly_cents: number;
  provider_instance_price_hourly_micros: number;
  provider_instance_catalog_source: string;
  provider_instance_catalog_last_seen_at: string | null;
};

type CandidateStatusRow = {
  location: string;
  machine_size: string | null;
  provider_instance_type: string;
  status: string;
};

function getCatalogCandidateRow(providerInstanceType: string): CatalogCandidateRow | undefined {
  return getRows<CatalogCandidateRow>(`
    SELECT
      location,
      machine_size,
      provider_instance_type,
      provider_instance_display_name,
      provider_instance_vcpu_count,
      provider_instance_memory_mb,
      provider_instance_disk_gb,
      provider_instance_price_display,
      provider_instance_price_currency,
      provider_instance_price_monthly_cents,
      provider_instance_price_hourly_micros,
      provider_instance_catalog_source,
      provider_instance_catalog_last_seen_at
    FROM capacity_pool_candidates
    WHERE provider_instance_type = '${providerInstanceType}'
  `)[0];
}

function getCandidateStatusRows(providerInstanceTypes: string[]): CandidateStatusRow[] {
  return getRows<CandidateStatusRow>(`
    SELECT location, machine_size, provider_instance_type, status
    FROM capacity_pool_candidates
    WHERE provider_instance_type IN (${providerInstanceTypes.map((type) => `'${type}'`).join(', ')})
      AND workload_role = 'workspace'
    ORDER BY provider_instance_type, location
  `);
}

/** Rows for the placement-only coupled role that mirrors each editor-visible candidate. */
function getDeploymentCandidateStatusRows(providerInstanceTypes: string[]): CandidateStatusRow[] {
  return getRows<CandidateStatusRow>(`
    SELECT location, machine_size, provider_instance_type, status
    FROM capacity_pool_candidates
    WHERE provider_instance_type IN (${providerInstanceTypes.map((type) => `'${type}'`).join(', ')})
      AND workload_role = 'deployment'
    ORDER BY provider_instance_type, location
  `);
}

function expectCpx62CatalogCandidate(lastSeenAt: string | ReturnType<typeof expect.any>) {
  expect(getCatalogCandidateRow('cpx62')).toEqual({
    location: 'fsn1',
    machine_size: null,
    provider_instance_type: 'cpx62',
    provider_instance_display_name: 'CPX62',
    provider_instance_vcpu_count: 32,
    provider_instance_memory_mb: 65_536,
    provider_instance_disk_gb: 480,
    provider_instance_price_display: '€48.12/mo',
    provider_instance_price_currency: 'EUR',
    provider_instance_price_monthly_cents: 4812,
    provider_instance_price_hourly_micros: 65_920,
    provider_instance_catalog_source: 'api',
    provider_instance_catalog_last_seen_at: lastSeenAt,
  });
}

function expectedCandidateCount(provider: 'hetzner' | 'vultr' | 'digitalocean'): number {
  return getLocationsForProvider(provider).length * getProviderInstanceOfferings(provider).length;
}

const LIVE_CATALOG_LAST_SEEN_AT = '2026-08-29T09:00:00.000Z';

function liveHetznerOffering(
  overrides: Partial<ProviderInstanceOffering> &
    Pick<ProviderInstanceOffering, 'location' | 'providerInstanceType' | 'displayName'>
): ProviderInstanceOffering {
  return {
    provider: 'hetzner',
    providerInstanceSku: null,
    id: overrides.providerInstanceType,
    sku: overrides.providerInstanceType,
    instanceType: overrides.providerInstanceType,
    type: overrides.providerInstanceType,
    name: overrides.displayName,
    vcpu: 2,
    ramGb: 4,
    memoryGb: 4,
    memoryMb: 4096,
    storageGb: 40,
    diskGb: 40,
    price: '€3.99/mo',
    priceMonthlyUsd: null,
    priceHourlyUsd: null,
    priceMonthly: 3.99,
    priceHourly: 0.006,
    currency: 'EUR',
    available: true,
    stale: false,
    status: null,
    catalogSource: 'api',
    catalogLastSeenAt: LIVE_CATALOG_LAST_SEEN_AT,
    ...overrides,
  };
}

function defaultTaskPlacement(taskId: string, resourceRequirements = {}) {
  return resolveTaskStartPlacement({
    entryPoint: 'task-submit',
    taskId,
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
    resourceRequirements,
  });
}

type LegacyCapacityCandidateStatus = 'deleted' | 'disabled';

function seedLegacyHetznerDefaultCandidate(status: LegacyCapacityCandidateStatus): string {
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
      VALUES (?, ?, ?, 'hetzner', 'fsn1', 'workspace', 'vm', 'shared-vm', 'small', ?)
    `
    )
    .run(legacyCandidateId, poolId, sourceId, status);

  return legacyCandidateId;
}

function legacySizeReconciliationOfferings(): ProviderInstanceOffering[] {
  return [
    liveHetznerOffering({
      location: 'fsn1',
      providerInstanceType: 'cx23',
      displayName: 'CX23',
    }),
    liveHetznerOffering({
      location: 'fsn1',
      providerInstanceType: 'cpx62',
      displayName: 'CPX62',
      vcpu: 32,
      memoryMb: 65_536,
      diskGb: 480,
      price: '€48.12/mo',
      priceMonthly: 48.12,
    }),
  ];
}

async function expectLegacyStatusMappedToLiveCatalog(
  legacyStatus: LegacyCapacityCandidateStatus
): Promise<void> {
  const db = createDb();
  const legacyCandidateId = seedLegacyHetznerDefaultCandidate(legacyStatus);

  await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
    userId: 'user-1',
    includeInstallation: false,
    offeringResolver: async () => legacySizeReconciliationOfferings(),
  });

  expect(
    getRows<{
      provider_instance_type: string | null;
      status: string;
      machine_size: string | null;
    }>(`
      SELECT provider_instance_type, status, machine_size
      FROM capacity_pool_candidates
      WHERE provider_instance_type IN ('cx23', 'cpx62') OR id = '${legacyCandidateId}'
      ORDER BY provider_instance_type
    `)
  ).toEqual(
    expect.arrayContaining([
      { provider_instance_type: null, status: legacyStatus, machine_size: 'small' },
      { provider_instance_type: 'cx23', status: legacyStatus, machine_size: 'small' },
      { provider_instance_type: 'cpx62', status: 'disabled', machine_size: null },
    ])
  );
}

function catalogEnv(database: D1Database = {} as D1Database): Env {
  return {
    DATABASE: database,
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
  } as Env;
}

type TaskStartResourceRequirements = Parameters<
  typeof resolveTaskStartPlacement
>[0]['resourceRequirements'];

async function seedVultrDefaultPool(): Promise<ReturnType<typeof createDb>> {
  const db = createDb();
  seedUserCredential({ id: 'user-vultr', provider: 'vultr' });

  await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
    userId: 'user-1',
    includeInstallation: false,
  });

  return db;
}

function setUserDefaultPoolStrategy(strategy: 'pack' | 'smallest-fit'): void {
  sqlite?.prepare("UPDATE capacity_pools SET strategy = ? WHERE scope = 'user'").run(strategy);
}

function vultrTaskStartPlacement(
  taskId: string,
  resourceRequirements: TaskStartResourceRequirements = {}
) {
  return resolveTaskStartPlacement({
    entryPoint: 'task-submit',
    taskId,
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
    resourceRequirements,
  });
}

async function selectVultrDefaultPoolCandidates(
  db: ReturnType<typeof createDb>,
  taskId: string,
  resourceRequirements: TaskStartResourceRequirements = {}
) {
  return resolveTaskStartCapacityPoolSelection(
    db as never,
    vultrTaskStartPlacement(taskId, resourceRequirements),
    { ensure: false }
  );
}

function hetznerServerType(input: {
  id: number;
  name: string;
  description: string;
  cores: number;
  memory: number;
  disk: number;
  hourlyGross: string;
  monthlyGross: string;
  location?: string;
}) {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    cores: input.cores,
    memory: input.memory,
    disk: input.disk,
    architecture: 'x86',
    cpu_type: 'shared',
    deprecated: false,
    prices: [
      {
        location: input.location ?? 'fsn1',
        price_hourly: { net: input.hourlyGross, gross: input.hourlyGross },
        price_monthly: { net: input.monthlyGross, gross: input.monthlyGross },
      },
    ],
  };
}

function manyLiveOfferings(count: number): ProviderInstanceOffering[] {
  return Array.from({ length: count }, (_, index) =>
    liveHetznerOffering({
      location: 'fsn1',
      providerInstanceType: `provider-native-${index}`,
      displayName: `Provider native ${index}`,
      vcpu: 2 + (index % 8),
      ramGb: 4 + (index % 16),
      memoryGb: 4 + (index % 16),
      memoryMb: (4 + (index % 16)) * 1024,
      storageGb: 40 + index,
      diskGb: 40 + index,
      price: `€${(4 + index).toFixed(2)}/mo`,
      priceMonthly: 4 + index,
      priceHourly: (4 + index) / 730,
    })
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  // The provider catalog cache is per-isolate module state; leaking it across cases would
  // let one test's inventory answer another test's refresh.
  clearCapacityCatalogCache();
  vi.restoreAllMocks();
  sqlite?.close();
  sqlite = null;
});

describe('initialStatusForProviderOffering', () => {
  it('preserves explicit concrete candidate status before applying migration defaults', () => {
    expect(initialStatusForProviderOffering('active', 'deleted', null)).toBe('active');
    expect(initialStatusForProviderOffering('disabled', 'active', 'small')).toBe('disabled');
    expect(initialStatusForProviderOffering('deleted', null, 'medium')).toBe('deleted');
  });

  it('selects only legacy-mapped offerings by default and disables new catalog discoveries', () => {
    expect(initialStatusForProviderOffering(null, null, 'small')).toBe('active');
    expect(initialStatusForProviderOffering(undefined, undefined, null)).toBe('disabled');
  });

  it('preserves legacy migration removals for matching concrete offerings', () => {
    expect(initialStatusForProviderOffering(null, 'disabled', 'small')).toBe('disabled');
    expect(initialStatusForProviderOffering(null, 'deleted', 'large')).toBe('deleted');
    expect(initialStatusForProviderOffering(null, 'active', 'medium')).toBe('active');
  });
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
    expect(getCount('capacity_pool_candidates', "workload_role = 'workspace'")).toBe(
      expectedCandidateCount('hetzner') * 3
    );
    // Every editor-visible offering is coupled to a placement-only deployment row, so
    // deployment provisioning has an eligible candidate without any public role editing.
    expect(getCount('capacity_pool_candidates', "workload_role = 'deployment'")).toBe(
      expectedCandidateCount('hetzner') * 3
    );
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

  it('bounds unscoped backfill work so repeated calls can resume safely', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });
    seedUserCredential({ id: 'user-2-hetzner', userId: 'user-2' });
    sqlite?.prepare("INSERT INTO users (id) VALUES ('user-3')").run();
    seedUserCredential({ id: 'user-3-hetzner', userId: 'user-3' });
    seedUserCredential({ id: 'project-1-hetzner', projectId: 'project-1' });
    seedUserCredential({ id: 'project-2-hetzner', projectId: 'project-2' });

    const first = await backfillDefaultCapacityPoolsForExistingCredentials(db as never, {
      includeInstallation: false,
      scopeBatchSize: 1,
    });
    const second = await backfillDefaultCapacityPoolsForExistingCredentials(db as never, {
      includeInstallation: false,
      scopeBatchSize: 1,
    });
    const third = await backfillDefaultCapacityPoolsForExistingCredentials(db as never, {
      includeInstallation: false,
      scopeBatchSize: 1,
    });

    expect([first.usersEnsured, second.usersEnsured, third.usersEnsured]).toEqual([1, 1, 1]);
    expect([first.projectsEnsured, second.projectsEnsured, third.projectsEnsured]).toEqual([
      1, 1, 1,
    ]);
    expect(getCount('capacity_pools', "scope = 'user'")).toBe(3);
    expect(getCount('capacity_pools', "scope = 'project'")).toBe(2);
  });

  // 26 projects x composable credential decryption x 5 reconciliation passes. This fixture is
  // deliberately heavy (it proves the scope batching bound), so it needs more than the 5s default.
  it('continues credential lifecycle work for more than 25 project attachments through scheduled backfill', { timeout: 60_000 }, async () => {
    createDb();
    const encrypted = await encrypt('vultr-token-for-scheduled-backfill', TEST_ENCRYPTION_KEY);
    const insertProject = sqlite!.prepare(
      `
        INSERT INTO projects (id, user_id, name, normalized_name, installation_id, repository, created_by)
        VALUES (?, 'user-1', ?, ?, 'installation-1', ?, 'user-1')
      `
    );

    for (let index = 1; index <= 26; index += 1) {
      const projectId = `overflow-project-${String(index).padStart(3, '0')}`;
      insertProject.run(projectId, `Overflow ${index}`, projectId, `repo-overflow-${index}`);
      seedComposableCloudCredential({
        credentialId: `cc-overflow-cred-${String(index).padStart(3, '0')}`,
        configurationId: `cc-overflow-cfg-${String(index).padStart(3, '0')}`,
        attachmentId: `cc-overflow-att-${String(index).padStart(3, '0')}`,
        projectId,
        provider: 'vultr',
        encryptedToken: encrypted.ciphertext,
        iv: encrypted.iv,
        updatedAt: `2026-08-28T00:${String(index).padStart(2, '0')}:00.000Z`,
      });
    }

    const env = {
      ...catalogEnv(createSqliteD1WithBindLimit(sqlite!, 100)),
      CAPACITY_POOL_BACKFILL_SCOPE_BATCH_SIZE: '8',
    } as Env;

    await reconcileCapacityPoolsForCredentialMutation(env, { scope: 'user', userId: 'user-1' });

    expect(getCount('capacity_pools', "scope = 'project'")).toBe(25);
    expect(
      getCount(
        'capacity_sources',
        "owner_project_id = 'overflow-project-026' AND status = 'active'"
      )
    ).toBe(0);

    const scheduledResults = [];
    for (let run = 0; run < 4; run += 1) {
      scheduledResults.push(await runScheduledCapacityPoolReconciliation(env));
    }

    expect(scheduledResults.map((result) => result.projectsEnsured)).toEqual([8, 8, 8, 2]);
    expect(scheduledResults.every((result) => result.projectsEnsured <= 8)).toBe(true);
    expect(getCount('capacity_pools', "scope = 'project'")).toBe(26);
    expect(
      getCount(
        'capacity_sources',
        "owner_project_id = 'overflow-project-026' AND status = 'active'"
      )
    ).toBe(1);
    expect(
      getRows<{ status: string; count: number }>(`
        SELECT status, COUNT(*) AS count
        FROM capacity_sources
        WHERE owner_project_id LIKE 'overflow-project-%'
        GROUP BY status
      `)
    ).toEqual([{ status: 'active', count: 26 }]);
  });

  it('keeps project backfill cursor scans bounded by covering indexes', () => {
    createDb();

    const legacyPlan = sqlite!
      .prepare(
        `
        EXPLAIN QUERY PLAN
        SELECT project_id
        FROM credentials
        WHERE credential_type = 'cloud-provider'
          AND project_id IS NOT NULL
          AND project_id > 'overflow-project-008'
        ORDER BY project_id
        LIMIT 8
      `
      )
      .all()
      .map((row) => (row as { detail: string }).detail)
      .join('\n');
    const composablePlan = sqlite!
      .prepare(
        `
        EXPLAIN QUERY PLAN
        SELECT project_id
        FROM cc_attachments
        WHERE consumer_kind = 'compute'
          AND project_id IS NOT NULL
          AND project_id > 'overflow-project-008'
        ORDER BY project_id
        LIMIT 8
      `
      )
      .all()
      .map((row) => (row as { detail: string }).detail)
      .join('\n');

    expect(legacyPlan).toContain('idx_credentials_cloud_provider_project_active');
    expect(legacyPlan).not.toContain('SCAN credentials');
    expect(composablePlan).toContain('idx_cc_attachments_project_compute_active');
    expect(composablePlan).not.toContain('SCAN cc_attachments');
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
        WHERE workload_role = 'workspace'
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

  it('seeds Hetzner reconciliation from live API offerings beyond legacy sizes with EUR prices', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });
    const liveOfferings: ProviderInstanceOffering[] = [
      liveHetznerOffering({
        location: 'fsn1',
        locationName: 'Falkenstein',
        country: 'DE',
        providerInstanceType: 'cx23',
        displayName: 'CX23',
      }),
      liveHetznerOffering({
        location: 'fsn1',
        locationName: 'Falkenstein',
        country: 'DE',
        providerInstanceType: 'cx33',
        displayName: 'CX33',
        vcpu: 4,
        ramGb: 8,
        memoryGb: 8,
        memoryMb: 8192,
        storageGb: 80,
        diskGb: 80,
        price: '€7.59/mo',
        priceMonthly: 7.59,
        priceHourly: 0.0121,
      }),
      liveHetznerOffering({
        location: 'fsn1',
        locationName: 'Falkenstein',
        country: 'DE',
        providerInstanceType: 'cx43',
        displayName: 'CX43',
        vcpu: 8,
        ramGb: 16,
        memoryGb: 16,
        memoryMb: 16_384,
        storageGb: 160,
        diskGb: 160,
        price: '€15.19/mo',
        priceMonthly: 15.19,
        priceHourly: 0.0242,
      }),
      liveHetznerOffering({
        location: 'fsn1',
        locationName: 'Falkenstein',
        country: 'DE',
        providerInstanceType: 'cpx62',
        displayName: 'CPX62',
        vcpu: 32,
        ramGb: 64,
        memoryGb: 64,
        memoryMb: 65_536,
        storageGb: 480,
        diskGb: 480,
        price: '€48.12/mo',
        priceMonthly: 48.12,
        priceHourly: 0.06592,
      }),
      liveHetznerOffering({
        location: 'hel1',
        locationName: 'Helsinki',
        country: 'FI',
        providerInstanceType: 'ccx63',
        displayName: 'CCX63',
        vcpu: 48,
        ramGb: 192,
        memoryGb: 192,
        memoryMb: 196_608,
        storageGb: 960,
        diskGb: 960,
        price: '€168.44/mo',
        priceMonthly: 168.44,
        priceHourly: 0.23074,
      }),
    ];

    const result = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async (seed) => {
        expect(seed).toMatchObject({
          id: 'user-hetzner',
          provider: 'hetzner',
          scope: 'user',
          credentialId: 'user-hetzner',
          encryptedToken: 'ciphertext-secret',
          iv: 'iv-secret',
        });
        return liveOfferings;
      },
    });

    expect(result.user?.activeCandidateCount).toBe(3);
    expect(getCount('capacity_pool_candidates', "workload_role = 'workspace'")).toBe(
      liveOfferings.length
    );
    expect(getCandidateStatusRows(['cx23', 'cx33', 'cx43', 'cpx62', 'ccx63'])).toEqual([
      {
        location: 'hel1',
        machine_size: null,
        provider_instance_type: 'ccx63',
        status: 'disabled',
      },
      {
        location: 'fsn1',
        machine_size: null,
        provider_instance_type: 'cpx62',
        status: 'disabled',
      },
      {
        location: 'fsn1',
        machine_size: 'small',
        provider_instance_type: 'cx23',
        status: 'active',
      },
      {
        location: 'fsn1',
        machine_size: 'medium',
        provider_instance_type: 'cx33',
        status: 'active',
      },
      {
        location: 'fsn1',
        machine_size: 'large',
        provider_instance_type: 'cx43',
        status: 'active',
      },
    ]);
    expectCpx62CatalogCandidate(LIVE_CATALOG_LAST_SEEN_AT);
  });

  it('applies conservative live catalog defaults at installation, user, and project scope', async () => {
    const db = createDb();
    seedPlatformCredential({ id: 'platform-hetzner' });
    seedUserCredential({ id: 'user-hetzner' });
    seedUserCredential({ id: 'project-hetzner', projectId: 'project-1' });
    const liveOfferings: ProviderInstanceOffering[] = [
      liveHetznerOffering({
        location: 'fsn1',
        providerInstanceType: 'cx23',
        displayName: 'CX23',
      }),
      liveHetznerOffering({
        location: 'fsn1',
        providerInstanceType: 'cpx62',
        displayName: 'CPX62',
        vcpu: 32,
        ramGb: 64,
        memoryGb: 64,
        memoryMb: 65_536,
        storageGb: 480,
        diskGb: 480,
        price: '€48.12/mo',
        priceMonthly: 48.12,
        priceHourly: 0.06592,
      }),
    ];

    const result = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      projectId: 'project-1',
      offeringResolver: async () => liveOfferings,
    });

    for (const summary of [result.installation, result.user, result.project]) {
      expect(summary?.activeCandidateCount).toBe(1);
      expect(summary?.candidates).toHaveLength(liveOfferings.length);
      expect(summary?.candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            providerInstanceType: 'cx23',
            machineSize: 'small',
            status: 'active',
          }),
          expect.objectContaining({
            providerInstanceType: 'cpx62',
            machineSize: null,
            status: 'disabled',
          }),
        ])
      );
    }

    expect(
      getRows<{ scope: string; provider_instance_type: string; status: string; count: number }>(`
        SELECT pool.scope, cand.provider_instance_type, cand.status, COUNT(*) AS count
        FROM capacity_pools pool
        JOIN capacity_pool_candidates cand ON cand.pool_id = pool.id
        WHERE cand.provider_instance_type IN ('cx23', 'cpx62')
          AND cand.workload_role = 'workspace'
        GROUP BY pool.scope, cand.provider_instance_type, cand.status
        ORDER BY pool.scope, cand.provider_instance_type, cand.status
      `)
    ).toEqual([
      { scope: 'installation', provider_instance_type: 'cpx62', status: 'disabled', count: 1 },
      { scope: 'installation', provider_instance_type: 'cx23', status: 'active', count: 1 },
      { scope: 'project', provider_instance_type: 'cpx62', status: 'disabled', count: 1 },
      { scope: 'project', provider_instance_type: 'cx23', status: 'active', count: 1 },
      { scope: 'user', provider_instance_type: 'cpx62', status: 'disabled', count: 1 },
      { scope: 'user', provider_instance_type: 'cx23', status: 'active', count: 1 },
    ]);
  });

  it('reconciles Hetzner defaults through the credential-backed live provider catalog path', async () => {
    const db = createDb();
    const encrypted = await encrypt('live-hetzner-token', TEST_ENCRYPTION_KEY);
    seedUserCredential({
      id: 'user-hetzner',
      encryptedToken: encrypted.ciphertext,
      iv: encrypted.iv,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          server_types: [
            hetznerServerType({
              id: 1,
              name: 'cx23',
              description: 'CX23',
              cores: 2,
              memory: 4,
              disk: 40,
              hourlyGross: '0.0048',
              monthlyGross: '3.99',
            }),
            hetznerServerType({
              id: 62,
              name: 'cpx62',
              description: 'CPX62',
              cores: 32,
              memory: 64,
              disk: 480,
              hourlyGross: '0.06592',
              monthlyGross: '48.12',
            }),
          ],
          meta: { pagination: { next_page: null } },
        }),
        { status: 200 }
      )
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      env: catalogEnv(),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.hetzner.cloud/v1/server_types',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer live-hetzner-token' }),
      })
    );
    expect(result.user?.activeCandidateCount).toBe(1);
    expect(getCandidateStatusRows(['cx23', 'cpx62'])).toEqual([
      {
        location: 'fsn1',
        machine_size: null,
        provider_instance_type: 'cpx62',
        status: 'disabled',
      },
      {
        location: 'fsn1',
        machine_size: 'small',
        provider_instance_type: 'cx23',
        status: 'active',
      },
    ]);
    expectCpx62CatalogCandidate(expect.any(String));
  });

  it('reports provider catalog failures without seeding static Hetzner rows', async () => {
    const db = createDb();
    const encrypted = await encrypt('live-hetzner-token', TEST_ENCRYPTION_KEY);
    seedUserCredential({
      id: 'user-hetzner',
      encryptedToken: encrypted.ciphertext,
      iv: encrypted.iv,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'catalog unavailable' } }), {
        status: 503,
      })
    ) as typeof fetch;

    const result = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      env: catalogEnv(),
    });

    const warningPayloads = warnSpy.mock.calls
      .map(([payload]) => String(payload))
      .filter((payload) => payload.includes('catalog.provider_warning'));
    expect(warningPayloads.length).toBeGreaterThan(0);
    expect(warningPayloads[0]).toContain('hetzner catalog API unavailable');
    expect(warningPayloads.join('\n')).not.toContain('live-hetzner-token');
    expect(result.user?.effectiveState).toBe('configured-empty');
    expect(
      getRows<{ provider_instance_catalog_source: string }>(`
        SELECT provider_instance_catalog_source
        FROM capacity_pool_candidates
        WHERE provider_instance_type = 'cx23'
        LIMIT 1
      `)[0]
    ).toBeUndefined();
  });

  it('disables failed-refresh sources with no candidates when the backing credential is disabled', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });
    const failedRefresh = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => ({
        offerings: [],
        refreshSucceeded: false,
        catalogComplete: false,
      }),
    });

    expect(failedRefresh.user?.effectiveState).toBe('configured-empty');
    expect(getCount('capacity_pool_candidates')).toBe(0);
    expect(
      sqlite
        ?.prepare(
          "SELECT status, source_generation FROM capacity_sources WHERE credential_id = 'user-hetzner'"
        )
        .get()
    ).toEqual({ status: 'active', source_generation: 1 });

    sqlite
      ?.prepare("UPDATE credentials SET is_active = 0, updated_at = ? WHERE id = 'user-hetzner'")
      .run('2026-08-28T01:00:00.000Z');
    const disabled = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => ({
        offerings: [],
        refreshSucceeded: false,
        catalogComplete: false,
      }),
    });

    expect(disabled.user?.effectiveState).toBe('source-disabled');
    expect(
      sqlite
        ?.prepare(
          "SELECT status, source_generation FROM capacity_sources WHERE credential_id = 'user-hetzner'"
        )
        .get()
    ).toEqual({ status: 'disabled', source_generation: 2 });
    expect(
      sqlite?.prepare("SELECT configuration_state FROM capacity_pools WHERE scope = 'user'").get()
    ).toEqual({ configuration_state: 'source-disabled' });
  });

  it('does not let incomplete catalog snapshots replace provider-scoped last-known-good inventory', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: 'cx23',
          displayName: 'CX23',
        }),
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: 'cx33',
          displayName: 'CX33',
        }),
      ],
    });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => ({
        offerings: [
          liveHetznerOffering({
            location: 'fsn1',
            providerInstanceType: 'cx33',
            displayName: 'CX33 static subset',
            catalogSource: 'static',
          }),
        ],
        refreshSucceeded: true,
        catalogComplete: false,
      }),
    });

    expect(
      getRows<{
        provider_instance_type: string;
        provider_instance_display_name: string;
        catalog_availability: string;
        provider_instance_catalog_source: string | null;
      }>(`
        SELECT provider_instance_type, provider_instance_display_name, catalog_availability,
               provider_instance_catalog_source
        FROM capacity_pool_candidates
        WHERE provider_instance_type IN ('cx23', 'cx33')
          AND workload_role = 'workspace'
        ORDER BY provider_instance_type
      `)
    ).toEqual([
      {
        provider_instance_type: 'cx23',
        provider_instance_display_name: 'CX23',
        catalog_availability: 'available',
        provider_instance_catalog_source: 'api',
      },
      {
        provider_instance_type: 'cx33',
        provider_instance_display_name: 'CX33',
        catalog_availability: 'available',
        provider_instance_catalog_source: 'api',
      },
    ]);
    expect(
      sqlite?.prepare("SELECT configuration_state FROM capacity_pools WHERE scope = 'user'").get()
    ).toEqual({ configuration_state: 'configured-ready' });
  });

  it('preserves authoritative last-known catalog state through incomplete static fallback and return', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: 'cx23',
          displayName: 'CX23 authoritative',
          vcpu: 8,
          ramGb: 16,
          memoryGb: 16,
          memoryMb: 16_384,
          diskGb: 160,
          storageGb: 160,
        }),
      ],
    });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => ({
        offerings: [],
        refreshSucceeded: true,
        catalogComplete: false,
      }),
    });

    expect(
      getRows<{ provider_instance_memory_mb: number; catalog_availability: string }>(`
        SELECT provider_instance_memory_mb, catalog_availability
        FROM capacity_pool_candidates
        WHERE provider_instance_type = 'cx23'
      `)[0]
    ).toEqual({ provider_instance_memory_mb: 16_384, catalog_availability: 'available' });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [],
    });

    expect(
      getRows<{
        provider_instance_catalog_source: string;
        provider_instance_memory_mb: number;
        catalog_availability: string;
      }>(`
        SELECT provider_instance_catalog_source, provider_instance_memory_mb, catalog_availability
        FROM capacity_pool_candidates
        WHERE provider_instance_type = 'cx23'
      `)[0]
    ).toEqual({
      provider_instance_catalog_source: 'api',
      provider_instance_memory_mb: 16_384,
      catalog_availability: 'last-known-unavailable',
    });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => ({
        offerings: [
          liveHetznerOffering({
            location: 'fsn1',
            providerInstanceType: 'cx23',
            displayName: 'CX23 weaker static',
            catalogSource: 'static',
            vcpu: 1,
            ramGb: 1,
            memoryGb: 1,
            memoryMb: 1024,
            diskGb: 20,
            storageGb: 20,
          }),
        ],
        refreshSucceeded: true,
        catalogComplete: false,
      }),
    });

    expect(
      getRows<{
        provider_instance_catalog_source: string;
        provider_instance_display_name: string;
        provider_instance_memory_mb: number;
        catalog_availability: string;
      }>(`
        SELECT provider_instance_catalog_source, provider_instance_display_name,
               provider_instance_memory_mb, catalog_availability
        FROM capacity_pool_candidates
        WHERE provider_instance_type = 'cx23'
      `)[0]
    ).toEqual({
      provider_instance_catalog_source: 'api',
      provider_instance_display_name: 'CX23 authoritative',
      provider_instance_memory_mb: 16_384,
      catalog_availability: 'last-known-unavailable',
    });
    expect(
      sqlite?.prepare("SELECT configuration_state FROM capacity_pools WHERE scope = 'user'").get()
    ).toEqual({ configuration_state: 'catalog-unavailable' });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: 'cx23',
          displayName: 'CX23 authoritative return',
          vcpu: 16,
          ramGb: 32,
          memoryGb: 32,
          memoryMb: 32_768,
          diskGb: 320,
          storageGb: 320,
        }),
      ],
    });

    expect(
      getRows<{
        provider_instance_catalog_source: string;
        provider_instance_display_name: string;
        provider_instance_memory_mb: number;
        catalog_availability: string;
      }>(`
        SELECT provider_instance_catalog_source, provider_instance_display_name,
               provider_instance_memory_mb, catalog_availability
        FROM capacity_pool_candidates
        WHERE provider_instance_type = 'cx23'
      `)[0]
    ).toEqual({
      provider_instance_catalog_source: 'api',
      provider_instance_display_name: 'CX23 authoritative return',
      provider_instance_memory_mb: 32_768,
      catalog_availability: 'available',
    });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => ({
        offerings: [],
        refreshSucceeded: false,
        catalogComplete: false,
      }),
    });

    expect(
      getRows<{
        provider_instance_display_name: string;
        provider_instance_memory_mb: number;
        catalog_availability: string;
      }>(`
        SELECT provider_instance_display_name, provider_instance_memory_mb, catalog_availability
        FROM capacity_pool_candidates
        WHERE provider_instance_type = 'cx23'
      `)[0]
    ).toEqual({
      provider_instance_display_name: 'CX23 authoritative return',
      provider_instance_memory_mb: 32_768,
      catalog_availability: 'available',
    });
  });

  it('reconciles large provider catalogs without exceeding D1 bind limits', async () => {
    createDb();
    seedUserCredential({ id: 'user-hetzner' });
    const db = drizzleD1(createSqliteD1WithBindLimit(sqlite!, 100), { schema });
    const initialOfferings = manyLiveOfferings(150);
    const updatedOfferings = initialOfferings.slice(0, 120);

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      candidatePublishBatchSize: 1000,
      offeringResolver: async () => initialOfferings,
    });
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      candidatePublishBatchSize: 1000,
      offeringResolver: async () => updatedOfferings,
    });

    expect(
      getRows<{ status: string; count: number }>(`
        SELECT status, COUNT(*) AS count
        FROM capacity_pool_candidates
        WHERE workload_role = 'workspace'
        GROUP BY status
        ORDER BY status
      `)
    ).toEqual([{ status: 'disabled', count: 150 }]);
    expect(
      getRows<{ provider_instance_catalog_source: string | null; count: number }>(`
        SELECT provider_instance_catalog_source, COUNT(*) AS count
        FROM capacity_pool_candidates
        WHERE workload_role = 'workspace'
        GROUP BY provider_instance_catalog_source
        ORDER BY provider_instance_catalog_source
      `)
    ).toEqual([{ provider_instance_catalog_source: 'api', count: 150 }]);
    expect(
      getRows<{ catalog_availability: string; count: number }>(`
        SELECT catalog_availability, COUNT(*) AS count
        FROM capacity_pool_candidates
        WHERE workload_role = 'workspace'
        GROUP BY catalog_availability
        ORDER BY catalog_availability
      `)
    ).toEqual([
      { catalog_availability: 'available', count: 120 },
      { catalog_availability: 'last-known-unavailable', count: 30 },
    ]);
  });

  it('updates large provider catalogs without exceeding D1 bind limits', async () => {
    createDb();
    seedUserCredential({ id: 'user-hetzner' });
    const db = drizzleD1(createSqliteD1WithBindLimit(sqlite!, 100), { schema });
    const offerings = manyLiveOfferings(150);

    const ensured = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      candidatePublishBatchSize: 1000,
      offeringResolver: async () => offerings,
    });
    expect(ensured.user?.effectiveState).toBe('configured-empty');
    expect(ensured.user?.activeCandidateCount).toBe(0);
    const editorRead = await readDefaultCapacityPoolSummaries(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      includeDisabled: true,
    });
    const catalogCandidates = editorRead.user?.candidates ?? [];
    expect(editorRead.user?.activeCandidateCount).toBe(0);
    expect(catalogCandidates).toHaveLength(150);

    const update = await updateDefaultCapacityPool(db as never, {
      scope: 'user',
      ownerUserId: 'user-1',
      ownerProjectId: null,
      candidates: catalogCandidates.map((candidate) => ({
        id: candidate.id,
        status: 'deleted',
      })),
    });

    expect(update.missingCandidateIds).toEqual([]);
    expect(update.unavailableCandidateIds).toEqual([]);
    expect(update.conflict).toBe(false);
    expect(update.summary?.activeCandidateCount).toBe(0);
    expect(
      getRows<{ workload_role: string; status: string; count: number }>(`
        SELECT workload_role, status, COUNT(*) AS count
        FROM capacity_pool_candidates
        GROUP BY workload_role, status
        ORDER BY workload_role, status
      `)
      // A deliberate removal of every editor-visible offering also removes its coupled
      // placement-only deployment row: a removed offering cannot be resurrected by role.
    ).toEqual([
      { workload_role: 'deployment', status: 'deleted', count: 150 },
      { workload_role: 'workspace', status: 'deleted', count: 150 },
    ]);
  });

  it('seeds user and project pools from composable compute credentials', async () => {
    const db = createDb();
    seedComposableCloudCredential({
      credentialId: 'cc-cred-user',
      configurationId: 'cc-cfg-user',
      attachmentId: 'cc-att-user',
      provider: 'hetzner',
    });
    seedComposableCloudCredential({
      credentialId: 'cc-cred-project',
      configurationId: 'cc-cfg-project',
      attachmentId: 'cc-att-project',
      provider: 'vultr',
      projectId: 'project-1',
    });

    const ensured = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      projectId: 'project-1',
      includeInstallation: false,
      offeringResolver: async (seed) => [
        liveHetznerOffering({
          provider: seed.provider,
          location: seed.provider === 'vultr' ? 'ewr' : 'fsn1',
          providerInstanceType: seed.provider === 'vultr' ? 'vc2-2c-4gb' : 'cx23',
          displayName: seed.provider === 'vultr' ? 'vc2-2c-4gb' : 'CX23',
        }),
      ],
    });

    expect(ensured.user?.sources[0]).toMatchObject({
      scope: 'user',
      provider: 'hetzner',
      credentialSource: 'user',
      credentialId: externalCapacitySourceCredentialId(
        'cc_attachments:cc-att-user',
        Date.parse('2026-08-28T00:00:00.000Z')
      ),
      platformCredentialId: null,
      credentialReference: 'cc_credentials:cc-cred-user',
      externalSourceRef: 'cc_attachments:cc-att-user',
    });
    expect(ensured.project?.sources[0]).toMatchObject({
      scope: 'project',
      provider: 'vultr',
      credentialSource: 'project',
      credentialId: externalCapacitySourceCredentialId(
        'cc_attachments:cc-att-project',
        Date.parse('2026-08-28T00:00:00.000Z')
      ),
      platformCredentialId: null,
      credentialReference: 'cc_credentials:cc-cred-project',
      externalSourceRef: 'cc_attachments:cc-att-project',
    });
    expect(ensured.user?.candidates[0]).toMatchObject({
      provider: 'hetzner',
      providerInstanceType: 'cx23',
      providerInstanceCatalogSource: 'api',
    });
    expect(ensured.project?.candidates[0]).toMatchObject({
      provider: 'vultr',
      providerInstanceType: 'vc2-2c-4gb',
      providerInstanceCatalogSource: 'api',
    });
    expect(
      getRows<{ id: string; credential_type: string; provider: string }>(`
        SELECT id, credential_type, provider
        FROM credentials
        WHERE credential_type = 'capacity-source-external-ref'
        ORDER BY id
      `)
    ).toEqual([
      {
        id: externalCapacitySourceCredentialId(
          'cc_attachments:cc-att-project',
          Date.parse('2026-08-28T00:00:00.000Z')
        ),
        credential_type: 'capacity-source-external-ref',
        provider: 'vultr',
      },
      {
        id: externalCapacitySourceCredentialId(
          'cc_attachments:cc-att-user',
          Date.parse('2026-08-28T00:00:00.000Z')
        ),
        credential_type: 'capacity-source-external-ref',
        provider: 'hetzner',
      },
    ]);
  });

  it('disables active composable sources that disappeared from current credential seeds', async () => {
    const db = createDb();
    seedComposableCloudCredential({
      credentialId: 'cc-cred-old',
      configurationId: 'cc-cfg-old',
      attachmentId: 'cc-att-old',
      provider: 'hetzner',
    });
    seedUserCredential({ id: 'user-vultr', provider: 'vultr' });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async (seed) => [
        liveHetznerOffering({
          provider: seed.provider,
          location: seed.provider === 'vultr' ? 'ewr' : 'fsn1',
          providerInstanceType: `${seed.provider}-native-large`,
          displayName: `${seed.provider} native large`,
        }),
      ],
    });
    sqlite?.prepare("DELETE FROM cc_attachments WHERE id = 'cc-att-old'").run();
    seedComposableCloudCredential({
      credentialId: 'cc-cred-new',
      configurationId: 'cc-cfg-new',
      attachmentId: 'cc-att-new',
      provider: 'hetzner',
    });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async (seed) => [
        liveHetznerOffering({
          provider: seed.provider,
          location: seed.provider === 'vultr' ? 'ewr' : 'fsn1',
          providerInstanceType: `${seed.provider}-native-large`,
          displayName: `${seed.provider} native large`,
        }),
      ],
    });

    expect(
      getRows<{
        credential_reference: string;
        external_source_ref: string | null;
        status: string;
      }>(`
        SELECT credential_reference, external_source_ref, status
        FROM capacity_sources
        WHERE scope = 'user'
        ORDER BY credential_reference
      `)
    ).toEqual(
      expect.arrayContaining([
        {
          credential_reference: 'cc_credentials:cc-cred-old',
          external_source_ref: 'cc_attachments:cc-att-old',
          status: 'disabled',
        },
        {
          credential_reference: 'cc_credentials:cc-cred-new',
          external_source_ref: 'cc_attachments:cc-att-new',
          status: 'active',
        },
        {
          credential_reference: 'credentials:user-vultr',
          external_source_ref: null,
          status: 'active',
        },
      ])
    );
  });

  it('disables stale scoped sources even when they have no candidates', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-vultr', provider: 'vultr' });
    sqlite
      ?.prepare(
        `
        INSERT INTO credentials (
          id, user_id, project_id, provider, credential_type, is_active,
          encrypted_token, iv, created_at, updated_at
        )
        VALUES
          (
            'orphan-source-ref', 'user-1', NULL, 'hetzner',
            'capacity-source-external-ref', 1,
            'orphan-ciphertext', 'orphan-iv',
            '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z'
          )
      `
      )
      .run();
    sqlite
      ?.prepare(
        `
        INSERT INTO capacity_pools
          (id, scope, owner_user_id, owner_project_id, name, is_default, status)
        VALUES
          ('cap-pool-default:user:user-1', 'user', 'user-1', NULL, 'User default', 1, 'active')
      `
      )
      .run();
    sqlite
      ?.prepare(
        `
        INSERT INTO capacity_sources
          (
            id, scope, owner_user_id, owner_project_id, source_kind, provider,
            credential_source, credential_id, platform_credential_id,
            credential_reference, status, created_by
          )
        VALUES
          (
            'source-no-candidates', 'user', 'user-1', NULL, 'cloud-provider-credential',
            'hetzner', 'user', 'orphan-source-ref', NULL,
            'credentials:orphan-source-ref', 'active', 'user-1'
          )
      `
      )
      .run();

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async (seed) => [
        liveHetznerOffering({
          provider: seed.provider,
          location: 'ewr',
          providerInstanceType: `${seed.provider}-native-large`,
          displayName: `${seed.provider} native large`,
        }),
      ],
    });

    expect(
      sqlite?.prepare(`SELECT status FROM capacity_sources WHERE id = 'source-no-candidates'`).get()
    ).toEqual({ status: 'disabled' });
  });

  it('activates refreshed catalog additions and places work on the provider-native SKU', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });
    const initialOfferings = [
      liveHetznerOffering({
        location: 'fsn1',
        providerInstanceType: 'cx23',
        displayName: 'CX23',
      }),
    ];
    const expandedOfferings = [
      ...initialOfferings,
      liveHetznerOffering({
        location: 'fsn1',
        providerInstanceType: 'cpx62',
        displayName: 'CPX62',
        vcpu: 32,
        ramGb: 64,
        memoryGb: 64,
        memoryMb: 65_536,
        storageGb: 480,
        diskGb: 480,
        price: '€48.12/mo',
        priceMonthly: 48.12,
        priceHourly: 0.06592,
      }),
    ];

    const initial = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => initialOfferings,
    });
    const sourceId = initial.user?.sources[0]?.id;
    expect(sourceId).toBeDefined();
    expect(initial.user?.candidates.map((candidate) => candidate.providerInstanceType)).toEqual([
      'cx23',
    ]);

    const discovered = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => expandedOfferings,
    });
    expect(discovered.user?.activeCandidateCount).toBe(1);
    expect(discovered.user?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerInstanceType: 'cpx62', status: 'disabled' }),
      ])
    );

    const update = await updateDefaultCapacityPool(db as never, {
      scope: 'user',
      ownerUserId: 'user-1',
      ownerProjectId: null,
      catalogAdditions: [
        {
          sourceId: sourceId!,
          provider: 'hetzner',
          location: 'fsn1',
          providerInstanceType: 'cpx62',
          providerInstanceSku: null,
        },
      ],
    });

    expect(update).toMatchObject({
      poolFound: true,
      missingCatalogAdditions: [],
      unavailableCatalogAdditions: [],
      missingCandidateIds: [],
      unavailableCandidateIds: [],
    });
    expect(update.summary?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerInstanceType: 'cpx62',
          providerInstanceVcpuCount: 32,
          providerInstanceMemoryMb: 65_536,
          providerInstancePriceCurrency: 'EUR',
          providerInstancePriceMonthlyCents: 4812,
          providerInstanceCatalogSource: 'api',
          status: 'active',
        }),
      ])
    );

    const placement = resolveTaskStartPlacement({
      entryPoint: 'task-submit',
      taskId: 'catalog-addition-placement-task',
      projectId: 'project-1',
      userId: 'user-1',
      project: {
        id: 'project-1',
        defaultProvider: 'hetzner',
        defaultLocation: 'fsn1',
        defaultVmSize: 'small',
      },
      explicit: { provider: 'hetzner', vmLocation: 'fsn1' },
      credentialProjectPolicy: 'current-project-unless-inherited',
      taskModeDefault: 'task',
      resourceRequirements: {
        task: { minVcpu: 32, minMemoryGb: 64 },
      },
    });
    const selection = await resolveTaskStartCapacityPoolSelection(db as never, placement, {
      ensure: false,
    });

    expect(selection?.candidates[0]).toMatchObject({
      provider: 'hetzner',
      location: 'fsn1',
      providerInstanceType: 'cpx62',
      providerInstanceVcpuCount: 32,
      providerInstanceMemoryMb: 65_536,
    });

    const reconciled = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => expandedOfferings,
    });
    expect(reconciled.user?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerInstanceType: 'cpx62', status: 'active' }),
      ])
    );
  });

  it('preserves disabled and deleted concrete non-legacy offerings across reconciliation', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });
    const offerings = [
      liveHetznerOffering({
        location: 'fsn1',
        providerInstanceType: 'cx23',
        displayName: 'CX23',
      }),
      liveHetznerOffering({
        location: 'fsn1',
        providerInstanceType: 'cpx62',
        displayName: 'CPX62',
        vcpu: 32,
        ramGb: 64,
        memoryGb: 64,
        memoryMb: 65_536,
        storageGb: 480,
        diskGb: 480,
        price: '€48.12/mo',
        priceMonthly: 48.12,
        priceHourly: 0.06592,
      }),
      liveHetznerOffering({
        location: 'hel1',
        providerInstanceType: 'ccx63',
        displayName: 'CCX63',
        vcpu: 48,
        ramGb: 192,
        memoryGb: 192,
        memoryMb: 196_608,
        storageGb: 960,
        diskGb: 960,
        price: '€168.44/mo',
        priceMonthly: 168.44,
        priceHourly: 0.23074,
      }),
    ];

    const initial = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => offerings,
    });
    const cpx62 = initial.user?.candidates.find(
      (candidate) => candidate.providerInstanceType === 'cpx62'
    );
    const ccx63 = initial.user?.candidates.find(
      (candidate) => candidate.providerInstanceType === 'ccx63'
    );
    expect(cpx62?.status).toBe('disabled');
    expect(ccx63?.status).toBe('disabled');

    const update = await updateDefaultCapacityPool(db as never, {
      scope: 'user',
      ownerUserId: 'user-1',
      ownerProjectId: null,
      candidates: [
        { id: cpx62!.id, status: 'disabled' },
        { id: ccx63!.id, status: 'deleted' },
      ],
    });
    expect(update.unavailableCandidateIds).toEqual([]);
    expect(update.missingCandidateIds).toEqual([]);

    const reconciled = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => offerings,
    });

    expect(reconciled.user?.activeCandidateCount).toBe(1);
    expect(reconciled.user?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerInstanceType: 'cx23', status: 'active' }),
        expect.objectContaining({ providerInstanceType: 'cpx62', status: 'disabled' }),
        expect.objectContaining({ providerInstanceType: 'ccx63', status: 'deleted' }),
      ])
    );
  });

  it('rejects reactivating removed candidates that are no longer in the current catalog', async () => {
    createDb();
    seedUserCredential({ id: 'user-hetzner' });
    const db = drizzleD1(createSqliteD1WithBindLimit(sqlite!, 100), { schema });
    const offerings = [
      liveHetznerOffering({
        location: 'fsn1',
        providerInstanceType: 'cx23',
        displayName: 'CX23',
      }),
      liveHetznerOffering({
        location: 'fsn1',
        providerInstanceType: 'provider-native-stale',
        displayName: 'Provider native stale',
      }),
    ];

    const ensured = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => offerings,
    });
    const staleCandidate = ensured.user?.candidates[1];
    expect(staleCandidate).toBeDefined();

    await updateDefaultCapacityPool(db as never, {
      scope: 'user',
      ownerUserId: 'user-1',
      ownerProjectId: null,
      candidates: [{ id: staleCandidate!.id, status: 'deleted' }],
    });
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => offerings.slice(0, 1),
    });

    const update = await updateDefaultCapacityPool(db as never, {
      scope: 'user',
      ownerUserId: 'user-1',
      ownerProjectId: null,
      candidates: [{ id: staleCandidate!.id, status: 'active' }],
    });

    expect(update.summary).toBeNull();
    expect(update.unavailableCandidateIds).toEqual([staleCandidate!.id]);
    expect(
      getRows<{ status: string; provider_instance_catalog_source: string | null }>(`
        SELECT status, provider_instance_catalog_source
        FROM capacity_pool_candidates
        WHERE id = '${staleCandidate!.id}'
      `)[0]
    ).toEqual({ status: 'deleted', provider_instance_catalog_source: 'api' });
  });

  it.each(['deleted', 'disabled'] as const)(
    'translates %s legacy size rows onto matching live catalog offerings only',
    async (legacyStatus) => {
      await expectLegacyStatusMappedToLiveCatalog(legacyStatus);
    }
  );

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
    const db = await seedVultrDefaultPool();

    setUserDefaultPoolStrategy('pack');
    const packSelection = await selectVultrDefaultPoolCandidates(db, 'strategy-task');
    expect(packSelection?.strategy).toBe('pack');
    expect(packSelection?.candidates[0]).toMatchObject({
      provider: 'vultr',
      location: getDefaultLocationForProvider('vultr'),
      providerInstanceType: 'vc2-6c-16gb',
      providerInstanceVcpuCount: 6,
      providerInstanceMemoryMb: 16 * 1024,
    });

    setUserDefaultPoolStrategy('smallest-fit');
    const smallestFitSelection = await selectVultrDefaultPoolCandidates(db, 'strategy-task');
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
    const db = await seedVultrDefaultPool();
    setUserDefaultPoolStrategy('smallest-fit');

    const selection = await selectVultrDefaultPoolCandidates(db, 'resource-heavy-task', {
      task: { minVcpu: 5, minMemoryGb: 12 },
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
    const db = await seedVultrDefaultPool();

    const selection = await selectVultrDefaultPoolCandidates(db, 'resource-too-heavy-task', {
      task: { minVcpu: 128, minMemoryGb: 512 },
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

  it('ignores disabled catalog-visible offerings during placement even when they satisfy resources', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });

    const ensured = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: 'cx23',
          displayName: 'CX23',
        }),
        liveHetznerOffering({
          location: 'hel1',
          providerInstanceType: 'ccx63',
          displayName: 'CCX63',
          vcpu: 48,
          ramGb: 192,
          memoryGb: 192,
          memoryMb: 196_608,
          storageGb: 960,
          diskGb: 960,
          price: '€168.44/mo',
          priceMonthly: 168.44,
          priceHourly: 0.23074,
        }),
      ],
    });
    expect(ensured.user?.activeCandidateCount).toBe(1);
    expect(ensured.user?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerInstanceType: 'cx23', status: 'active' }),
        expect.objectContaining({ providerInstanceType: 'ccx63', status: 'disabled' }),
      ])
    );

    const placement = resolveTaskStartPlacement({
      entryPoint: 'task-submit',
      taskId: 'disabled-expensive-catalog-placement-task',
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
      resourceRequirements: {
        task: { minVcpu: 48, minMemoryGb: 192 },
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
    expect(() => resolveCapacityAwareCredentialLookup(placement, selection)).toThrow(
      PlacementResolutionError
    );
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

  it('preserves active membership when a catalog entry disappears and restores it when it returns', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });
    const offering = liveHetznerOffering({
      location: 'fsn1',
      providerInstanceType: 'cx23',
      displayName: 'CX23',
    });

    const initial = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [offering],
    });
    const candidate = initial.user?.candidates.find((row) => row.providerInstanceType === 'cx23');
    expect(candidate?.status).toBe('active');

    const missing = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [],
    });
    expect(missing.user?.effectiveState).toBe('catalog-unavailable');
    expect(
      getRows<{
        status: string;
        catalog_availability: string;
        provider_instance_catalog_source: string | null;
      }>(
        "SELECT status, catalog_availability, provider_instance_catalog_source FROM capacity_pool_candidates WHERE provider_instance_type = 'cx23'"
      )[0]
    ).toMatchObject({
      status: 'active',
      catalog_availability: 'last-known-unavailable',
      provider_instance_catalog_source: 'api',
    });
    const missingSelection = await resolveTaskStartCapacityPoolSelection(
      db as never,
      resolveTaskStartPlacement({
        entryPoint: 'task-submit',
        taskId: 'catalog-missing-task',
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
      }),
      { ensure: false }
    );
    expect(missingSelection?.effectiveState).toBe('catalog-unavailable');
    expect(missingSelection?.candidates).toHaveLength(0);

    const returned = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [offering],
    });
    expect(returned.user?.effectiveState).toBe('configured-ready');
    expect(
      getRows<{
        status: string;
        catalog_availability: string;
        provider_instance_catalog_source: string | null;
      }>(
        "SELECT status, catalog_availability, provider_instance_catalog_source FROM capacity_pool_candidates WHERE provider_instance_type = 'cx23'"
      )[0]
    ).toMatchObject({
      status: 'active',
      catalog_availability: 'available',
      provider_instance_catalog_source: 'api',
    });
  });

  it('does not replace last-known catalog state with static offerings after refresh failure', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });
    const offering = liveHetznerOffering({
      location: 'fsn1',
      providerInstanceType: 'cx23',
      displayName: 'CX23',
    });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [offering],
    });
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [],
    });
    const unavailableBeforeFailure = getRows<{
      provider_instance_type: string;
      catalog_availability: string;
      provider_instance_catalog_source: string | null;
    }>(
      'SELECT provider_instance_type, catalog_availability, provider_instance_catalog_source FROM capacity_pool_candidates'
    );

    await expect(
      ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
        userId: 'user-1',
        includeInstallation: false,
        offeringResolver: async () => {
          throw new Error('catalog decrypt failed');
        },
      })
    ).rejects.toThrow('catalog decrypt failed');

    expect(
      getRows<{
        provider_instance_type: string;
        catalog_availability: string;
        provider_instance_catalog_source: string | null;
      }>(
        'SELECT provider_instance_type, catalog_availability, provider_instance_catalog_source FROM capacity_pool_candidates'
      )
    ).toEqual(unavailableBeforeFailure);
    expect(
      getRows<{ configuration_state: string }>(
        "SELECT configuration_state FROM capacity_pools WHERE scope = 'user'"
      )[0]
    ).toEqual({ configuration_state: 'catalog-unavailable' });
  });

  it('does not let an older empty refresh overwrite a newer successful reconciliation', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });
    const initialOffering = liveHetznerOffering({
      location: 'fsn1',
      providerInstanceType: 'cx23',
      displayName: 'CX23',
    });
    const newerOffering = liveHetznerOffering({
      location: 'fsn1',
      providerInstanceType: 'cx33',
      displayName: 'CX33',
    });
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [initialOffering],
    });

    let releaseOlderRefresh: (() => void) | null = null;
    const olderRefresh = ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => {
        await new Promise<void>((resolve) => {
          releaseOlderRefresh = resolve;
        });
        return [];
      },
    });
    await vi.waitFor(() => expect(releaseOlderRefresh).toBeTypeOf('function'));

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [newerOffering],
    });
    releaseOlderRefresh?.();
    await olderRefresh;

    expect(
      getRows<{
        provider_instance_type: string;
        catalog_availability: string;
        provider_instance_catalog_source: string | null;
      }>(
        'SELECT provider_instance_type, catalog_availability, provider_instance_catalog_source FROM capacity_pool_candidates ORDER BY provider_instance_type'
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider_instance_type: 'cx33',
          catalog_availability: 'available',
          provider_instance_catalog_source: 'api',
        }),
      ])
    );
    expect(
      getRows<{ configuration_state: string }>(
        "SELECT configuration_state FROM capacity_pools WHERE scope = 'user'"
      )[0]
    ).toEqual({ configuration_state: 'configured-ready' });
  });

  it('does not let a stale refresh reactivate a source disabled by a concurrent credential edit', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });

    let releaseOlderRefresh: (() => void) | null = null;
    const olderRefresh = ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => {
        await new Promise<void>((resolve) => {
          releaseOlderRefresh = resolve;
        });
        return [
          liveHetznerOffering({
            location: 'fsn1',
            providerInstanceType: 'stale-refresh-only',
            displayName: 'Stale Refresh Only',
          }),
        ];
      },
    });
    await vi.waitFor(() => expect(releaseOlderRefresh).toBeTypeOf('function'));

    sqlite
      ?.prepare("UPDATE credentials SET is_active = 0, updated_at = ? WHERE id = 'user-hetzner'")
      .run('2026-08-28T14:00:00.000Z');
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });
    releaseOlderRefresh?.();
    await olderRefresh;

    expect(
      getRows<{ status: string }>(
        "SELECT status FROM capacity_sources WHERE credential_id = 'user-hetzner'"
      )[0]
    ).toEqual({ status: 'disabled' });
    expect(
      getRows<{ provider_instance_type: string }>(
        "SELECT provider_instance_type FROM capacity_pool_candidates WHERE provider_instance_type = 'stale-refresh-only'"
      )
    ).toEqual([]);
    expect(
      getRows<{ configuration_state: string }>(
        "SELECT configuration_state FROM capacity_pools WHERE scope = 'user'"
      )[0]
    ).toEqual({ configuration_state: 'source-disabled' });
  });

  it('does not let a stale seed snapshot disable a newly added credential source', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner-a' });

    let releaseOlderRefresh: (() => void) | null = null;
    const olderRefresh = ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => {
        await new Promise<void>((resolve) => {
          releaseOlderRefresh = resolve;
        });
        return [
          liveHetznerOffering({
            location: 'fsn1',
            providerInstanceType: 'cx23',
            displayName: 'CX23',
          }),
        ];
      },
    });
    await vi.waitFor(() => expect(releaseOlderRefresh).toBeTypeOf('function'));

    seedUserCredential({ id: 'user-hetzner-b' });
    const newerDb = poolDb();
    await ensureDefaultCapacityPoolsForExistingCredentials(newerDb as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async (seed) => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: seed.id.endsWith('-b') ? 'cx33' : 'cx23',
          displayName: seed.id.endsWith('-b') ? 'CX33' : 'CX23',
        }),
      ],
    });

    releaseOlderRefresh?.();
    await olderRefresh;

    expect(
      getRows<{ credential_id: string; status: string }>(`
        SELECT credential_id, status
        FROM capacity_sources
        WHERE credential_id IN ('user-hetzner-a', 'user-hetzner-b')
        ORDER BY credential_id
      `)
    ).toEqual([
      { credential_id: 'user-hetzner-a', status: 'active' },
      { credential_id: 'user-hetzner-b', status: 'active' },
    ]);
  });

  it('does not let seeds added after an old seed SELECT be disabled by old cleanup', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner-a' });

    let seedSelectionPaused = false;
    let releaseOlderCleanup: (() => void) | null = null;
    const olderRefresh = ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      afterCredentialSeedSelection: async ({ scope, seedSnapshotGeneration, seedCount }) => {
        if (scope.scope !== 'user' || seedSelectionPaused) return;
        seedSelectionPaused = true;
        expect(seedSnapshotGeneration).toBe(0);
        expect(seedCount).toBe(1);
        await new Promise<void>((resolve) => {
          releaseOlderCleanup = resolve;
        });
      },
      offeringResolver: async (seed) => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: seed.id.endsWith('-b') ? 'cx33' : 'cx23',
          displayName: seed.id.endsWith('-b') ? 'CX33' : 'CX23',
        }),
      ],
    });
    await vi.waitFor(() => expect(releaseOlderCleanup).toBeTypeOf('function'));

    seedUserCredential({ id: 'user-hetzner-b' });
    const newerDb = poolDb();
    await ensureDefaultCapacityPoolsForExistingCredentials(newerDb as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async (seed) => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: seed.id.endsWith('-b') ? 'cx33' : 'cx23',
          displayName: seed.id.endsWith('-b') ? 'CX33' : 'CX23',
        }),
      ],
    });

    releaseOlderCleanup?.();
    await olderRefresh;

    expect(
      getRows<{ credential_id: string; status: string }>(`
        SELECT credential_id, status
        FROM capacity_sources
        WHERE credential_id IN ('user-hetzner-a', 'user-hetzner-b')
        ORDER BY credential_id
      `)
    ).toEqual([
      { credential_id: 'user-hetzner-a', status: 'active' },
      { credential_id: 'user-hetzner-b', status: 'active' },
    ]);
    expect(getCatalogCandidateRow('cx33')).toMatchObject({
      provider_instance_type: 'cx33',
      provider_instance_catalog_source: 'api',
    });
  });

  it('does not let a stale inactive seed disable a freshly re-enabled credential source', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner-a' });
    seedUserCredential({ id: 'user-hetzner-b' });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async (seed) => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: seed.id.endsWith('-b') ? 'cx33' : 'cx23',
          displayName: seed.id.endsWith('-b') ? 'CX33' : 'CX23',
        }),
      ],
    });

    sqlite
      ?.prepare("UPDATE credentials SET is_active = 0, updated_at = ? WHERE id = 'user-hetzner-b'")
      .run('2026-08-28T01:00:00.000Z');

    let releaseOldInactiveSeed: (() => void) | null = null;
    const oldInactiveEnsure = ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      afterCredentialSeedSelection: async ({ scope, seedSnapshotGeneration, seedCount }) => {
        if (scope.scope !== 'user') return;
        expect(seedSnapshotGeneration).toBe(2);
        expect(seedCount).toBe(2);
        await new Promise<void>((resolve) => {
          releaseOldInactiveSeed = resolve;
        });
      },
      offeringResolver: async (seed) => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: seed.id.endsWith('-b') ? 'old-inactive-b' : 'old-active-a',
          displayName: seed.id.endsWith('-b') ? 'Old inactive B' : 'Old active A',
        }),
      ],
    });
    await vi.waitFor(() => expect(releaseOldInactiveSeed).toBeTypeOf('function'));

    sqlite
      ?.prepare("UPDATE credentials SET is_active = 1, updated_at = ? WHERE id = 'user-hetzner-b'")
      .run('2026-08-28T02:00:00.000Z');
    const newerDb = poolDb();
    await ensureDefaultCapacityPoolsForExistingCredentials(newerDb as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async (seed) => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: seed.id.endsWith('-b') ? 'fresh-b' : 'fresh-a',
          displayName: seed.id.endsWith('-b') ? 'Fresh B' : 'Fresh A',
        }),
      ],
    });

    releaseOldInactiveSeed?.();
    await oldInactiveEnsure;

    expect(
      getRows<{ credential_id: string; status: string; source_generation: number }>(`
        SELECT credential_id, status, source_generation
        FROM capacity_sources
        WHERE credential_id IN ('user-hetzner-a', 'user-hetzner-b')
        ORDER BY credential_id
      `)
    ).toEqual([
      { credential_id: 'user-hetzner-a', status: 'active', source_generation: 5 },
      { credential_id: 'user-hetzner-b', status: 'active', source_generation: 4 },
    ]);
    expect(
      getRows<{ provider_instance_type: string }>(`
        SELECT provider_instance_type
        FROM capacity_pool_candidates
        WHERE provider_instance_type = 'old-inactive-b'
      `)
    ).toEqual([]);
  });

  it('rejects stale active publications after encrypted-token rotation without timestamp movement', async () => {
    const db = createDb();
    seedUserCredential({
      id: 'user-hetzner',
      encryptedToken: 'encrypted-token-v1',
      iv: 'iv-v1',
      updatedAt: '2026-08-28T10:00:00.000Z',
    });

    let releaseOldSeed: (() => void) | null = null;
    const oldEnsure = ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      afterCredentialSeedSelection: async ({ scope }) => {
        if (scope.scope !== 'user') return;
        await new Promise<void>((resolve) => {
          releaseOldSeed = resolve;
        });
      },
      offeringResolver: async () => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: 'old-token-publication',
          displayName: 'Old token publication',
        }),
      ],
    });
    await vi.waitFor(() => expect(releaseOldSeed).toBeTypeOf('function'));

    sqlite
      ?.prepare(
        `
        UPDATE credentials
        SET encrypted_token = 'encrypted-token-v2', iv = 'iv-v2'
        WHERE id = 'user-hetzner'
      `
      )
      .run();
    const newerDb = poolDb();
    await ensureDefaultCapacityPoolsForExistingCredentials(newerDb as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: 'new-token-publication',
          displayName: 'New token publication',
        }),
      ],
    });

    releaseOldSeed?.();
    await oldEnsure;

    expect(getCatalogCandidateRow('new-token-publication')).toMatchObject({
      provider_instance_type: 'new-token-publication',
      provider_instance_catalog_source: 'api',
    });
    expect(getCatalogCandidateRow('old-token-publication')).toBeUndefined();
  });

  it('rejects stale inactive composable seeds after attachment and configuration target changes', async () => {
    const db = createDb();
    seedComposableCloudCredential({
      credentialId: 'cc-cred-rotation',
      configurationId: 'cc-cfg-rotation',
      attachmentId: 'cc-att-rotation',
      provider: 'hetzner',
    });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: 'cx23',
          displayName: 'CX23',
        }),
      ],
    });

    sqlite
      ?.prepare(
        "UPDATE cc_attachments SET is_active = 0, updated_at = ? WHERE id = 'cc-att-rotation'"
      )
      .run('2026-08-28T01:00:00.000Z');

    let releaseOldInactiveSeed: (() => void) | null = null;
    const oldInactiveEnsure = ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      afterCredentialSeedSelection: async ({ scope, seedCount }) => {
        if (scope.scope !== 'user') return;
        expect(seedCount).toBe(1);
        await new Promise<void>((resolve) => {
          releaseOldInactiveSeed = resolve;
        });
      },
      offeringResolver: async () => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: 'stale-composable-target',
          displayName: 'Stale composable target',
        }),
      ],
    });
    await vi.waitFor(() => expect(releaseOldInactiveSeed).toBeTypeOf('function'));

    sqlite
      ?.prepare(
        `
        UPDATE cc_attachments
        SET is_active = 1, consumer_target = 'vultr', updated_at = '2026-08-28T02:00:00.000Z'
        WHERE id = 'cc-att-rotation'
      `
      )
      .run();
    sqlite
      ?.prepare(
        `
        UPDATE cc_configurations
        SET consumer_target = 'vultr', updated_at = '2026-08-28T02:00:00.000Z'
        WHERE id = 'cc-cfg-rotation'
      `
      )
      .run();
    const newerDb = poolDb();
    await ensureDefaultCapacityPoolsForExistingCredentials(newerDb as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async (seed) => [
        liveHetznerOffering({
          provider: seed.provider,
          location: seed.provider === 'vultr' ? 'ewr' : 'fsn1',
          providerInstanceType: seed.provider === 'vultr' ? 'vc2-2c-4gb' : 'cx23',
          displayName: seed.provider === 'vultr' ? 'vc2-2c-4gb' : 'CX23',
        }),
      ],
    });

    releaseOldInactiveSeed?.();
    await oldInactiveEnsure;

    expect(
      getRows<{ provider: string; status: string }>(`
        SELECT provider, status
        FROM capacity_sources
        WHERE external_source_ref = 'cc_attachments:cc-att-rotation'
      `)[0]
    ).toEqual({ provider: 'vultr', status: 'active' });
    expect(getCatalogCandidateRow('vc2-2c-4gb')).toMatchObject({
      provider_instance_type: 'vc2-2c-4gb',
      provider_instance_catalog_source: 'api',
    });
    expect(getCatalogCandidateRow('stale-composable-target')).toBeUndefined();
  });

  it('uses source-generation CAS across service contexts at the publication boundary', async () => {
    const db = createDb();
    seedUserCredential({
      id: 'user-hetzner',
      provider: 'hetzner',
      updatedAt: '2026-08-28T10:00:00.000Z',
    });
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: 'cx23',
          displayName: 'CX23',
        }),
      ],
    });

    let releaseOlderPublication: (() => void) | null = null;
    const olderPublication = ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      beforeSourcePublication: async () => {
        await new Promise<void>((resolve) => {
          releaseOlderPublication = resolve;
        });
      },
      offeringResolver: async () => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: 'old-publisher-only',
          displayName: 'Old Publisher Only',
        }),
      ],
    });
    await vi.waitFor(() => expect(releaseOlderPublication).toBeTypeOf('function'));

    sqlite
      ?.prepare(
        `
        UPDATE credentials
        SET provider = 'vultr', updated_at = '2026-08-28T10:00:00.000Z'
        WHERE id = 'user-hetzner'
      `
      )
      .run();
    const newerDb = poolDb();
    await ensureDefaultCapacityPoolsForExistingCredentials(newerDb as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [
        liveHetznerOffering({
          provider: 'vultr',
          location: 'ewr',
          providerInstanceType: 'vc2-2c-4gb',
          displayName: 'vc2-2c-4gb',
        }),
      ],
    });

    releaseOlderPublication?.();
    await olderPublication;

    expect(
      getRows<{ provider: string; source_generation: number }>(`
        SELECT provider, source_generation
        FROM capacity_sources
        WHERE credential_id = 'user-hetzner'
      `)[0]
    ).toEqual({ provider: 'vultr', source_generation: 2 });
    expect(
      getRows<{ provider_instance_type: string }>(`
        SELECT provider_instance_type
        FROM capacity_pool_candidates
        WHERE provider_instance_type = 'old-publisher-only'
      `)
    ).toEqual([]);
  });

  it('chunks missing-candidate reconciliation below the D1 bind limit', async () => {
    createDb();
    seedUserCredential({ id: 'user-hetzner' });
    const db = drizzleD1(createSqliteD1WithBindLimit(sqlite!, 100), { schema });
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      candidatePublishBatchSize: 1000,
      offeringResolver: async () =>
        Array.from({ length: 101 }, (_, index) =>
          liveHetznerOffering({
            location: 'fsn1',
            providerInstanceType: `disappearing-${index}`,
            displayName: `Disappearing ${index}`,
          })
        ),
    });

    const [deletedCandidate, disabledCandidate] = getRows<{ id: string }>(`
      SELECT id
      FROM capacity_pool_candidates
      WHERE workload_role = 'workspace'
      ORDER BY id
      LIMIT 2
    `);
    sqlite
      ?.prepare("UPDATE capacity_pool_candidates SET status = 'deleted' WHERE id = ?")
      .run(deletedCandidate.id);
    sqlite
      ?.prepare("UPDATE capacity_pool_candidates SET status = 'disabled' WHERE id = ?")
      .run(disabledCandidate.id);

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      candidatePublishBatchSize: 1000,
      offeringResolver: async () => [],
    });

    // 101 offerings x 2 materialized workload roles: every row is chunked under the D1 bind
    // ceiling and marked unavailable, and none of them was skipped.
    expect(
      getCount('capacity_pool_candidates', "catalog_availability = 'last-known-unavailable'")
    ).toBe(202);
    expect(
      getRows<{ status: string; count: number }>(`
        SELECT status, COUNT(*) AS count
        FROM capacity_pool_candidates
        WHERE id IN ('${deletedCandidate.id}', '${disabledCandidate.id}')
        GROUP BY status
        ORDER BY status
      `)
    ).toEqual([
      { status: 'deleted', count: 1 },
      { status: 'disabled', count: 1 },
    ]);
  });

  it('keeps deliberately removed catalog entries removed when they disappear and return', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });
    const offering = liveHetznerOffering({
      location: 'fsn1',
      providerInstanceType: 'cx23',
      displayName: 'CX23',
    });

    const initial = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [offering],
    });
    const candidate = initial.user?.candidates.find((row) => row.providerInstanceType === 'cx23');
    expect(candidate?.id).toBeTruthy();

    await updateDefaultCapacityPool(db as never, {
      scope: 'user',
      ownerUserId: 'user-1',
      ownerProjectId: null,
      candidates: [{ id: candidate!.id, status: 'deleted' }],
    });
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [],
    });
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [offering],
    });

    expect(
      getRows<{ status: string; catalog_availability: string }>(
        "SELECT status, catalog_availability FROM capacity_pool_candidates WHERE provider_instance_type = 'cx23'"
      )[0]
    ).toEqual({ status: 'deleted', catalog_availability: 'available' });
  });

  it('normalizes hourly and monthly prices before balanced selection', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: 'expensive-hourly',
          displayName: 'Expensive hourly',
          priceMonthly: null,
          priceHourly: 0.2,
        }),
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: 'cheap-monthly',
          displayName: 'Cheap monthly',
          priceMonthly: 10,
          priceHourly: null,
        }),
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: 'unknown-price',
          displayName: 'Unknown price',
          price: null,
          priceMonthly: null,
          priceHourly: null,
          currency: null,
        }),
      ],
    });
    sqlite
      ?.prepare(
        "UPDATE capacity_pool_candidates SET priority = 0, status = 'active' WHERE pool_id LIKE 'cap-pool-default:user:%'"
      )
      .run();

    const selection = await resolveTaskStartCapacityPoolSelection(
      db as never,
      resolveTaskStartPlacement({
        entryPoint: 'task-submit',
        taskId: 'price-normalization-task',
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
      }),
      { ensure: false }
    );

    expect(selection?.candidates.map((candidate) => candidate.providerInstanceType)).toEqual([
      'cheap-monthly',
      'expensive-hourly',
      'unknown-price',
    ]);
    expect(selection?.candidates[2]?.priceComparability).toBe('unknown');
  });

  it('does not compare raw prices across currencies and marks them noncomparable', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: 'eur-expensive',
          displayName: 'EUR expensive',
          priceMonthly: 100_000,
          priceHourly: null,
          currency: 'EUR',
        }),
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: 'usd-cheap',
          displayName: 'USD cheap',
          priceMonthly: 1,
          priceHourly: null,
          currency: 'USD',
        }),
      ],
    });
    sqlite?.prepare("UPDATE capacity_pool_candidates SET priority = 0, status = 'active'").run();

    const selection = await resolveTaskStartCapacityPoolSelection(
      db as never,
      defaultTaskPlacement('currency-mismatch-task'),
      { ensure: false }
    );

    expect(selection?.candidates.map((candidate) => candidate.providerInstanceType)).toEqual([
      'eur-expensive',
      'usd-cheap',
    ]);
    expect(selection?.candidates.map((candidate) => candidate.priceComparability)).toEqual([
      'currency-mismatch',
      'currency-mismatch',
    ]);
  });

  it('keeps explicit priority ahead of unknown price sentinels', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      offeringResolver: async () => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: 'priority-zero-unknown',
          displayName: 'Priority zero unknown',
          price: null,
          priceMonthly: null,
          priceHourly: null,
          currency: null,
        }),
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: 'priority-one-known',
          displayName: 'Priority one known',
        }),
      ],
    });
    sqlite
      ?.prepare(
        `
        UPDATE capacity_pool_candidates
        SET priority = CASE provider_instance_type
          WHEN 'priority-zero-unknown' THEN 0
          ELSE 1
        END,
        status = 'active'
      `
      )
      .run();

    const selection = await resolveTaskStartCapacityPoolSelection(
      db as never,
      defaultTaskPlacement('unknown-price-priority-task'),
      { ensure: false }
    );

    expect(selection?.candidates[0]?.providerInstanceType).toBe('priority-zero-unknown');
    expect(selection?.candidates[0]?.priceComparability).toBe('unknown');
  });

  it.each(['balanced', 'pack', 'spread', 'smallest-fit'] as const)(
    'keeps %s ordering finite with huge valid weights',
    async (strategy) => {
      const db = createDb();
      seedUserCredential({ id: 'user-hetzner' });
      await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
        userId: 'user-1',
        includeInstallation: false,
        offeringResolver: async () => [
          liveHetznerOffering({
            location: 'fsn1',
            providerInstanceType: 'tiny',
            displayName: 'Tiny',
            vcpu: 2,
            memoryMb: 4096,
            ramGb: 4,
            memoryGb: 4,
          }),
          liveHetznerOffering({
            location: 'fsn1',
            providerInstanceType: 'large-fit',
            displayName: 'Large fit',
            vcpu: 16,
            memoryMb: 32768,
            ramGb: 32,
            memoryGb: 32,
          }),
        ],
      });
      sqlite
        ?.prepare(
          "UPDATE capacity_pools SET strategy = ? WHERE scope = 'user' AND owner_user_id = 'user-1'"
        )
        .run(strategy);
      sqlite?.prepare("UPDATE capacity_pool_candidates SET priority = 0, status = 'active'").run();
      sqlite
        ?.prepare(
          `
          INSERT INTO platform_settings (key, value, updated_at)
          VALUES ('capacityPools.selectionSettings.v1', ?, '2026-08-28T12:00:00.000Z')
        `
        )
        .run(
          JSON.stringify({
            selectionWeights: {
              priority: 1e300,
              price: 1e300,
              fit: 1e300,
              capacity: 1e300,
              candidateOrder: 1e300,
            },
            rolloutCohortPercent: 100,
          })
        );

      const selection = await resolveTaskStartCapacityPoolSelection(
        db as never,
        defaultTaskPlacement(`huge-weights-${strategy}`),
        { ensure: false, env: { CAPACITY_POOL_SELECTION_SETTINGS_JSON: '' } as Env }
      );

      expect(selection?.candidates).toHaveLength(2);
      expect(
        selection?.candidates.map((candidate) => candidate.providerInstanceType).sort()
      ).toEqual(['large-fit', 'tiny']);
    }
  );

  it('keeps zero-active configured default pools authoritative for placement reads', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-vultr', provider: 'vultr' });

    const ensured = await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });
    const candidates = ensured.user?.candidates ?? [];
    expect(candidates.length).toBe(expectedCandidateCount('vultr'));

    const update = await updateDefaultCapacityPool(db as never, {
      scope: 'user',
      ownerUserId: 'user-1',
      ownerProjectId: null,
      candidates: candidates.map((candidate) => ({ id: candidate.id, status: 'deleted' })),
    });

    expect(update.poolFound).toBe(true);
    expect(update.summary?.pool).toMatchObject({
      scope: 'user',
      status: 'active',
      configurationState: 'configured-empty',
    });
    expect(update.summary?.effectiveState).toBe('configured-empty');
    expect(update.summary?.activeCandidateCount).toBe(0);
    expect(update.summary?.candidates).toHaveLength(candidates.length);

    const activeOnly = await readDefaultCapacityPoolSummaries(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });
    expect(activeOnly.user?.effectiveState).toBe('configured-empty');

    const editorRead = await readDefaultCapacityPoolSummaries(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      includeDisabled: true,
    });
    expect(editorRead.user?.pool).toMatchObject({
      scope: 'user',
      status: 'active',
      configurationState: 'configured-empty',
    });
    expect(editorRead.user?.activeCandidateCount).toBe(0);
    expect(editorRead.user?.candidates).toHaveLength(candidates.length);

    const placementRead = await resolveEffectiveDefaultCapacityPoolSummary(db as never, {
      userId: 'user-1',
      projectId: 'project-1',
      ensure: false,
      includeInstallation: false,
    });
    expect(placementRead?.pool.scope).toBe('user');
    expect(placementRead?.effectiveState).toBe('configured-empty');
  });

  it('suppresses placement candidates for authoritative non-ready pool states', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });

    for (const state of [
      'migration-pending',
      'source-disabled',
      'configured-empty',
      'catalog-unavailable',
    ] as const) {
      sqlite
        ?.prepare(
          `
          UPDATE capacity_pools
          SET configuration_state = ?, migration_state = CASE WHEN ? = 'migration-pending' THEN 'pending' ELSE 'complete' END
          WHERE scope = 'user' AND owner_user_id = 'user-1'
        `
        )
        .run(state, state);
      if (state === 'source-disabled') {
        sqlite?.prepare("UPDATE capacity_sources SET status = 'disabled'").run();
      } else {
        sqlite?.prepare("UPDATE capacity_sources SET status = 'active'").run();
      }
      if (state === 'configured-empty') {
        sqlite?.prepare("UPDATE capacity_pool_candidates SET status = 'disabled'").run();
      } else {
        sqlite?.prepare("UPDATE capacity_pool_candidates SET status = 'active'").run();
      }
      if (state === 'catalog-unavailable') {
        sqlite
          ?.prepare(
            "UPDATE capacity_pool_candidates SET catalog_availability = 'last-known-unavailable', provider_instance_catalog_source = NULL"
          )
          .run();
      } else {
        sqlite
          ?.prepare(
            "UPDATE capacity_pool_candidates SET catalog_availability = 'available', provider_instance_catalog_source = 'static'"
          )
          .run();
      }

      const selection = await resolveTaskStartCapacityPoolSelection(
        db as never,
        defaultTaskPlacement(`non-ready-${state}`),
        { ensure: false }
      );
      expect(selection?.effectiveState).toBe(state);
      expect(selection?.candidates).toHaveLength(0);
    }
  });

  it('returns no candidates for a partially initialized migration-pending pool with ensure disabled', async () => {
    const db = createDb();
    seedUserCredential({ id: 'user-hetzner' });
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });
    sqlite
      ?.prepare(
        "UPDATE capacity_pools SET migration_state = 'pending', configuration_state = 'migration-pending' WHERE scope = 'user'"
      )
      .run();

    const selection = await resolveTaskStartCapacityPoolSelection(
      db as never,
      defaultTaskPlacement('partial-initialization'),
      { ensure: false }
    );

    expect(selection?.effectiveState).toBe('migration-pending');
    expect(selection?.candidates).toHaveLength(0);
  });

  it('marks pool sources disabled without widening when a backing credential is disabled', async () => {
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

    expect(effective?.pool.scope).toBe('user');
    expect(effective?.effectiveState).toBe('source-disabled');
    expect(
      getRows<{
        source_status: string;
        candidate_status: string;
        pool_status: string;
        configuration_state: string;
      }>(`
        SELECT src.status AS source_status, cand.status AS candidate_status,
               pool.status AS pool_status, pool.configuration_state
        FROM capacity_pools pool
        JOIN capacity_pool_candidates cand ON cand.pool_id = pool.id
        JOIN capacity_sources src ON src.id = cand.capacity_source_id
        WHERE pool.scope = 'user'
        LIMIT 1
      `)[0]
    ).toEqual({
      source_status: 'disabled',
      candidate_status: 'active',
      pool_status: 'active',
      configuration_state: 'source-disabled',
    });
  });

  it('marks an empty default pool without widening after backing credential deletion cascades sources', async () => {
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

    expect(effective?.pool.scope).toBe('project');
    expect(effective?.effectiveState).toBe('configured-empty');
    expect(getCount('capacity_sources', "credential_id = 'project-hetzner'")).toBe(0);
    expect(
      getRows<{ status: string; configuration_state: string }>(
        "SELECT status, configuration_state FROM capacity_pools WHERE scope = 'project' AND owner_project_id = 'project-1'"
      )[0]
    ).toEqual({ status: 'active', configuration_state: 'configured-empty' });
  });

  it('durably retries user, project and installation scopes after last credential deletion', async () => {
    const db = createDb();
    seedPlatformCredential({ id: 'platform-hetzner' });
    seedUserCredential({ id: 'user-hetzner' });
    seedUserCredential({ id: 'project-hetzner', projectId: 'project-1' });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      projectId: 'project-1',
      includeInstallation: true,
      offeringResolver: async (seed) => [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType:
            seed.scope === 'project'
              ? 'project-before-delete'
              : seed.scope === 'user'
                ? 'user-before-delete'
                : 'installation-before-delete',
          displayName: `${seed.scope} before delete`,
        }),
      ],
    });

    sqlite
      ?.prepare("DELETE FROM credentials WHERE id IN ('user-hetzner', 'project-hetzner')")
      .run();
    sqlite?.prepare("DELETE FROM platform_credentials WHERE id = 'platform-hetzner'").run();
    await requestDefaultCapacityPoolBackfillRetry(db as never, { users: true, projects: true });

    const restartedDb = poolDb();
    const backfill = await backfillDefaultCapacityPoolsForExistingCredentials(
      restartedDb as never,
      {
        includeInstallation: true,
        scopeBatchSize: 1,
        offeringResolver: async () => {
          throw new Error('no provider catalog should be read after last credential deletion');
        },
      }
    );

    expect(backfill).toMatchObject({
      usersEnsured: 1,
      projectsEnsured: 1,
    });
    expect(
      getRows<{ scope: string; owner_project_id: string | null; configuration_state: string }>(`
        SELECT scope, owner_project_id, configuration_state
        FROM capacity_pools
        WHERE is_default = 1
        ORDER BY scope, owner_project_id
      `)
    ).toEqual([
      { scope: 'installation', owner_project_id: null, configuration_state: 'configured-empty' },
      { scope: 'project', owner_project_id: 'project-1', configuration_state: 'configured-empty' },
      { scope: 'user', owner_project_id: null, configuration_state: 'configured-empty' },
    ]);
    expect(getCount('capacity_sources')).toBe(0);
    expect(getCount('capacity_pool_candidates')).toBe(0);
  });

  it('reports the selected validated settings sources and diagnoses invalid persisted values', async () => {
    const db = createDb();
    sqlite
      ?.prepare(
        `
        INSERT INTO platform_settings (key, value, updated_at)
        VALUES (?, ?, '2026-08-28T10:00:00.000Z')
      `
      )
      .run(
        'capacityPools.legacyWorkloadMapping.v1',
        JSON.stringify({
          small: {
            minVcpu: 1,
            minMemoryGb: 2,
            minDiskGb: 20,
            exclusiveNode: false,
            maxCoTenants: 4,
          },
        })
      );
    sqlite
      ?.prepare(
        `
        INSERT INTO platform_settings (key, value, updated_at)
        VALUES (?, ?, '2026-08-28T11:00:00.000Z')
      `
      )
      .run(
        'capacityPools.selectionSettings.v1',
        JSON.stringify({
          selectionWeights: { priority: 1, price: 1, fit: 1, capacity: 1, candidateOrder: 1 },
          rolloutCohortPercent: 101,
        })
      );
    sqlite
      ?.prepare(
        `
        INSERT INTO platform_settings (key, value, updated_at)
        VALUES (?, ?, '2026-08-28T12:00:00.000Z')
      `
      )
      .run(
        'capacityPools.platformDefaults.v1',
        JSON.stringify({
          minVcpu: 0,
          minMemoryGb: 4,
          minDiskGb: 40,
          exclusiveNode: false,
          maxCoTenants: 4,
        })
      );

    const result = await resolveCapacityPoolPlacementSettings(
      db as never,
      {
        CAPACITY_POOL_LEGACY_WORKLOAD_MAPPING_JSON: JSON.stringify({
          small: {
            minVcpu: 2,
            minMemoryGb: 3,
            minDiskGb: 4,
            exclusiveNode: false,
            maxCoTenants: 5,
          },
          medium: {
            minVcpu: 3,
            minMemoryGb: 4,
            minDiskGb: 5,
            exclusiveNode: false,
            maxCoTenants: 4,
          },
          large: {
            minVcpu: 4,
            minMemoryGb: 5,
            minDiskGb: 6,
            exclusiveNode: false,
            maxCoTenants: 3,
          },
        }),
        CAPACITY_POOL_SELECTION_SETTINGS_JSON: JSON.stringify({
          selectionWeights: { priority: 2, price: 3, fit: 5, capacity: 7, candidateOrder: 11 },
          rolloutCohortPercent: 42,
        }),
        CAPACITY_POOL_PLATFORM_DEFAULTS_JSON: JSON.stringify({
          minVcpu: 9,
          minMemoryGb: 10,
          minDiskGb: 0,
          exclusiveNode: false,
          maxCoTenants: 2,
        }),
      } as Env
    );

    expect(result.resourceDefaults.legacyWorkloadMapping.small.minVcpu).toBe(2);
    expect(result.resourceDefaults.platformDefaults).toEqual({
      minVcpu: 9,
      minMemoryGb: 10,
      minDiskGb: 0,
      exclusiveNode: false,
      maxCoTenants: 2,
    });
    expect(result.placementSettings.selectionWeights).toEqual({
      priority: 2,
      price: 3,
      fit: 5,
      capacity: 7,
      candidateOrder: 11,
    });
    expect(result.placementSettings.rolloutCohortPercent).toBe(42);
    expect(result.placementSettings.source).toEqual({
      legacyWorkloadMapping: 'environment',
      platformDefaults: 'environment',
      selection: 'environment',
    });
    expect(result.placementSettings.diagnostics).toEqual(
      expect.arrayContaining([
        'persisted:legacyWorkloadMapping.medium:invalid',
        'persisted:selectionSettings.rolloutCohortPercent:invalid',
        'persisted:platformDefaults:invalid',
      ])
    );

    sqlite
      ?.prepare(
        `
        UPDATE platform_settings
        SET value = ?
        WHERE key = 'capacityPools.platformDefaults.v1'
      `
      )
      .run(
        JSON.stringify({
          minVcpu: -10,
          minMemoryGb: 99,
          minDiskGb: 99,
          exclusiveNode: true,
          maxCoTenants: 99,
        })
      );

    const sameEffectiveSettings = await resolveCapacityPoolPlacementSettings(
      db as never,
      {
        CAPACITY_POOL_LEGACY_WORKLOAD_MAPPING_JSON: JSON.stringify({
          small: {
            minVcpu: 2,
            minMemoryGb: 3,
            minDiskGb: 4,
            exclusiveNode: false,
            maxCoTenants: 5,
          },
          medium: {
            minVcpu: 3,
            minMemoryGb: 4,
            minDiskGb: 5,
            exclusiveNode: false,
            maxCoTenants: 4,
          },
          large: {
            minVcpu: 4,
            minMemoryGb: 5,
            minDiskGb: 6,
            exclusiveNode: false,
            maxCoTenants: 3,
          },
        }),
        CAPACITY_POOL_SELECTION_SETTINGS_JSON: JSON.stringify({
          selectionWeights: { priority: 2, price: 3, fit: 5, capacity: 7, candidateOrder: 11 },
          rolloutCohortPercent: 42,
        }),
        CAPACITY_POOL_PLATFORM_DEFAULTS_JSON: JSON.stringify({
          minVcpu: 9,
          minMemoryGb: 10,
          minDiskGb: 0,
          exclusiveNode: false,
          maxCoTenants: 2,
        }),
      } as Env
    );
    expect(sameEffectiveSettings.placementSettings.sourceGeneration).toBe(
      result.placementSettings.sourceGeneration
    );
  });

  it('changes placement snapshot generations when effective settings or credential source changes', async () => {
    const db = createDb();
    seedUserCredential({
      id: 'user-hetzner',
      updatedAt: '2026-08-28T10:00:00.000Z',
    });
    sqlite
      ?.prepare(
        `
        INSERT INTO platform_settings (key, value, updated_at)
        VALUES ('capacityPools.selectionSettings.v1', ?, '2026-08-28T11:00:00.000Z')
      `
      )
      .run(
        JSON.stringify({
          selectionWeights: { priority: 1, price: 1, fit: 1, capacity: 1, candidateOrder: 1 },
          rolloutCohortPercent: 100,
        })
      );
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });

    const first = await resolveTaskStartCapacityPoolSelection(
      db as never,
      defaultTaskPlacement('settings-generation-first'),
      { ensure: false, env: { CAPACITY_POOL_SELECTION_SETTINGS_JSON: '' } as Env }
    );
    const firstSnapshot = capacityPlacementSnapshotForTaskStart(first);

    const firstSettingsGeneration = firstSnapshot?.selectionSettingsVersion;
    const firstSourceGeneration = firstSnapshot?.sourceGeneration;

    sqlite
      ?.prepare(
        "UPDATE platform_settings SET updated_at = '2026-08-28T12:00:00.000Z' WHERE key = 'capacityPools.selectionSettings.v1'"
      )
      .run();
    sqlite
      ?.prepare(
        "UPDATE credentials SET updated_at = '2026-08-28T13:00:00.000Z' WHERE id = 'user-hetzner'"
      )
      .run();
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });

    const second = await resolveTaskStartCapacityPoolSelection(
      db as never,
      defaultTaskPlacement('settings-generation-second'),
      { ensure: false, env: { CAPACITY_POOL_SELECTION_SETTINGS_JSON: '' } as Env }
    );
    const secondSnapshot = capacityPlacementSnapshotForTaskStart(second);

    expect(firstSettingsGeneration).toEqual(expect.any(Number));
    expect(secondSnapshot?.selectionSettingsVersion).toBe(firstSettingsGeneration);
    expect(secondSnapshot?.placementCredentialVersion).toBe(Date.parse('2026-08-28T13:00:00.000Z'));
    expect(secondSnapshot?.sourceGeneration).not.toBe(firstSourceGeneration);

    sqlite
      ?.prepare(
        `
        UPDATE platform_settings
        SET value = ?
        WHERE key = 'capacityPools.selectionSettings.v1'
      `
      )
      .run(
        JSON.stringify({
          selectionWeights: { priority: 2, price: 1, fit: 1, capacity: 1, candidateOrder: 1 },
          rolloutCohortPercent: 100,
        })
      );

    const third = await resolveTaskStartCapacityPoolSelection(
      db as never,
      defaultTaskPlacement('settings-generation-third'),
      { ensure: false, env: { CAPACITY_POOL_SELECTION_SETTINGS_JSON: '' } as Env }
    );
    const thirdSnapshot = capacityPlacementSnapshotForTaskStart(third);

    expect(thirdSnapshot?.selectionSettingsVersion).not.toBe(firstSettingsGeneration);
    expect(thirdSnapshot?.sourceGeneration).not.toBe(secondSnapshot?.sourceGeneration);
  });

  it('keeps placement authority stable across identical refresh epochs and invalidates on credential content rotation', async () => {
    const db = createDb();
    seedUserCredential({
      id: 'user-hetzner',
      encryptedToken: 'encrypted-token-v1',
      iv: 'iv-v1',
      updatedAt: '2026-08-28T10:00:00.000Z',
    });

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });
    const firstSource = getRows<{ source_generation: number; authority_generation: number }>(`
      SELECT source_generation, authority_generation
      FROM capacity_sources
      WHERE credential_id = 'user-hetzner'
    `)[0]!;
    const firstSelection = await resolveTaskStartCapacityPoolSelection(
      db as never,
      defaultTaskPlacement('authority-identical-first'),
      { ensure: false }
    );
    const firstCandidate = firstSelection?.candidates[0];
    expect(firstCandidate).toBeDefined();
    const firstCatalog = getRows<{ catalog_generation: number; authority_generation: number }>(`
      SELECT catalog_generation, authority_generation
      FROM capacity_pool_candidates
      WHERE id = '${firstCandidate!.id}'
    `)[0]!;
    const firstSnapshot = capacityPlacementSnapshotForTaskStart(firstSelection);

    expect(firstSource.authority_generation).toEqual(expect.any(Number));
    expect(firstCandidate?.sourceAuthorityGeneration).toBe(firstSource.authority_generation);
    expect(firstCandidate?.candidateAuthorityGeneration).toBe(firstCatalog.authority_generation);
    expect(firstCandidate?.capacityAuthorityGeneration).toBe(
      firstSnapshot?.capacityAuthorityGeneration
    );
    expect(firstSnapshot?.sourceGeneration).toBe(firstSnapshot?.capacityAuthorityGeneration);

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });
    const identicalSource = getRows<{ source_generation: number; authority_generation: number }>(`
      SELECT source_generation, authority_generation
      FROM capacity_sources
      WHERE credential_id = 'user-hetzner'
    `)[0]!;
    const identicalCatalog = getRows<{ catalog_generation: number; authority_generation: number }>(`
      SELECT catalog_generation, authority_generation
      FROM capacity_pool_candidates
      WHERE id = '${firstCandidate!.id}'
    `)[0]!;
    const identicalSelection = await resolveTaskStartCapacityPoolSelection(
      db as never,
      defaultTaskPlacement('authority-identical-second'),
      { ensure: false }
    );
    const identicalSnapshot = capacityPlacementSnapshotForTaskStart(identicalSelection);

    expect(identicalSource.source_generation).toBeGreaterThan(firstSource.source_generation);
    expect(identicalSource.authority_generation).toBe(firstSource.authority_generation);
    expect(identicalCatalog.catalog_generation).toBeGreaterThan(firstCatalog.catalog_generation);
    expect(identicalCatalog.authority_generation).toBe(firstCatalog.authority_generation);
    expect(identicalSnapshot?.selectionSettingsVersion).toBe(
      firstSnapshot?.selectionSettingsVersion
    );
    expect(identicalSnapshot?.capacityAuthorityGeneration).toBe(
      firstSnapshot?.capacityAuthorityGeneration
    );
    expect(identicalSnapshot?.sourceGeneration).toBe(firstSnapshot?.sourceGeneration);

    sqlite
      ?.prepare(
        `
        UPDATE credentials
        SET encrypted_token = 'encrypted-token-v2', iv = 'iv-v2'
        WHERE id = 'user-hetzner'
      `
      )
      .run();
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
    });
    const rotatedSource = getRows<{ source_generation: number; authority_generation: number }>(`
      SELECT source_generation, authority_generation
      FROM capacity_sources
      WHERE credential_id = 'user-hetzner'
    `)[0]!;
    const rotatedCatalog = getRows<{ catalog_generation: number; authority_generation: number }>(`
      SELECT catalog_generation, authority_generation
      FROM capacity_pool_candidates
      WHERE id = '${firstCandidate!.id}'
    `)[0]!;
    const rotatedSelection = await resolveTaskStartCapacityPoolSelection(
      db as never,
      defaultTaskPlacement('authority-identical-rotated'),
      { ensure: false }
    );
    const rotatedSnapshot = capacityPlacementSnapshotForTaskStart(rotatedSelection);

    expect(rotatedSource.source_generation).toBeGreaterThan(identicalSource.source_generation);
    expect(rotatedSource.authority_generation).not.toBe(firstSource.authority_generation);
    expect(rotatedCatalog.authority_generation).not.toBe(firstCatalog.authority_generation);
    expect(rotatedSnapshot?.placementCredentialVersion).toBe(
      Date.parse('2026-08-28T10:00:00.000Z')
    );
    expect(rotatedSnapshot?.capacityAuthorityGeneration).not.toBe(
      firstSnapshot?.capacityAuthorityGeneration
    );
    expect(rotatedSnapshot?.sourceGeneration).toBe(rotatedSnapshot?.capacityAuthorityGeneration);
  });
});

/**
 * Regression coverage for the six findings raised against 4a21532a5, plus the deployment
 * workload-role regression. Each block names the defect it reproduces so a future reader can
 * tell what would break if the guard were removed.
 */
describe('capacity pool review findings', () => {
  const DEPLOYMENT_ROLE_SUFFIX = '#role=deployment';

  function poolRevision(): number {
    return (
      sqlite?.prepare("SELECT revision FROM capacity_pools WHERE scope = 'user'").get() as {
        revision: number;
      }
    ).revision;
  }

  function candidateRow(id: string) {
    return sqlite?.prepare('SELECT * FROM capacity_pool_candidates WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
  }

  function workspaceCandidateIds(): string[] {
    return getRows<{ id: string }>(`
      SELECT id FROM capacity_pool_candidates
      WHERE workload_role = 'workspace'
      ORDER BY id
    `).map((row) => row.id);
  }

  async function ensureUserPool(
    db: unknown,
    offerings: ProviderInstanceOffering[],
    overrides: Record<string, unknown> = {}
  ) {
    return ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      candidatePublishBatchSize: 1000,
      offeringResolver: async () => offerings,
      ...overrides,
    });
  }

  const twoComparableOfferings = (cheapest: 'a' | 'b') => [
    liveHetznerOffering({
      location: 'fsn1',
      providerInstanceType: 'cmp-a',
      displayName: 'Comparable A',
      priceMonthly: cheapest === 'a' ? 4 : 9,
      priceHourly: cheapest === 'a' ? 0.004 : 0.009,
    }),
    liveHetznerOffering({
      location: 'fsn1',
      providerInstanceType: 'cmp-b',
      displayName: 'Comparable B',
      priceMonthly: cheapest === 'b' ? 4 : 9,
      priceHourly: cheapest === 'b' ? 0.004 : 0.009,
    }),
  ];

  // ---------------------------------------------------------------------------------------
  // Finding 1 (P1): membership + policy + revision were three separate writes.
  // ---------------------------------------------------------------------------------------
  describe('finding 1: atomic pool edit', () => {
    async function seedTwoEditableCandidates() {
      createDb();
      seedUserCredential({ id: 'user-hetzner' });
      const db = poolDb();
      await ensureUserPool(db, [
        liveHetznerOffering({ location: 'fsn1', providerInstanceType: 'cx23', displayName: 'CX23' }),
        liveHetznerOffering({ location: 'fsn1', providerInstanceType: 'cx33', displayName: 'CX33' }),
      ]);
      return db;
    }

    it('rolls the whole edit back when a candidate write fails mid-batch', async () => {
      await seedTwoEditableCandidates();
      const ids = workspaceCandidateIds();
      expect(ids.length).toBeGreaterThanOrEqual(2);
      const before = {
        revision: poolRevision(),
        strategy: (
          sqlite?.prepare("SELECT strategy FROM capacity_pools WHERE scope = 'user'").get() as {
            strategy: string;
          }
        ).strategy,
        statuses: ids.map((id) => candidateRow(id)?.status),
      };

      // Fail the SECOND statement inside the batch, after the first has already run.
      let statementIndex = 0;
      const failingDb = drizzleD1(
        {
          ...createSqliteD1WithBindLimit(sqlite!, 100),
          batch: async (statements: { runSync(): unknown }[]) =>
            sqlite!.transaction((items: { runSync(): unknown }[]) =>
              items.map((item) => {
                statementIndex += 1;
                if (statementIndex === 2) throw new Error('simulated mid-batch D1 failure');
                return item.runSync();
              })
            )(statements),
        } as unknown as D1Database,
        { schema }
      );

      await expect(
        updateDefaultCapacityPool(failingDb as never, {
          scope: 'user',
          ownerUserId: 'user-1',
          ownerProjectId: null,
          policy: { strategy: 'smallest-fit' },
          candidates: [
            { id: ids[0], status: 'deleted' },
            { id: ids[1], status: 'deleted' },
          ],
        })
      ).rejects.toThrow('simulated mid-batch D1 failure');

      // Nothing partially published: a reader sees the COMPLETE old policy + membership.
      expect(poolRevision()).toBe(before.revision);
      expect(
        (
          sqlite?.prepare("SELECT strategy FROM capacity_pools WHERE scope = 'user'").get() as {
            strategy: string;
          }
        ).strategy
      ).toBe(before.strategy);
      expect(ids.map((id) => candidateRow(id)?.status)).toEqual(before.statuses);
    });

    it('publishes membership, policy and revision together on success', async () => {
      const db = await seedTwoEditableCandidates();
      const ids = workspaceCandidateIds();
      const revisionBefore = poolRevision();

      const result = await updateDefaultCapacityPool(db as never, {
        scope: 'user',
        ownerUserId: 'user-1',
        ownerProjectId: null,
        policy: { strategy: 'smallest-fit', exhaustionPolicy: 'fail' },
        candidates: [{ id: ids[0], status: 'disabled' }],
      });

      expect(result.conflict).toBe(false);
      expect(result.summary?.pool).toMatchObject({
        strategy: 'smallest-fit',
        exhaustionPolicy: 'fail',
        revision: revisionBefore + 1,
      });
      expect(candidateRow(ids[0])?.status).toBe('disabled');
    });

    it('rejects a stale concurrent edit instead of overwriting the winner', async () => {
      await seedTwoEditableCandidates();
      const ids = workspaceCandidateIds();
      const revisionBefore = poolRevision();

      // Model the race deterministically: another editor commits between our read and our
      // fenced write.
      let raced = false;
      const racingDb = drizzleD1(
        {
          ...createSqliteD1WithBindLimit(sqlite!, 100),
          batch: async (statements: { runSync(): unknown }[]) => {
            if (!raced) {
              raced = true;
              sqlite!
                .prepare(
                  "UPDATE capacity_pools SET revision = revision + 1, strategy = 'pack' WHERE scope = 'user'"
                )
                .run();
            }
            return sqlite!.transaction((items: { runSync(): unknown }[]) =>
              items.map((item) => item.runSync())
            )(statements);
          },
        } as unknown as D1Database,
        { schema }
      );

      const result = await updateDefaultCapacityPool(racingDb as never, {
        scope: 'user',
        ownerUserId: 'user-1',
        ownerProjectId: null,
        policy: { strategy: 'smallest-fit' },
        candidates: [{ id: ids[0], status: 'deleted' }],
      });

      expect(result.conflict).toBe(true);
      expect(result.summary).toBeNull();
      // The concurrent editor's intent survives untouched.
      expect(
        (
          sqlite?.prepare("SELECT strategy, revision FROM capacity_pools WHERE scope = 'user'").get() as {
            strategy: string;
            revision: number;
          }
        )
      ).toEqual({ strategy: 'pack', revision: revisionBefore + 1 });
      expect(candidateRow(ids[0])?.status).not.toBe('deleted');
    });
  });

  // ---------------------------------------------------------------------------------------
  // Finding 2 (P2): a successful, complete, EMPTY API inventory was read as static/incomplete.
  // ---------------------------------------------------------------------------------------
  describe('finding 2: empty successful catalog completeness', () => {
    it('marks every prior offering unavailable while preserving explicit membership', async () => {
      createDb();
      seedUserCredential({ id: 'user-hetzner' });
      const db = poolDb();
      const offerings = [
        liveHetznerOffering({ location: 'fsn1', providerInstanceType: 'cx23', displayName: 'CX23' }),
        liveHetznerOffering({ location: 'fsn1', providerInstanceType: 'cpx62', displayName: 'CPX62' }),
      ];
      await ensureUserPool(db, offerings);
      const selectedId = workspaceCandidateIds().find((id) => id.includes('cx23'));
      expect(selectedId).toBeDefined();
      const statusBefore = candidateRow(selectedId!)?.status;

      await ensureUserPool(db, [], {
        offeringResolver: async () => ({
          offerings: [],
          refreshSucceeded: true,
          catalogComplete: true,
        }),
      });

      expect(
        getRows<{ catalog_availability: string; count: number }>(`
          SELECT catalog_availability, COUNT(*) AS count
          FROM capacity_pool_candidates
          GROUP BY catalog_availability
        `)
      ).toEqual([{ catalog_availability: 'last-known-unavailable', count: 4 }]);
      // Membership status is user intent and survives an authoritative empty inventory.
      expect(candidateRow(selectedId!)?.status).toBe(statusBefore);
    });

    it('retains last-known-good when the refresh failed or was incomplete', async () => {
      createDb();
      seedUserCredential({ id: 'user-hetzner' });
      const db = poolDb();
      await ensureUserPool(db, [
        liveHetznerOffering({ location: 'fsn1', providerInstanceType: 'cx23', displayName: 'CX23' }),
      ]);

      await ensureUserPool(db, [], {
        offeringResolver: async () => ({ offerings: [], refreshSucceeded: false }),
      });
      expect(getCount('capacity_pool_candidates', "catalog_availability = 'available'")).toBe(2);

      await ensureUserPool(db, [], {
        offeringResolver: async () => ({
          offerings: [],
          refreshSucceeded: true,
          catalogComplete: false,
        }),
      });
      expect(getCount('capacity_pool_candidates', "catalog_availability = 'available'")).toBe(2);
    });

    it('restores a previously selected offering that reappears and keeps removals removed', async () => {
      createDb();
      seedUserCredential({ id: 'user-hetzner' });
      const db = poolDb();
      const both = [
        liveHetznerOffering({ location: 'fsn1', providerInstanceType: 'cx23', displayName: 'CX23' }),
        liveHetznerOffering({ location: 'fsn1', providerInstanceType: 'cx33', displayName: 'CX33' }),
      ];
      await ensureUserPool(db, both);
      const removedId = workspaceCandidateIds().find((id) => id.includes('cx33'))!;
      sqlite
        ?.prepare("UPDATE capacity_pool_candidates SET status = 'deleted' WHERE id = ?")
        .run(removedId);

      await ensureUserPool(db, [], {
        offeringResolver: async () => ({
          offerings: [],
          refreshSucceeded: true,
          catalogComplete: true,
        }),
      });
      await ensureUserPool(db, both);

      const keptId = workspaceCandidateIds().find((id) => id.includes('cx23'))!;
      expect(candidateRow(keptId)?.catalog_availability).toBe('available');
      expect(candidateRow(keptId)?.status).toBe('active');
      // A deliberate removal is never resurrected by the offering returning.
      expect(candidateRow(removedId)?.status).toBe('deleted');
    });
  });

  // ---------------------------------------------------------------------------------------
  // Finding 3 (P2): a price-only change reordered ranking without invalidating plan authority.
  // ---------------------------------------------------------------------------------------
  describe('finding 3: selection-affecting changes bump pool revision', () => {
    it('keeps the revision stable across an identical refresh', async () => {
      createDb();
      seedUserCredential({ id: 'user-hetzner' });
      const db = poolDb();
      await ensureUserPool(db, twoComparableOfferings('a'));
      await ensureUserPool(db, twoComparableOfferings('a'));
      const stable = poolRevision();
      await ensureUserPool(db, twoComparableOfferings('a'));
      expect(poolRevision()).toBe(stable);
    });

    it('bumps the revision when two comparable offerings swap the cheapest position', async () => {
      createDb();
      seedUserCredential({ id: 'user-hetzner' });
      const db = poolDb();
      await ensureUserPool(db, twoComparableOfferings('a'));
      await ensureUserPool(db, twoComparableOfferings('a'));
      const before = poolRevision();

      await ensureUserPool(db, twoComparableOfferings('b'));

      expect(poolRevision()).toBe(before + 1);
    });
  });

  // ---------------------------------------------------------------------------------------
  // Finding 4 (P2): refresh published NULL over persisted native configuration.
  // ---------------------------------------------------------------------------------------
  describe('finding 4: persisted native configuration survives refresh', () => {
    it('preserves boot disk, image and architecture across an unchanged inventory refresh', async () => {
      createDb();
      seedUserCredential({ id: 'user-hetzner' });
      const db = poolDb();
      const offerings = [
        liveHetznerOffering({ location: 'fsn1', providerInstanceType: 'cx23', displayName: 'CX23' }),
      ];
      await ensureUserPool(db, offerings);
      const id = workspaceCandidateIds()[0];
      sqlite
        ?.prepare(
          `UPDATE capacity_pool_candidates
             SET provider_instance_boot_disk_size_gb = 120,
                 provider_instance_image = 'ubuntu-24.04',
                 provider_instance_architecture = 'arm64'
           WHERE id = ?`
        )
        .run(id);
      // Re-run once so the authority generation already reflects the configured fields.
      await ensureUserPool(db, offerings);
      const configured = candidateRow(id)!;

      await ensureUserPool(db, offerings);
      const after = candidateRow(id)!;

      expect(after.provider_instance_boot_disk_size_gb).toBe(120);
      expect(after.provider_instance_image).toBe('ubuntu-24.04');
      expect(after.provider_instance_architecture).toBe('arm64');
      // Identical refresh must not churn placement authority either.
      expect(after.authority_generation).toBe(configured.authority_generation);
    });
  });

  // ---------------------------------------------------------------------------------------
  // Finding 5: the source bridge copied encrypted credential material into legacy rows.
  // ---------------------------------------------------------------------------------------
  describe('finding 5: no credential copies', () => {
    it('binds a composable source by exact reference and stores no secret in the anchor', async () => {
      createDb();
      seedComposableCloudCredential({
        credentialId: 'cc-cred-1',
        configurationId: 'cc-cfg-1',
        attachmentId: 'cc-att-1',
        encryptedToken: 'REAL-CIPHERTEXT-CANARY',
        iv: 'REAL-IV-CANARY',
      });
      const db = poolDb();
      await ensureUserPool(db, [
        liveHetznerOffering({ location: 'fsn1', providerInstanceType: 'cx23', displayName: 'CX23' }),
      ]);

      const source = getRows<{
        credential_source: string;
        credential_reference: string;
        external_source_ref: string;
        credential_id: string;
      }>(`SELECT credential_source, credential_reference, external_source_ref, credential_id
          FROM capacity_sources WHERE scope = 'user'`)[0];
      expect(source.credential_source).toBe('user');
      expect(source.credential_reference).toBe('cc_credentials:cc-cred-1');
      expect(source.external_source_ref).toBe('cc_attachments:cc-att-1');

      const anchors = getRows<{ id: string; encrypted_token: string; iv: string }>(
        `SELECT id, encrypted_token, iv FROM credentials
         WHERE credential_type = 'capacity-source-external-ref'`
      );
      expect(anchors).toHaveLength(1);
      expect(anchors[0].encrypted_token).toBe('');
      expect(anchors[0].iv).toBe('');
      // The canary never appears anywhere in the legacy credentials table.
      expect(
        getCount('credentials', "encrypted_token = 'REAL-CIPHERTEXT-CANARY'")
      ).toBe(0);
    });

    it('scrubs a pre-existing copied secret without cascading the capacity source away', async () => {
      createDb();
      seedComposableCloudCredential({
        credentialId: 'cc-cred-1',
        configurationId: 'cc-cfg-1',
        attachmentId: 'cc-att-1',
        encryptedToken: 'REAL-CIPHERTEXT-CANARY',
        iv: 'REAL-IV-CANARY',
      });
      const db = poolDb();
      await ensureUserPool(db, [
        liveHetznerOffering({ location: 'fsn1', providerInstanceType: 'cx23', displayName: 'CX23' }),
      ]);
      const anchorId = getRows<{ id: string }>(
        "SELECT id FROM credentials WHERE credential_type = 'capacity-source-external-ref'"
      )[0].id;
      // Re-introduce the old bridge's copied ciphertext, as an upgraded installation has it.
      sqlite
        ?.prepare('UPDATE credentials SET encrypted_token = ?, iv = ? WHERE id = ?')
        .run('REAL-CIPHERTEXT-CANARY', 'REAL-IV-CANARY', anchorId);
      const sourcesBefore = getCount('capacity_sources');

      await backfillDefaultCapacityPoolsForExistingCredentials(db as never, {
        includeInstallation: false,
        offeringResolver: async () => [],
      });

      expect(getCount('credentials', `id = '${anchorId}' AND encrypted_token = ''`)).toBe(1);
      expect(getCount('credentials', "encrypted_token = 'REAL-CIPHERTEXT-CANARY'")).toBe(0);
      // The FK is ON DELETE CASCADE: a referenced anchor must never be deleted.
      expect(getCount('credentials', `id = '${anchorId}'`)).toBe(1);
      expect(getCount('capacity_sources')).toBe(sourcesBefore);
    });

    it('scrubs referenced anchors and prunes only unreferenced ones', async () => {
      createDb();
      seedComposableCloudCredential({
        credentialId: 'cc-cred-1',
        configurationId: 'cc-cfg-1',
        attachmentId: 'cc-att-1',
      });
      const db = poolDb();
      await ensureUserPool(db, [
        liveHetznerOffering({ location: 'fsn1', providerInstanceType: 'cx23', displayName: 'CX23' }),
      ]);
      const anchorId = getRows<{ id: string }>(
        "SELECT id FROM credentials WHERE credential_type = 'capacity-source-external-ref'"
      )[0].id;
      sqlite
        ?.prepare('UPDATE credentials SET encrypted_token = ?, iv = ? WHERE id = ?')
        .run('LEAKED-CIPHERTEXT', 'LEAKED-IV', anchorId);
      // An orphan left behind by a credential rotation: no capacity source references it.
      sqlite
        ?.prepare(
          `INSERT INTO credentials (id, user_id, project_id, provider, credential_type,
             credential_kind, is_active, encrypted_token, iv, created_at, updated_at)
           VALUES ('anchor-orphan', 'user-1', NULL, 'hetzner', 'capacity-source-external-ref',
             'api-key', 1, 'ORPHAN-CIPHERTEXT', 'ORPHAN-IV', '2026-01-01T00:00:00.000Z',
             '2026-01-01T00:00:00.000Z')`
        )
        .run();
      const sourcesBefore = getCount('capacity_sources');

      const result = await scrubCapacitySourceCredentialSecrets(db as never);

      expect(result.scrubbedAnchors).toBe(2);
      expect(result.deletedUnreferencedAnchors).toBe(1);
      expect(getCount('credentials', "encrypted_token LIKE '%CIPHERTEXT%'")).toBe(0);
      expect(getCount('credentials', `id = '${anchorId}' AND encrypted_token = ''`)).toBe(1);
      expect(getCount('credentials', "id = 'anchor-orphan'")).toBe(0);
      // Discriminating control: pruning the orphan must not cascade a real source away.
      expect(getCount('capacity_sources')).toBe(sourcesBefore);
    });
  });

  // ---------------------------------------------------------------------------------------
  // Finding 6: publication was unbounded per source and could not resume.
  // ---------------------------------------------------------------------------------------
  describe('finding 6: bounded, resumable candidate publication', () => {
    const LARGE = 40; // 40 offerings x 2 roles = 80 rows

    it('publishes in bounded passes, resumes across a restart, and only then marks missing', async () => {
      createDb();
      seedUserCredential({ id: 'user-hetzner' });
      const offerings = manyLiveOfferings(LARGE);
      // Pre-existing row that disappears from the catalog; it must keep last-known-good
      // availability until the ENTIRE catalog has been published.
      await ensureDefaultCapacityPoolsForExistingCredentials(poolDb() as never, {
        userId: 'user-1',
        includeInstallation: false,
        candidatePublishBatchSize: 1000,
        offeringResolver: async () => [
          liveHetznerOffering({
            location: 'fsn1',
            providerInstanceType: 'going-away',
            displayName: 'Going away',
          }),
        ],
      });
      expect(getCount('capacity_pool_candidates', "catalog_availability = 'available'")).toBe(2);

      let passes = 0;
      let published = 0;
      while (published < LARGE * 2 && passes < 20) {
        // A NEW db handle each pass: resumption must come from the durable cursor, not memory.
        await ensureDefaultCapacityPoolsForExistingCredentials(poolDb() as never, {
          userId: 'user-1',
          includeInstallation: false,
          candidatePublishBatchSize: 25,
          offeringResolver: async () => offerings,
        });
        passes += 1;
        published = getCount(
          'capacity_pool_candidates',
          "provider_instance_type LIKE 'provider-native-%'"
        );
        if (published < LARGE * 2) {
          // Incomplete publication must NOT mark the disappeared offering unavailable.
          expect(
            getCount(
              'capacity_pool_candidates',
              "provider_instance_type = 'going-away' AND catalog_availability = 'last-known-unavailable'"
            )
          ).toBe(0);
        }
      }

      expect(passes).toBeGreaterThan(1);
      expect(published).toBe(LARGE * 2);
      // Only once the whole catalog is published does missing-offering cleanup run.
      expect(
        getCount(
          'capacity_pool_candidates',
          "provider_instance_type = 'going-away' AND catalog_availability = 'last-known-unavailable'"
        )
      ).toBe(2);
    });

    it('never marks missing when the refresh itself failed mid-publication', async () => {
      createDb();
      seedUserCredential({ id: 'user-hetzner' });
      await ensureDefaultCapacityPoolsForExistingCredentials(poolDb() as never, {
        userId: 'user-1',
        includeInstallation: false,
        candidatePublishBatchSize: 1000,
        offeringResolver: async () => [
          liveHetznerOffering({
            location: 'fsn1',
            providerInstanceType: 'keep-me',
            displayName: 'Keep me',
          }),
        ],
      });

      await ensureDefaultCapacityPoolsForExistingCredentials(poolDb() as never, {
        userId: 'user-1',
        includeInstallation: false,
        candidatePublishBatchSize: 5,
        offeringResolver: async () => ({ offerings: [], refreshSucceeded: false }),
      });

      expect(getCount('capacity_pool_candidates', "catalog_availability = 'available'")).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------------------
  // Deployment workload-role regression (7bab): reconciliation only produced 'workspace' rows.
  // ---------------------------------------------------------------------------------------
  describe('deployment workload-role materialization', () => {
    async function seedRolePool() {
      createDb();
      seedUserCredential({ id: 'user-hetzner' });
      const db = poolDb();
      await ensureUserPool(db, [
        liveHetznerOffering({
          location: 'fsn1',
          providerInstanceType: 'cx23',
          displayName: 'CX23',
          vcpu: 4,
          memoryMb: 8192,
          memoryGb: 8,
          ramGb: 8,
          diskGb: 80,
          storageGb: 80,
        }),
      ]);
      return db;
    }

    it('materializes a coupled deployment candidate for every editor-visible offering', async () => {
      await seedRolePool();
      const workspaceIds = workspaceCandidateIds();
      expect(workspaceIds).toHaveLength(1);
      const deploymentRow = candidateRow(`${workspaceIds[0]}${DEPLOYMENT_ROLE_SUFFIX}`);
      expect(deploymentRow).toBeDefined();
      expect(deploymentRow?.workload_role).toBe('deployment');
      expect(deploymentRow?.status).toBe(candidateRow(workspaceIds[0])?.status);
      // The mirror carries the SAME provider-native identity as the visible row: same
      // location, legacy size hint, instance type and status.
      expect(getDeploymentCandidateStatusRows(['cx23'])).toEqual(getCandidateStatusRows(['cx23']));
    });

    it('hides the placement-only deployment row from the pool editor surface', async () => {
      const db = await seedRolePool();
      const summaries = await readDefaultCapacityPoolSummaries(db as never, {
        userId: 'user-1',
        includeInstallation: false,
        includeDisabled: true,
      });
      const candidates = summaries.user?.candidates ?? [];
      expect(candidates).toHaveLength(1);
      expect(candidates.every((candidate) => candidate.workloadRole === 'workspace')).toBe(true);
    });

    it('propagates an editor status change to the coupled deployment row', async () => {
      const db = await seedRolePool();
      const workspaceId = workspaceCandidateIds()[0];

      const result = await updateDefaultCapacityPool(db as never, {
        scope: 'user',
        ownerUserId: 'user-1',
        ownerProjectId: null,
        candidates: [{ id: workspaceId, status: 'deleted' }],
      });

      expect(result.conflict).toBe(false);
      expect(candidateRow(workspaceId)?.status).toBe('deleted');
      expect(candidateRow(`${workspaceId}${DEPLOYMENT_ROLE_SUFFIX}`)?.status).toBe('deleted');
    });

    it('never couples a legacy row that has no provider-native identity', async () => {
      const db = await seedRolePool();
      const workspaceId = workspaceCandidateIds()[0];
      const legacyId = `${workspaceId}-legacy`;
      // A pre-native legacy row: NULL provider_instance_type. It is addressable by exact id
      // only, and must never be matched to another row's offering identity.
      sqlite
        ?.prepare(
          `INSERT INTO capacity_pool_candidates (
             id, pool_id, capacity_source_id, provider, location, workload_role, runtime,
             machine_class, machine_size, provider_instance_type, catalog_availability,
             catalog_generation, authority_generation, priority, candidate_order, status,
             created_at, updated_at
           )
           SELECT ?, pool_id, capacity_source_id, provider, location, 'workspace', runtime,
                  machine_class, machine_size, NULL, catalog_availability,
                  catalog_generation, authority_generation, priority, candidate_order, 'active',
                  created_at, updated_at
           FROM capacity_pool_candidates WHERE id = ?`
        )
        .run(legacyId, workspaceId);
      sqlite
        ?.prepare(
          `INSERT INTO capacity_pool_candidates (
             id, pool_id, capacity_source_id, provider, location, workload_role, runtime,
             machine_class, machine_size, provider_instance_type, catalog_availability,
             catalog_generation, authority_generation, priority, candidate_order, status,
             created_at, updated_at
           )
           SELECT ?, pool_id, capacity_source_id, provider, location, 'deployment', runtime,
                  machine_class, machine_size, NULL, catalog_availability,
                  catalog_generation, authority_generation, priority, candidate_order, 'active',
                  created_at, updated_at
           FROM capacity_pool_candidates WHERE id = ?`
        )
        .run(`${legacyId}${DEPLOYMENT_ROLE_SUFFIX}`, workspaceId);

      const result = await updateDefaultCapacityPool(db as never, {
        scope: 'user',
        ownerUserId: 'user-1',
        ownerProjectId: null,
        candidates: [{ id: legacyId, status: 'disabled' }],
      });

      expect(result.conflict).toBe(false);
      expect(candidateRow(legacyId)?.status).toBe('disabled');
      // Null-typed rows are never fuzzy-coupled: the sibling keeps its own status.
      expect(candidateRow(`${legacyId}${DEPLOYMENT_ROLE_SUFFIX}`)?.status).toBe('active');
    });
  });
});

/**
 * The shared workload-role eligibility contract A4 publishes and C3a's final admission fence
 * consumes. These prove the SOURCE half end-to-end: default ensure produces a canonical
 * deployment candidate that a deployment-role selection accepts, and a wrong-role request is
 * rejected rather than silently matched.
 */
describe('workload-role eligibility contract', () => {
  async function seedRoleCapablePool() {
    createDb();
    seedUserCredential({ id: 'user-hetzner' });
    const db = poolDb();
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      candidatePublishBatchSize: 1000,
      offeringResolver: async () => [
        liveHetznerOffering({
          location: getDefaultLocationForProvider('hetzner'),
          providerInstanceType: 'cx23',
          displayName: 'CX23',
          machineSize: 'small',
        }),
      ],
    });
    return db;
  }

  function hetznerTaskStartPlacement() {
    return resolveTaskStartPlacement({
      entryPoint: 'task-submit',
      taskId: 'role-task',
      projectId: 'project-1',
      userId: 'user-1',
      project: {
        id: 'project-1',
        defaultProvider: 'hetzner',
        defaultLocation: getDefaultLocationForProvider('hetzner'),
        defaultVmSize: 'small',
      },
      credentialProjectPolicy: 'current-project-unless-inherited',
      taskModeDefault: 'task',
      resourceRequirements: {},
    });
  }

  it('selects the coupled deployment candidate for a deployment-role placement', async () => {
    const db = await seedRoleCapablePool();
    const summary = await resolveEffectiveDefaultCapacityPoolSummary(db as never, {
      userId: 'user-1',
      projectId: null,
      ensure: false,
      includeInstallation: false,
      workloadRoles: 'all',
    });
    expect(summary).not.toBeNull();

    const deployment = buildCapacityPoolSelection(summary!, hetznerTaskStartPlacement(), 'deployment');

    expect(deployment?.candidates.length).toBeGreaterThan(0);
    expect(deployment?.candidates.every((candidate) => candidate.workloadRole === 'deployment')).toBe(
      true
    );
    expect(deployment?.candidates[0]?.providerInstanceType).toBe('cx23');
  });

  it('still selects the workspace candidate for a workspace-role placement', async () => {
    const db = await seedRoleCapablePool();
    const summary = await resolveEffectiveDefaultCapacityPoolSummary(db as never, {
      userId: 'user-1',
      projectId: null,
      ensure: false,
      includeInstallation: false,
      workloadRoles: 'all',
    });

    const workspace = buildCapacityPoolSelection(summary!, hetznerTaskStartPlacement(), 'workspace');

    expect(workspace?.candidates.length).toBeGreaterThan(0);
    expect(workspace?.candidates.every((candidate) => candidate.workloadRole === 'workspace')).toBe(
      true
    );
  });

  it('rejects candidates whose role does not match the requested role', async () => {
    const db = await seedRoleCapablePool();
    // Remove the coupled deployment rows: a deployment placement must then find NOTHING
    // rather than falling back to a workspace-role candidate.
    sqlite?.prepare("DELETE FROM capacity_pool_candidates WHERE workload_role = 'deployment'").run();
    const summary = await resolveEffectiveDefaultCapacityPoolSummary(db as never, {
      userId: 'user-1',
      projectId: null,
      ensure: false,
      includeInstallation: false,
      workloadRoles: 'all',
    });

    const deployment = buildCapacityPoolSelection(summary!, hetznerTaskStartPlacement(), 'deployment');

    expect(deployment?.candidates).toEqual([]);
    // Discriminating control: the workspace role still resolves, so "empty" is not just a
    // broken fixture.
    expect(
      buildCapacityPoolSelection(summary!, hetznerTaskStartPlacement(), 'workspace')?.candidates
        .length
    ).toBeGreaterThan(0);
  });

  it('keeps editor-visible summaries and their counts free of role expansion', async () => {
    const db = await seedRoleCapablePool();

    const editorSummary = await resolveEffectiveDefaultCapacityPoolSummary(db as never, {
      userId: 'user-1',
      projectId: null,
      ensure: false,
      includeInstallation: false,
    });
    const placementSummary = await resolveEffectiveDefaultCapacityPoolSummary(db as never, {
      userId: 'user-1',
      projectId: null,
      ensure: false,
      includeInstallation: false,
      workloadRoles: 'all',
    });

    expect(editorSummary?.candidates).toHaveLength(1);
    expect(placementSummary?.candidates).toHaveLength(2);
    // Counts describe offerings, not role-expanded rows, in BOTH shapes.
    expect(placementSummary?.activeCandidateCount).toBe(editorSummary?.activeCandidateCount);
    expect(placementSummary?.availableCandidateCount).toBe(editorSummary?.availableCandidateCount);
  });

  it('exposes one shared role predicate for the reconciler and the admission fence', () => {
    expect(capacityCandidateSatisfiesWorkloadRole('deployment', 'deployment')).toBe(true);
    expect(capacityCandidateSatisfiesWorkloadRole('workspace', 'deployment')).toBe(false);
    expect(capacityCandidateSatisfiesWorkloadRole(null, 'workspace')).toBe(false);
    expect(capacityCandidateIdForRole('cand-1', 'workspace')).toBe('cand-1');
    expect(capacityCandidateIdForRole('cand-1', 'deployment')).toBe('cand-1#role=deployment');
    expect(capacityCandidateBaseId('cand-1#role=deployment')).toBe('cand-1');
    expect(capacityCandidateRoleFromId('cand-1#role=deployment')).toBe('deployment');
    expect(capacityCandidateRoleFromId('cand-1')).toBe('workspace');
    // A malformed suffix must not silently resolve to the primary role.
    expect(capacityCandidateRoleFromId('cand-1#role=bogus')).toBeNull();
  });
});

/**
 * The full production path for finding 2: a real Hetzner credential, a real provider client,
 * a real HTTP transport, and a genuinely EMPTY `server_types` response — through
 * reconciliation to the resulting candidate state. This is the test that reaches the feature
 * the way production does; the boundary unit tests in provider-catalog-completeness.test.ts
 * pin the classification itself.
 */
describe('empty live Hetzner inventory through the credential-backed catalog path', () => {
  function hetznerResponse(serverTypes: unknown[]) {
    return new Response(
      JSON.stringify({ server_types: serverTypes, meta: { pagination: { next_page: null } } }),
      { status: 200 }
    );
  }

  it('marks prior offerings unavailable when the live catalog returns zero server types', async () => {
    const db = createDb();
    const encrypted = await encrypt('live-hetzner-token', TEST_ENCRYPTION_KEY);
    seedUserCredential({
      id: 'user-hetzner',
      encryptedToken: encrypted.ciphertext,
      iv: encrypted.iv,
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      hetznerResponse([
        hetznerServerType({
          id: 1,
          name: 'cx23',
          description: 'CX23',
          cores: 2,
          memory: 4,
          disk: 40,
          hourlyGross: '0.0048',
          monthlyGross: '3.99',
        }),
      ])
    ) as typeof fetch;
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      env: catalogEnv(),
    });
    expect(getCount('capacity_pool_candidates', "catalog_availability = 'available'")).toBe(2);
    const selectedStatus = getCandidateStatusRows(['cx23'])[0]?.status;
    // The catalog cache is credential-scoped; the credential is unchanged here, so the second
    // refresh must be able to see the new (empty) inventory.
    clearCapacityCatalogCache();

    globalThis.fetch = vi.fn().mockResolvedValue(hetznerResponse([])) as typeof fetch;
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: false,
      env: catalogEnv(),
    });

    // Pre-fix an empty successful API response was classified static/incomplete, so this
    // stayed 'available' forever.
    expect(getCount('capacity_pool_candidates', "catalog_availability = 'available'")).toBe(0);
    expect(
      getCount('capacity_pool_candidates', "catalog_availability = 'last-known-unavailable'")
    ).toBe(2);
    // Membership is user intent and is preserved through an authoritative empty inventory.
    expect(getCandidateStatusRows(['cx23'])[0]?.status).toBe(selectedStatus);
  });

  it('issues one live catalog request per credential across pool scopes', async () => {
    const db = createDb();
    const encrypted = await encrypt('live-hetzner-token', TEST_ENCRYPTION_KEY);
    seedPlatformCredential({
      id: 'platform-hetzner',
      encryptedToken: encrypted.ciphertext,
      iv: encrypted.iv,
    });
    seedUserCredential({
      id: 'user-hetzner',
      encryptedToken: encrypted.ciphertext,
      iv: encrypted.iv,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      hetznerResponse([
        hetznerServerType({
          id: 1,
          name: 'cx23',
          description: 'CX23',
          cores: 2,
          memory: 4,
          disk: 40,
          hourlyGross: '0.0048',
          monthlyGross: '3.99',
        }),
      ])
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: true,
      env: catalogEnv(),
    });
    const firstPassCalls = fetchMock.mock.calls.length;

    // A second pass inside the cache TTL must not re-ask the provider for the same credential.
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: true,
      env: catalogEnv(),
    });

    expect(fetchMock.mock.calls.length).toBe(firstPassCalls);
    // Discriminating control: a cleared cache does re-ask, so "no extra calls" is not just a
    // reconciler that stopped refreshing.
    clearCapacityCatalogCache();
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: 'user-1',
      includeInstallation: true,
      env: catalogEnv(),
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(firstPassCalls);
  });
});
