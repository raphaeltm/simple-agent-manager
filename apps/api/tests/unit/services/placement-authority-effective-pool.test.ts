/**
 * The claimed capacity pool must still be the CURRENT effective pool at final
 * admission and at every paid provider boundary.
 *
 * The defect this pins: `buildPlacementAuthoritySqlPredicate` verified pool/source/
 * candidate identity and revision, but never that the pool the plan named is the
 * one that governs this run right now. A plan resolved against a user or
 * installation pool therefore stayed admissible after a higher-precedence project
 * default pool appeared (even a configured-empty one, which is authoritative and
 * must NOT fall back), and a pool whose `is_default` flag had been cleared was
 * still accepted.
 *
 * Everything here runs against a real SQLite engine through the D1 boundary
 * adapter: the guard IS a SQL predicate, so a mock whose `.where()` ignores its
 * arguments would pass with the predicate deleted (rule 28).
 */
import type { CapacityPlacementSnapshot } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import {
  findNodeWithCapacity,
  tryClaimWarmNode,
} from '../../../src/durable-objects/task-runner/node-selection';
import { handleNodeSelection } from '../../../src/durable-objects/task-runner/node-steps';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';
import type { Env } from '../../../src/env';
import { updateDefaultCapacityPool } from '../../../src/services/default-capacity-pool-updates';
import { assertNodeAllocationPlanCurrent } from '../../../src/services/nodes';
import type { TaskStartCapacityPoolSelection } from '../../../src/services/placement-resolver';
import { filterReusableNodesByCurrentAuthority } from '../../../src/services/reusable-node-authority';
import type { WorkspacePlacementInput } from '../../../src/services/workspace-placement';
import { reserveWorkspacePlacement } from '../../../src/services/workspace-placement';
import { resolveWorkspaceAdmissionPolicy } from '../../../src/services/workspace-resource-capacity';
import {
  createAllSchemaTables,
  createSqliteD1,
  createSqliteD1WithBindLimit,
} from '../../helpers/sqlite-d1';

/** Default admission policy: the placement contract takes a resolved policy, never a count. */
const ADMISSION_POLICY = resolveWorkspaceAdmissionPolicy({} as never);

const AUTHORITY_VERSION = 1_700_000_000_000;
const AUTHORITY_TIMESTAMP = new Date(AUTHORITY_VERSION).toISOString();
const USER_ID = 'user-1';
const PROJECT_ID = 'project-1';

let sqlite: Database.Database | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

type PoolScope = 'project' | 'user' | 'installation';

interface PoolFixture {
  poolId: string;
  sourceId: string;
  candidateId: string;
  scope: PoolScope;
  /** Cloud credential behind the source; the seeded personal credential by default. */
  credentialId?: string;
}

function db(): Database.Database {
  if (!sqlite) throw new Error('SQLite fixture was not initialized');
  return sqlite;
}

function createDb(): D1Database {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  db().exec(`
    INSERT INTO project_members
      (project_id, user_id, role, status, removed_at, created_at, updated_at)
    VALUES
      ('${PROJECT_ID}', '${USER_ID}', 'owner', 'active', NULL,
       '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');

    INSERT INTO credentials
      (id, user_id, project_id, provider, credential_type, is_active, encrypted_token, iv,
       created_at, updated_at)
    VALUES
      ('user-cloud', '${USER_ID}', NULL, 'hetzner', 'cloud-provider', 1, 'enc', 'iv',
       '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');
  `);
  return createSqliteD1(sqlite);
}

/**
 * Seed one complete, currently-valid pool at `scope`, backed by the same personal
 * cloud credential. `isDefault` is a parameter because "the selected pool is no
 * longer the default of its own scope" is one of the cases under test.
 */
function seedPool(scope: PoolScope, options: { isDefault?: boolean } = {}): PoolFixture {
  const poolId = `pool-${scope}`;
  const sourceId = `source-${scope}`;
  const candidateId = `candidate-${scope}`;
  const ownerUserId = scope === 'user' ? `'${USER_ID}'` : 'NULL';
  const ownerProjectId = scope === 'project' ? `'${PROJECT_ID}'` : 'NULL';
  const isDefault = options.isDefault === false ? 0 : 1;

  db().exec(`
    INSERT INTO capacity_pools
      (id, scope, owner_user_id, owner_project_id, name, is_default, revision, status,
       configuration_state, strategy, exhaustion_policy, migration_state, created_at, updated_at)
    VALUES
      ('${poolId}', '${scope}', ${ownerUserId}, ${ownerProjectId}, '${scope} pool', ${isDefault},
       4, 'active', 'configured-ready', 'balanced', 'queue', 'complete',
       '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');

    INSERT INTO capacity_sources
      (id, scope, owner_user_id, owner_project_id, source_kind, provider, credential_source,
       credential_id, platform_credential_id, credential_reference, credential_version,
       external_source_ref, status, created_at, updated_at)
    VALUES
      ('${sourceId}', '${scope}', ${ownerUserId}, ${ownerProjectId}, 'cloud-provider-credential',
       'hetzner', 'user', 'user-cloud', NULL, 'credentials:user-cloud', ${AUTHORITY_VERSION},
       NULL, 'active', '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');

    INSERT INTO capacity_pool_candidates
      (id, pool_id, capacity_source_id, provider, location, workload_role, provider_instance_type,
       provider_instance_vcpu_count, provider_instance_memory_mb, provider_instance_disk_gb,
       provider_instance_boot_disk_size_gb, provider_instance_image, provider_instance_architecture,
       catalog_availability, status, priority, candidate_order, created_at, updated_at)
    VALUES
      ('${candidateId}', '${poolId}', '${sourceId}', 'hetzner', 'fsn1', 'workspace', 'cx42',
       8, ${16 * 1024}, 240, NULL, NULL, NULL, 'available', 'active', 0, 0,
       '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');
  `);

  return { poolId, sourceId, candidateId, scope };
}

/**
 * A second account (credential, capacity source and active pick) in the same pool as `pool`,
 * so a test can switch one account off and watch the other.
 */
function seedSecondAccount(pool: PoolFixture): PoolFixture {
  const credentialId = 'user-cloud-b';
  const sourceId = `${pool.sourceId}-b`;
  const candidateId = `${pool.candidateId}-b`;
  db().exec(`
    INSERT INTO credentials
      (id, user_id, project_id, provider, credential_type, is_active, encrypted_token, iv,
       created_at, updated_at)
    VALUES
      ('${credentialId}', '${USER_ID}', NULL, 'hetzner', 'cloud-provider', 1, 'enc', 'iv',
       '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');

    INSERT INTO capacity_sources
      (id, scope, owner_user_id, owner_project_id, source_kind, provider, credential_source,
       credential_id, platform_credential_id, credential_reference, credential_version,
       external_source_ref, status, created_at, updated_at)
    VALUES
      ('${sourceId}', 'user', '${USER_ID}', NULL, 'cloud-provider-credential',
       'hetzner', 'user', '${credentialId}', NULL, 'credentials:${credentialId}',
       ${AUTHORITY_VERSION}, NULL, 'active', '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');

    INSERT INTO capacity_pool_candidates
      (id, pool_id, capacity_source_id, provider, location, workload_role, provider_instance_type,
       provider_instance_vcpu_count, provider_instance_memory_mb, provider_instance_disk_gb,
       provider_instance_boot_disk_size_gb, provider_instance_image, provider_instance_architecture,
       catalog_availability, status, priority, candidate_order, created_at, updated_at)
    VALUES
      ('${candidateId}', '${pool.poolId}', '${sourceId}', 'hetzner', 'fsn1', 'workspace', 'cx42',
       8, ${16 * 1024}, 240, NULL, NULL, NULL, 'available', 'active', 1, 1,
       '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');
  `);
  return { ...pool, sourceId, candidateId, credentialId };
}

/**
 * A configured-empty higher-precedence default pool: it has no usable candidates,
 * which is exactly the case that must still be authoritative rather than falling
 * back to a lower scope.
 */
function seedConfiguredEmptyProjectDefaultPool(): void {
  db().exec(`
    INSERT INTO capacity_pools
      (id, scope, owner_user_id, owner_project_id, name, is_default, revision, status,
       configuration_state, strategy, exhaustion_policy, migration_state, created_at, updated_at)
    VALUES
      ('pool-project-empty', 'project', NULL, '${PROJECT_ID}', 'Project pool', 1, 1, 'active',
       'configured-empty', 'balanced', 'queue', 'complete',
       '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');
  `);
}

function snapshotFor(fixture: PoolFixture): CapacityPlacementSnapshot {
  return {
    capacityPoolId: fixture.poolId,
    capacityPoolScope: fixture.scope,
    capacityPoolRevision: 4,
    capacitySourceId: fixture.sourceId,
    capacitySourceGeneration: AUTHORITY_VERSION,
    capacitySourceExternalRef: null,
    capacityPoolCandidateId: fixture.candidateId,
    placementCredentialSource: 'user',
    placementCredentialReference: `credentials:${fixture.credentialId ?? 'user-cloud'}`,
    placementCredentialVersion: AUTHORITY_VERSION,
    capacityPoolProjectId: fixture.scope === 'project' ? PROJECT_ID : null,
    workloadRole: 'workspace',
    providerInstanceType: 'cx42',
    providerInstanceVcpuCount: 8,
    providerInstanceMemoryMb: 16 * 1024,
    providerInstanceDiskGb: 240,
    providerInstanceBootDiskSizeGb: null,
    providerInstanceImage: null,
    providerInstanceArchitecture: null,
    providerInstancePriceDisplay: null,
    providerInstancePriceCurrency: null,
    providerInstancePriceMonthlyCents: null,
    providerInstancePriceHourlyMicros: null,
    placementExplanationJson: null,
  };
}

function seedNode(fixture: PoolFixture | null, overrides: Record<string, unknown> = {}): void {
  const snapshot = fixture ? snapshotFor(fixture) : null;
  const row: Record<string, unknown> = {
    id: 'node-1',
    user_id: USER_ID,
    name: 'Node',
    status: 'running',
    runtime: 'vm',
    vm_size: 'large',
    vm_location: 'fsn1',
    cloud_provider: 'hetzner',
    provider_instance_id: 'server-1',
    node_role: 'workspace',
    node_class: 'managed',
    workload_role: 'workspace',
    capacity_pool_id: snapshot?.capacityPoolId ?? null,
    capacity_pool_scope: snapshot?.capacityPoolScope ?? null,
    capacity_pool_revision: snapshot?.capacityPoolRevision ?? null,
    capacity_source_id: snapshot?.capacitySourceId ?? null,
    capacity_source_generation: snapshot?.capacitySourceGeneration ?? null,
    capacity_source_external_ref: null,
    capacity_pool_candidate_id: snapshot?.capacityPoolCandidateId ?? null,
    capacity_pool_project_id: snapshot?.capacityPoolProjectId ?? null,
    placement_credential_source: snapshot?.placementCredentialSource ?? null,
    placement_credential_reference: snapshot?.placementCredentialReference ?? null,
    placement_credential_version: snapshot?.placementCredentialVersion ?? null,
    provider_instance_type: snapshot?.providerInstanceType ?? null,
    provider_instance_vcpu_count: snapshot?.providerInstanceVcpuCount ?? null,
    provider_instance_memory_mb: snapshot?.providerInstanceMemoryMb ?? null,
    provider_instance_disk_gb: snapshot?.providerInstanceDiskGb ?? null,
    provider_instance_boot_disk_size_gb: null,
    provider_instance_image: null,
    provider_instance_architecture: null,
    observed_provider_instance_type: 'cx42',
    observed_provider_instance_vcpu_count: 8,
    observed_provider_instance_memory_mb: 16 * 1024,
    observed_provider_instance_disk_gb: 240,
    observed_hardware_source: 'observed',
    health_status: 'healthy',
    heartbeat_stale_after_seconds: 180,
    last_metrics: null,
    node_mode: 'shared',
    created_at: AUTHORITY_TIMESTAMP,
    updated_at: AUTHORITY_TIMESTAMP,
    ...overrides,
  };
  const columns = Object.keys(row);
  db()
    .prepare(
      `INSERT INTO nodes (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...columns.map((column) => row[column] as never));
}

function placementInput(
  fixture: PoolFixture | null,
  overrides: Partial<WorkspacePlacementInput> = {}
): WorkspacePlacementInput {
  return {
    id: `workspace-${Math.random().toString(36).slice(2, 10)}`,
    nodeId: 'node-1',
    projectId: PROJECT_ID,
    userId: USER_ID,
    installationId: 'installation-1',
    name: 'workspace',
    displayName: 'workspace',
    normalizedDisplayName: 'workspace',
    repository: 'acme/repo',
    branch: 'main',
    vmSize: 'large',
    vmLocation: 'fsn1',
    workspaceProfile: 'full',
    devcontainerConfigName: null,
    agentProfileHint: null,
    resourceRequirementsJson: null,
    capacityPlacementSnapshot: fixture ? snapshotFor(fixture) : null,
    createdAt: AUTHORITY_TIMESTAMP,
    ...overrides,
  };
}

function envFor(database: D1Database): Env {
  return { DATABASE: database } as unknown as Env;
}

function reuseState(fixture: PoolFixture): TaskRunnerState {
  const snapshot = snapshotFor(fixture);
  const selection = {
    poolId: fixture.poolId,
    scope: fixture.scope,
    revision: 4,
    strategy: 'balanced',
    exhaustionPolicy: 'queue',
    effectiveState: 'configured-ready',
    capacityPoolProjectId: null,
    workloadRole: 'workspace',
    poolSnapshot: snapshot,
    candidates: [
      {
        ...snapshot,
        id: fixture.candidateId,
        poolId: fixture.poolId,
        provider: 'hetzner',
        location: 'fsn1',
        machineSize: 'large',
        credentialAttributionSource: 'user',
        snapshot,
      },
    ],
  } as TaskStartCapacityPoolSelection;
  return {
    taskId: 'task-reuse',
    userId: USER_ID,
    projectId: PROJECT_ID,
    config: {
      vmSize: 'large',
      vmLocation: 'fsn1',
      capacityPoolSelection: selection,
      resolvedReservation: {
        version: 2,
        cpuMillis: 1000,
        memoryMb: 1024,
        diskMb: 1024,
        exclusiveNode: false,
        source: 'platform',
        sourceId: 'platform',
      },
    },
    stepResults: { nodeId: null },
  } as TaskRunnerState;
}

describe('reuse selection agrees with final authority admission', () => {
  it('never claims a stale warm node when a current warm host is available', async () => {
    const database = createDb();
    const pool = seedPool('user');
    seedNode(pool, { capacity_pool_revision: 3, warm_since: AUTHORITY_TIMESTAMP });
    seedNode(pool, { id: 'node-2', warm_since: AUTHORITY_TIMESTAMP });
    const claimedIds: string[] = [];
    const context = {
      env: {
        ...envFor(database),
        NODE_LIFECYCLE: {
          idFromName: (id: string) => id,
          get: (id: string) => ({
            tryClaim: async () => {
              claimedIds.push(id);
              return { claimed: true };
            },
          }),
        },
      },
      assertRecoveryAuthority: vi.fn(),
      ctx: { storage: { put: vi.fn() } },
    } as unknown as TaskRunnerContext;
    expect((await tryClaimWarmNode(reuseState(pool), context))?.nodeId).toBe('node-2');
    expect(claimedIds).toEqual(['node-2']);
  });

  it('rejects a stale preferred host before advancing to workspace creation', async () => {
    const database = createDb();
    const pool = seedPool('user');
    seedNode(pool, { capacity_pool_revision: 3 });
    const state = reuseState(pool);
    state.config.preferredNodeId = 'node-1';
    const advanceToStep = vi.fn();
    await expect(
      handleNodeSelection(state, {
        env: envFor(database),
        updateD1ExecutionStep: vi.fn(),
        advanceToStep,
      } as unknown as TaskRunnerContext)
    ).rejects.toMatchObject({ permanent: true });
    expect(advanceToStep).not.toHaveBeenCalled();
  });

  it('skips a stale pool revision and selects the current host instead of retrying the same host', async () => {
    const database = createDb();
    const pool = seedPool('user');
    seedNode(pool, { capacity_pool_revision: 3 });
    seedNode(pool, { id: 'node-2' });

    expect(await reserveWorkspacePlacement(database, placementInput(pool), ADMISSION_POLICY)).toBe(
      false
    );
    const selected = await findNodeWithCapacity(reuseState(pool), {
      env: envFor(database),
    } as TaskRunnerContext);
    expect(selected?.nodeId).toBe('node-2');
    expect(
      await reserveWorkspacePlacement(
        database,
        placementInput(pool, { nodeId: 'node-2' }),
        ADMISSION_POLICY
      )
    ).toBe(true);
  });

  it('returns no reusable node when only a grandfathered host exists under a current user pool', async () => {
    const database = createDb();
    const pool = seedPool('user');
    seedNode(null);
    expect(
      await findNodeWithCapacity(reuseState(pool), {
        env: envFor(database),
      } as TaskRunnerContext)
    ).toBeNull();
  });

  it.each([
    "UPDATE credentials SET is_active = 0 WHERE id = 'user-cloud'",
    "UPDATE project_members SET status = 'removed' WHERE project_id = 'project-1'",
    "UPDATE capacity_pools SET is_default = 0 WHERE id = 'pool-user'",
  ])('does not offer a node whose authority was revoked: %s', async (sql) => {
    const database = createDb();
    const pool = seedPool('user');
    seedNode(pool);
    db().exec(sql);
    expect(
      await findNodeWithCapacity(reuseState(pool), {
        env: envFor(database),
      } as TaskRunnerContext)
    ).toBeNull();
  });

  it('keeps a running node reusable after the pool provider order changes', async () => {
    const database = createDb();
    const pool = seedPool('user');
    // The authority fixture leaves this policy column unset; the update writer reads it.
    db().exec(`UPDATE capacity_pools SET deployment_strategy = 'smallest-fit'`);
    seedNode(pool);
    const update = (input: Omit<Parameters<typeof updateDefaultCapacityPool>[1], 'scope'>) =>
      updateDefaultCapacityPool(drizzle(database, { schema }), { scope: 'user', ...input });
    const reusable = () =>
      filterReusableNodesByCurrentAuthority(database, {
        userId: USER_ID,
        projectId: PROJECT_ID,
        selections: [{ nodeId: 'node-1', capacityPlacementSnapshot: snapshotFor(pool) }],
      });

    // A reorder must leave reuse alone: it does not bump the revision reuse authority checks.
    const reorder = await update({
      ownerUserId: USER_ID,
      ownerProjectId: null,
      sourceOrder: [pool.sourceId],
    });
    expect(reorder).toMatchObject({ conflict: false, missingSourceIds: [] });
    expect(reorder.summary?.pool.sourceOrder).toEqual([pool.sourceId]);

    expect(await reusable()).toEqual(new Set(['node-1']));
    await expect(
      reserveWorkspacePlacement(database, placementInput(pool), ADMISSION_POLICY)
    ).resolves.toBe(true);

    // Control: a policy edit bumps the revision, and the same node stops being reusable. Without
    // this, the assertions above would also pass if reuse ignored the revision entirely.
    await update({
      ownerUserId: USER_ID,
      ownerProjectId: null,
      policy: { exhaustionPolicy: 'fallback-chain' },
    });
    expect(await reusable()).toEqual(new Set());
  });

  it('stops reuse and admission on an account switched off, and restores both when it is back on', async () => {
    const database = createDb();
    const pool = seedPool('user');
    db().exec(`UPDATE capacity_pools SET deployment_strategy = 'smallest-fit'`);
    seedNode(pool);
    const update = (input: Omit<Parameters<typeof updateDefaultCapacityPool>[1], 'scope'>) =>
      updateDefaultCapacityPool(drizzle(database, { schema }), { scope: 'user', ...input });
    const reusable = () =>
      filterReusableNodesByCurrentAuthority(database, {
        userId: USER_ID,
        projectId: PROJECT_ID,
        selections: [{ nodeId: 'node-1', capacityPlacementSnapshot: snapshotFor(pool) }],
      });
    // Owner-path control: the account is on, so its running node is reusable.
    expect(await reusable()).toEqual(new Set(['node-1']));

    const off = await update({
      ownerUserId: USER_ID,
      ownerProjectId: null,
      excludedSourceIds: [pool.sourceId],
    });
    expect(off).toMatchObject({ conflict: false, missingSourceIds: [] });
    expect(off.summary?.pool.excludedSourceIds).toEqual([pool.sourceId]);
    // Like the provider order, switching an account off does not bump the revision: other
    // accounts' running nodes stay reusable.
    expect(off.summary?.pool.revision).toBe(4);
    expect(off.summary?.activeCandidateCount).toBe(0);
    expect(off.summary?.effectiveState).toBe('configured-empty');
    // Its picks are kept, not removed.
    expect(
      db().prepare('SELECT status FROM capacity_pool_candidates WHERE id = ?').get(pool.candidateId)
    ).toEqual({ status: 'active' });
    // The authority SQL refuses the switched-off account for reuse and for final admission.
    expect(await reusable()).toEqual(new Set());
    await expect(
      reserveWorkspacePlacement(database, placementInput(pool), ADMISSION_POLICY)
    ).resolves.toBe(false);

    const on = await update({ ownerUserId: USER_ID, ownerProjectId: null, excludedSourceIds: [] });
    expect(on.summary?.pool.excludedSourceIds).toEqual([]);
    expect(on.summary?.activeCandidateCount).toBe(1);
    expect(await reusable()).toEqual(new Set(['node-1']));
    await expect(
      reserveWorkspacePlacement(database, placementInput(pool), ADMISSION_POLICY)
    ).resolves.toBe(true);
  });

  describe('two accounts in one pool, one switched off', () => {
    /** Accounts A and B each hold an active pick and a running node. */
    function twoAccountFixture() {
      const database = createDb();
      const a = seedPool('user');
      const b = seedSecondAccount(a);
      db().exec(`UPDATE capacity_pools SET deployment_strategy = 'smallest-fit'`);
      seedNode(a, { id: 'node-a', provider_instance_id: 'server-a' });
      seedNode(b, { id: 'node-b', provider_instance_id: 'server-b' });
      const reusable = () =>
        filterReusableNodesByCurrentAuthority(database, {
          userId: USER_ID,
          projectId: PROJECT_ID,
          selections: [
            { nodeId: 'node-a', capacityPlacementSnapshot: snapshotFor(a) },
            { nodeId: 'node-b', capacityPlacementSnapshot: snapshotFor(b) },
          ],
        });
      const admits = (fixture: PoolFixture, nodeId: string) =>
        reserveWorkspacePlacement(database, placementInput(fixture, { nodeId }), ADMISSION_POLICY);
      const exclude = (excludedSourceIds: string[]) =>
        updateDefaultCapacityPool(drizzle(database, { schema }), {
          scope: 'user',
          ownerUserId: USER_ID,
          ownerProjectId: null,
          excludedSourceIds,
        });
      return { a, b, reusable, admits, exclude };
    }

    it('reuses and admits both accounts while neither is switched off (control)', async () => {
      const { a, b, reusable, admits } = twoAccountFixture();
      expect(await reusable()).toEqual(new Set(['node-a', 'node-b']));
      await expect(admits(a, 'node-a')).resolves.toBe(true);
      await expect(admits(b, 'node-b')).resolves.toBe(true);
    });

    it('keeps the node on account B usable and refuses the node on switched-off account A', async () => {
      const { a, b, reusable, admits, exclude } = twoAccountFixture();
      const result = await exclude([a.sourceId]);
      expect(result).toMatchObject({ conflict: false, missingSourceIds: [] });
      expect(result.summary?.pool.excludedSourceIds).toEqual([a.sourceId]);

      expect(await reusable()).toEqual(new Set(['node-b']));
      await expect(admits(a, 'node-a')).resolves.toBe(false);
      await expect(admits(b, 'node-b')).resolves.toBe(true);
    });

    it('mirrors the exclusion: switching B off keeps the node on A and refuses the one on B', async () => {
      const { a, b, reusable, admits, exclude } = twoAccountFixture();
      await exclude([b.sourceId]);

      expect(await reusable()).toEqual(new Set(['node-a']));
      await expect(admits(b, 'node-b')).resolves.toBe(false);
      await expect(admits(a, 'node-a')).resolves.toBe(true);
    });

    it('leaves both nodes usable when the excluded id is not the source of either node', async () => {
      const { a, b, reusable, admits } = twoAccountFixture();
      // A stale id (an account that no longer serves the pool) is harmless by design.
      db().exec(`UPDATE capacity_pools SET excluded_source_ids_json = '["source-long-gone"]'`);

      expect(await reusable()).toEqual(new Set(['node-a', 'node-b']));
      await expect(admits(a, 'node-a')).resolves.toBe(true);
      await expect(admits(b, 'node-b')).resolves.toBe(true);
    });

    it('refuses both nodes when both accounts are switched off, and restores both on clearing', async () => {
      const { a, b, reusable, admits, exclude } = twoAccountFixture();
      await exclude([a.sourceId, b.sourceId]);
      expect(await reusable()).toEqual(new Set());
      await expect(admits(a, 'node-a')).resolves.toBe(false);
      await expect(admits(b, 'node-b')).resolves.toBe(false);

      await exclude([]);
      expect(await reusable()).toEqual(new Set(['node-a', 'node-b']));
      await expect(admits(a, 'node-a')).resolves.toBe(true);
    });
  });

  it('filters 150 hosts using grouped queries within the D1 parameter ceiling', async () => {
    createDb();
    const pool = seedPool('user');
    const selections = Array.from({ length: 150 }, (_, index) => {
      const nodeId = `node-${index}`;
      seedNode(pool, { id: nodeId });
      return { nodeId, capacityPlacementSnapshot: snapshotFor(pool) };
    });
    const database = createSqliteD1WithBindLimit(db(), 100);
    const prepare = vi.spyOn(database, 'prepare');
    const eligible = await filterReusableNodesByCurrentAuthority(database, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      selections,
    });
    expect(eligible.size).toBe(150);
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe('current effective pool authority at final admission', () => {
  it('admits a user-pool node while the user default pool is the effective pool', async () => {
    const database = createDb();
    const pool = seedPool('user');
    seedNode(pool);

    await expect(
      reserveWorkspacePlacement(database, placementInput(pool), ADMISSION_POLICY)
    ).resolves.toBe(true);
  });

  it('rejects a user-pool node once a configured-empty project default pool outranks it', async () => {
    const database = createDb();
    const pool = seedPool('user');
    seedNode(pool);
    // Introduced AFTER the plan was resolved — the exact race the guard exists for.
    seedConfiguredEmptyProjectDefaultPool();

    await expect(
      reserveWorkspacePlacement(database, placementInput(pool), ADMISSION_POLICY)
    ).resolves.toBe(false);
    expect(
      (db().prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count
    ).toBe(0);
  });

  it('admits an installation-pool node when installation is the effective scope', async () => {
    const database = createDb();
    const pool = seedPool('installation');
    seedNode(pool);

    await expect(
      reserveWorkspacePlacement(database, placementInput(pool), ADMISSION_POLICY)
    ).resolves.toBe(true);
  });

  it('rejects an installation-pool node once a user default pool outranks it', async () => {
    // Deliberately a fresh, EMPTY node: reusing the node from the previous case
    // would also be refused for having an occupied node with no fresh metrics,
    // which would make this assertion pass with the precedence fence deleted.
    const database = createDb();
    const pool = seedPool('installation');
    seedNode(pool);
    seedPool('user');

    await expect(
      reserveWorkspacePlacement(database, placementInput(pool), ADMISSION_POLICY)
    ).resolves.toBe(false);
    expect(
      (db().prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number }).count
    ).toBe(0);
  });

  it('rejects a node whose own pool is no longer the default of its scope', async () => {
    const database = createDb();
    const pool = seedPool('user');
    seedNode(pool);

    db().exec(`UPDATE capacity_pools SET is_default = 0 WHERE id = '${pool.poolId}'`);

    await expect(
      reserveWorkspacePlacement(database, placementInput(pool), ADMISSION_POLICY)
    ).resolves.toBe(false);
  });

  it('keeps admitting a project-pool node — nothing outranks the project scope', async () => {
    const database = createDb();
    const pool = seedPool('project');
    seedNode(pool);
    // A user default pool is LOWER precedence and must not disturb a project plan.
    seedPool('user');

    await expect(
      reserveWorkspacePlacement(database, placementInput(pool), ADMISSION_POLICY)
    ).resolves.toBe(true);
  });

  it('preserves same-user/same-project isolation for project-pool nodes', async () => {
    const database = createDb();
    const pool = seedPool('project');
    seedNode(pool);

    // Another project the same user belongs to may not consume a project-pool node.
    db().exec(`
      INSERT INTO project_members
        (project_id, user_id, role, status, removed_at, created_at, updated_at)
      VALUES
        ('project-2', '${USER_ID}', 'owner', 'active', NULL,
         '${AUTHORITY_TIMESTAMP}', '${AUTHORITY_TIMESTAMP}');
    `);

    await expect(
      reserveWorkspacePlacement(
        database,
        placementInput(pool, { projectId: 'project-2' }),
        ADMISSION_POLICY
      )
    ).resolves.toBe(false);
  });

  it("rejects another user's node even with a valid pool plan", async () => {
    const database = createDb();
    const pool = seedPool('user');
    seedNode(pool, { user_id: 'user-2' });

    await expect(
      reserveWorkspacePlacement(database, placementInput(pool), ADMISSION_POLICY)
    ).resolves.toBe(false);
  });

  it('keeps the composed reservation statement inside the D1 bind ceiling', async () => {
    createDb();
    const pool = seedPool('project');
    seedNode(pool);

    await expect(
      reserveWorkspacePlacement(
        createSqliteD1WithBindLimit(db(), 100),
        placementInput(pool, { resourceRequirementsJson: '{"minVcpu":2}' }),
        ADMISSION_POLICY
      )
    ).resolves.toBe(true);
  });
});

describe('current effective pool authority at the paid provider boundary', () => {
  it('accepts an explicitly selected node while its pool is still effective', async () => {
    const database = createDb();
    const pool = seedPool('user');
    seedNode(pool);

    await expect(
      assertNodeAllocationPlanCurrent(envFor(database), 'node-1', USER_ID, PROJECT_ID)
    ).resolves.toBeUndefined();
  });

  it('rejects an explicitly selected node once a higher-precedence default pool exists', async () => {
    const database = createDb();
    const pool = seedPool('user');
    seedNode(pool);
    seedConfiguredEmptyProjectDefaultPool();

    await expect(
      assertNodeAllocationPlanCurrent(envFor(database), 'node-1', USER_ID, PROJECT_ID)
    ).rejects.toThrow('Node allocation plan is no longer current');
  });

  it('rejects an explicitly selected node whose pool lost its default flag', async () => {
    const database = createDb();
    const pool = seedPool('user');
    seedNode(pool);
    db().exec(`UPDATE capacity_pools SET is_default = 0 WHERE id = '${pool.poolId}'`);

    await expect(
      assertNodeAllocationPlanCurrent(envFor(database), 'node-1', USER_ID, PROJECT_ID)
    ).rejects.toThrow('Node allocation plan is no longer current');
  });
});

describe('legacy unpooled nodes follow the same effective-pool chain', () => {
  it('admits a legacy unpooled node while the caller has no default pool at all', async () => {
    const database = createDb();
    seedNode(null);

    await expect(
      reserveWorkspacePlacement(database, placementInput(null), ADMISSION_POLICY)
    ).resolves.toBe(true);
  });

  it('stops admitting a legacy unpooled node once any default pool governs the caller', async () => {
    const database = createDb();
    seedNode(null);
    seedPool('user');

    await expect(
      reserveWorkspacePlacement(database, placementInput(null), ADMISSION_POLICY)
    ).resolves.toBe(false);
  });
});
