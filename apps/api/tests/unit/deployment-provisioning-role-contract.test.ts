import { Buffer } from 'node:buffer';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { provisionNodeMock } = vi.hoisted(() => ({
  provisionNodeMock: vi.fn(),
}));

vi.mock('../../src/services/nodes', async (importActual) => {
  const actual = await importActual<typeof import('../../src/services/nodes')>();
  return {
    ...actual,
    provisionNode: provisionNodeMock,
  };
});

vi.mock('../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: vi.fn((err: unknown) => ({
    error: err instanceof Error ? err.message : String(err),
  })),
}));

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { resolveCanonicalVmAllocationPlan } from '../../src/services/canonical-vm-allocation';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../src/services/default-capacity-pools';
import { provisionDeploymentNode } from '../../src/services/deployment-provisioning';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const OWNER_ID = 'owner-shared-deploy';
const MEMBER_ID = 'maintainer-shared-deploy';
const PROJECT_ID = 'project-shared-deploy';
const INSTALLATION_ID = 'installation-shared-deploy';
const ENVIRONMENT_ID = 'environment-shared-deploy';
const PROJECT_CREDENTIAL_ID = 'project-hetzner-shared-deploy';
const CREATED_AT = '2026-09-07T06:00:00.000Z';

let sqlite: Database.Database | null = null;

function createFixture() {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  const database = createSqliteD1(sqlite);
  const db = drizzle(sqlite, { schema });
  const env = {
    DATABASE: database,
    ENCRYPTION_KEY: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
    DEPLOYMENT_DEFAULT_VM_SIZE: 'small',
  } as Env;
  return { db, env };
}

function seedSharedProjectFixture(): void {
  sqlite?.exec(`
    INSERT INTO users (id) VALUES ('${OWNER_ID}'), ('${MEMBER_ID}');

    INSERT INTO github_installations
      (id, user_id, installation_id, external_installation_id, account_type, account_name, created_at, updated_at)
    VALUES
      ('${INSTALLATION_ID}', '${OWNER_ID}', '120099901', '120099901', 'organization', 'deploy-org', '${CREATED_AT}', '${CREATED_AT}');

    INSERT INTO projects
      (id, user_id, name, normalized_name, installation_id, repository, default_branch,
       default_provider, default_location, default_vm_size, created_by, created_at, updated_at)
    VALUES
      ('${PROJECT_ID}', '${OWNER_ID}', 'Shared deployment', 'shared-deployment',
       '${INSTALLATION_ID}', 'deploy-org/app', 'main', 'hetzner', 'fsn1', 'small',
       '${OWNER_ID}', '${CREATED_AT}', '${CREATED_AT}');

    INSERT INTO project_members
      (project_id, user_id, role, status, removed_at, created_at, updated_at)
    VALUES
      ('${PROJECT_ID}', '${MEMBER_ID}', 'maintainer', 'active', NULL, '${CREATED_AT}', '${CREATED_AT}');

    INSERT INTO credentials
      (id, user_id, project_id, provider, credential_type, is_active,
       encrypted_token, iv, created_at, updated_at)
    VALUES
      ('${PROJECT_CREDENTIAL_ID}', '${OWNER_ID}', '${PROJECT_ID}', 'hetzner', 'cloud-provider',
       1, 'encrypted-project-token', 'iv', '${CREATED_AT}', '${CREATED_AT}');

    INSERT INTO deployment_environments
      (id, project_id, name, status, node_id, requires_volumes, created_by_user_id,
       created_at, updated_at)
    VALUES
      ('${ENVIRONMENT_ID}', '${PROJECT_ID}', 'production', 'active', NULL, 0,
       '${MEMBER_ID}', '${CREATED_AT}', '${CREATED_AT}');
  `);
}

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

describe('deployment default-pool role eligibility contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('links a canonical deployment node using workspace-role default candidates', async () => {
    const { db, env } = createFixture();
    seedSharedProjectFixture();
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: MEMBER_ID,
      projectId: PROJECT_ID,
      includeInstallation: false,
    });

    let completeProviderCall!: () => void;
    provisionNodeMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeProviderCall = resolve;
        })
    );

    const result = await provisionDeploymentNode(ENVIRONMENT_ID, PROJECT_ID, MEMBER_ID, env, {
      providerOverride: 'hetzner',
      vmLocationOverride: 'fsn1',
    });
    expect(result).not.toBeNull();

    const node = sqlite
      ?.prepare(
        `SELECT node_role, workload_role, capacity_pool_id, capacity_pool_candidate_id,
                provider_instance_type
           FROM nodes
          WHERE id = ?`
      )
      .get(result!.nodeId) as
      | {
          node_role: string;
          workload_role: string;
          capacity_pool_id: string;
          capacity_pool_candidate_id: string;
          provider_instance_type: string;
        }
      | undefined;
    expect(node).toMatchObject({
      node_role: 'deployment',
      workload_role: 'deployment',
    });
    expect(node?.capacity_pool_id).toBeTruthy();
    expect(node?.capacity_pool_candidate_id).toBeTruthy();

    const candidate = sqlite
      ?.prepare(`SELECT workload_role FROM capacity_pool_candidates WHERE id = ?`)
      .get(node?.capacity_pool_candidate_id) as { workload_role: string } | undefined;
    expect(candidate?.workload_role).toBe('workspace');

    const linked = sqlite
      ?.prepare(`SELECT node_id, provider, location FROM deployment_environments WHERE id = ?`)
      .get(ENVIRONMENT_ID);
    expect(linked).toMatchObject({
      node_id: result!.nodeId,
      provider: 'hetzner',
      location: 'fsn1',
    });

    await env.DATABASE.prepare(
      `UPDATE nodes SET status = 'running', health_status = 'healthy' WHERE id = ?`
    )
      .bind(result!.nodeId)
      .run();
    completeProviderCall();
    await expect(result!.provisioningPromise).resolves.toBeUndefined();
  });

  it('rejects deployment-only candidates for workspace allocations', async () => {
    const { db, env } = createFixture();
    seedSharedProjectFixture();
    await ensureDefaultCapacityPoolsForExistingCredentials(db as never, {
      userId: MEMBER_ID,
      projectId: PROJECT_ID,
      includeInstallation: false,
    });
    sqlite
      ?.prepare(
        `UPDATE capacity_pool_candidates
            SET workload_role = 'deployment'
          WHERE pool_id IN (
            SELECT id FROM capacity_pools
             WHERE scope = 'project' AND owner_project_id = ?
          )`
      )
      .run(PROJECT_ID);

    const allocation = await resolveCanonicalVmAllocationPlan(db as never, env, {
      entryPoint: 'direct-workspace',
      taskId: 'workspace-wrong-role-proof',
      userId: MEMBER_ID,
      projectId: PROJECT_ID,
      project: {
        id: PROJECT_ID,
        defaultProvider: 'hetzner',
        defaultLocation: 'fsn1',
        defaultVmSize: 'small',
      },
      explicit: { provider: 'hetzner', vmLocation: 'fsn1', vmSize: 'small' },
      credentialProjectPolicy: 'current-project',
      taskModeDefault: 'task',
      workloadRole: 'workspace',
    });

    expect(allocation).toMatchObject({
      errorKind: 'placement',
      // Deployment-only candidates are not eligible for a workspace allocation,
      // and the refusal names the requested role rather than falling back to
      // another pool.
      error: expect.stringContaining('No eligible compute-pool offering'),
    });
    expect(allocation).toMatchObject({
      error: expect.stringContaining('workspace allocation'),
    });
  });
});
