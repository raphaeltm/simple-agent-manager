/**
 * Deployment environments recover from `error`, and a blocked placement says so.
 *
 * Production environment 01M5HCF0X7Y2S9V74NV0AV3K99 (2026-10-22): release v1 failed placement
 * with a Hetzner 412, which parked the environment in `error`. Releases v2 and v3 then never
 * reached Hetzner. The paid-boundary check required `status = 'active'`, nothing moved the
 * environment out of `error`, and the refusal was treated as a cancellation, so both releases
 * stayed `created` with v1's error still on screen.
 *
 * These tests run the real placement path against SQLite built from the shipped D1
 * migrations: `placeReleaseOnDeploymentNode` → `provisionDeploymentNode` → `createNodeRecord`
 * → `linkEnvironmentToNode` → `assertDeploymentProvisioningAuthority`, and the real Start
 * route. Two boundaries are faked:
 * - `resolveCanonicalVmAllocationPlan` returns the pooled cx23/fsn1 allocation the fixture
 *   seeds (pool selection has its own suites).
 * - `provisionNode` stands in for the provider. Like production
 *   (services/node-provisioning.ts), it clears the placeholder's absence proof, runs
 *   `assertExternalMutationAuthority` immediately before createVM and again after it, and on
 *   a refusal marks the node `error` and rethrows.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  CapacityPlacementSnapshot,
  ResolvedResourceReservation,
} from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { registerDeploymentEnvironmentLifecycleRoutes } from '../../../src/routes/deployment-environment-lifecycle';
import { placeReleaseOnDeploymentNode } from '../../../src/routes/deployment-release-placement';
import {
  type DeploymentPlacement,
  linkEnvironmentToNode,
} from '../../../src/services/deployment-provisioning';
import { recordStrandedDeploymentReleasePlacement } from '../../../src/services/deployment-release-failure';
import { assertDeploymentProvisioningAuthority } from '../../../src/services/provisioning-authority';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const USER_ID = 'user-1';
const PROJECT_ID = 'project-1';
const ENV_ID = 'environment-1';
const POOL_ID = 'capacity-pool-1';
const SOURCE_ID = 'capacity-source-1';
const CANDIDATE_ID = 'capacity-candidate-1';
const PLATFORM_CREDENTIAL_ID = 'platform-credential-1';
const CREDENTIAL_REFERENCE = `platform_credentials:${PLATFORM_CREDENTIAL_ID}`;
const SEEDED_AT = '2026-10-22 08:00:00.123';
const HETZNER_412 = 'hetzner API error (412): error during placement';

const RESERVATION: ResolvedResourceReservation = {
  cpuMillis: 500,
  memoryMb: 512,
  diskMb: 2048,
  exclusiveNode: false,
  source: 'task',
  sourceId: ENV_ID,
  version: 3,
};

const harness = vi.hoisted(() => ({
  sqlite: null as import('better-sqlite3').Database | null,
  snapshot: null as CapacityPlacementSnapshot | null,
  createVmCalls: [] as string[],
  authorityAttempts: 0,
  providerError: null as Error | null,
  /** Runs inside the paid boundary, after the node is linked, before the authority check. */
  beforeAuthority: null as (() => void) | null,
  volumeAttachments: [] as string[],
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  serializeError: (error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }),
}));

vi.mock('../../../src/services/canonical-vm-allocation', async (load) => {
  const actual = await load<typeof import('../../../src/services/canonical-vm-allocation')>();
  return {
    ...actual,
    resolveCanonicalVmAllocationPlan: vi.fn(
      async (
        _db: unknown,
        _env: unknown,
        input: { resolvedReservationOverride?: ResolvedResourceReservation }
      ) => ({
        effectiveProvider: 'hetzner',
        vmLocation: 'fsn1',
        vmSize: 'small',
        credentialAttributionSource: 'platform',
        credentialAttributionUserId: USER_ID,
        credentialAttributionProjectId: null,
        capacityPlacementSnapshot: harness.snapshot,
        providerInstanceType: 'cx23',
        providerInstanceBootDiskSizeGb: null,
        providerInstanceImage: null,
        providerInstanceArchitecture: null,
        eligibleCapacityPoolSelection: null,
        placement: { resolvedReservation: input.resolvedReservationOverride ?? RESERVATION },
      })
    ),
  };
});

vi.mock('../../../src/services/nodes', async (load) => {
  const actual = await load<typeof import('../../../src/services/nodes')>();
  return {
    ...actual,
    provisionNode: vi.fn(
      async (
        nodeId: string,
        _env: Env,
        _unused: unknown,
        options?: { assertExternalMutationAuthority?: () => Promise<void> }
      ) => {
        const sqlite = harness.sqlite!;
        const markError = (message: string) =>
          sqlite
            .prepare(
              `UPDATE nodes SET status = 'error', health_status = 'unhealthy', error_message = ?
                WHERE id = ?`
            )
            .run(`[hetzner] ${message}`, nodeId);
        // The provisioner's incarnation claim clears the placeholder's absence proof first.
        sqlite
          .prepare('UPDATE nodes SET runtime_termination_confirmed_at = NULL WHERE id = ?')
          .run(nodeId);
        harness.beforeAuthority?.();
        harness.authorityAttempts += 1;
        try {
          await options?.assertExternalMutationAuthority?.();
        } catch (error) {
          markError(error instanceof Error ? error.message : String(error));
          throw error;
        }
        harness.createVmCalls.push(nodeId);
        if (harness.providerError) {
          markError(harness.providerError.message);
          throw harness.providerError;
        }
        sqlite
          .prepare(
            `UPDATE nodes SET status = 'running', health_status = 'healthy',
                    provider_instance_id = ?, error_message = NULL
              WHERE id = ?`
          )
          .run(`server-${nodeId}`, nodeId);
        await options?.assertExternalMutationAuthority?.();
        return { allocationConfirmed: true };
      }
    ),
  };
});

vi.mock('../../../src/services/deployment-volumes', async (load) => {
  const actual = await load<typeof import('../../../src/services/deployment-volumes')>();
  return {
    ...actual,
    // Provider volume attach: record which environment asked, nothing else.
    attachEnvironmentVolumesToLinkedNode: vi.fn(
      async (
        _db: unknown,
        _env: unknown,
        _userId: string,
        environmentId: string,
        options?: { assertExternalMutationAuthority?: () => Promise<void> }
      ) => {
        await options?.assertExternalMutationAuthority?.();
        harness.volumeAttachments.push(environmentId);
        return [];
      }
    ),
  };
});

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUserId: () => USER_ID,
}));

vi.mock('../../../src/services/deployment-environment-summary', () => ({
  buildDeploymentEnvironmentResponse: vi.fn(
    async (_db: unknown, _env: unknown, row: unknown) => row
  ),
}));

vi.mock('../../../src/services/project-lifecycle-events', () => ({
  recordDeploymentEnvironmentLifecycleEventBestEffort: vi.fn(async () => undefined),
  recordDeploymentReleaseLifecycleEventBestEffort: vi.fn(async () => undefined),
}));

const migrationDirectory = join(process.cwd(), 'src/db/migrations');
let migratedTemplate: Buffer | null = null;

/** The shipped D1 schema, migrated once and copied per test. */
function migratedDatabase(): Database.Database {
  if (!migratedTemplate) {
    const template = new Database(':memory:');
    for (const file of readdirSync(migrationDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      template.exec(readFileSync(join(migrationDirectory, file), 'utf8'));
    }
    migratedTemplate = template.serialize();
    template.close();
  }
  return new Database(migratedTemplate);
}

const databases: Database.Database[] = [];
afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
  harness.sqlite = null;
  harness.snapshot = null;
  harness.createVmCalls = [];
  harness.authorityAttempts = 0;
  harness.providerError = null;
  harness.beforeAuthority = null;
  harness.volumeAttachments = [];
  vi.clearAllMocks();
});

interface EnvironmentSeed {
  status: string;
  observedErrorMessage?: string | null;
  nodeId?: string | null;
  requiresVolumes?: boolean;
  resolvedReservationJson?: string | null;
}

function fixture(seed: EnvironmentSeed) {
  const sqlite = migratedDatabase();
  databases.push(sqlite);
  harness.sqlite = sqlite;

  sqlite.exec(`
    INSERT INTO users (id, email, role, status) VALUES ('${USER_ID}', 'user-1@example.com', 'user', 'active');
    INSERT INTO github_installations (id, user_id, installation_id, account_type, account_name)
      VALUES ('installation-1', '${USER_ID}', '123', 'Organization', 'acme');
    INSERT INTO projects (id, user_id, name, normalized_name, installation_id, repository, created_by)
      VALUES ('${PROJECT_ID}', '${USER_ID}', 'oct-22-hack', 'oct-22-hack', 'installation-1',
              'acme/oct-22-hack', '${USER_ID}');
    INSERT INTO project_members (project_id, user_id, role, status)
      VALUES ('${PROJECT_ID}', '${USER_ID}', 'owner', 'active');
  `);

  // An installation-scoped default pool backed by the platform credential, offering cx23 in
  // fsn1 for deployments: the shape production placed this environment with.
  sqlite
    .prepare(
      `INSERT INTO platform_credentials
         (id, credential_type, provider, credential_kind, label, encrypted_token, iv,
          is_enabled, created_by, created_at, updated_at)
       VALUES (?, 'cloud-provider', 'hetzner', 'api-key', 'Platform Hetzner', 'token', 'iv', 1,
               ?, ?, ?)`
    )
    .run(PLATFORM_CREDENTIAL_ID, USER_ID, SEEDED_AT, SEEDED_AT);
  const { version } = sqlite
    .prepare(
      `SELECT (CAST(strftime('%s', ?) AS INTEGER) * 1000
             + CAST(substr(strftime('%f', ?), 4, 3) AS INTEGER)) AS version`
    )
    .get(SEEDED_AT, SEEDED_AT) as { version: number };
  sqlite
    .prepare(
      `INSERT INTO capacity_sources
         (id, scope, owner_user_id, owner_project_id, source_kind, provider, credential_source,
          credential_id, platform_credential_id, credential_reference, credential_version,
          external_source_ref, status, created_by, created_at, updated_at)
       VALUES (?, 'installation', NULL, NULL, 'cloud-provider-credential', 'hetzner', 'platform',
               NULL, ?, ?, ?, NULL, 'active', ?, ?, ?)`
    )
    .run(
      SOURCE_ID,
      PLATFORM_CREDENTIAL_ID,
      CREDENTIAL_REFERENCE,
      version,
      USER_ID,
      SEEDED_AT,
      SEEDED_AT
    );
  sqlite
    .prepare(
      `INSERT INTO capacity_pools
         (id, scope, owner_user_id, owner_project_id, name, is_default, revision, status,
          configuration_state, strategy, exhaustion_policy, migration_state, created_by,
          created_at, updated_at)
       VALUES (?, 'installation', NULL, NULL, 'Platform pool', 1, 7, 'active', 'configured-ready',
               'balanced', 'queue', 'complete', ?, ?, ?)`
    )
    .run(POOL_ID, USER_ID, SEEDED_AT, SEEDED_AT);
  sqlite
    .prepare(
      `INSERT INTO capacity_pool_candidates
         (id, pool_id, capacity_source_id, provider, location, workload_role, runtime,
          machine_class, machine_size, provider_instance_type, provider_instance_vcpu_count,
          provider_instance_memory_mb, provider_instance_disk_gb,
          provider_instance_boot_disk_size_gb, provider_instance_image,
          provider_instance_architecture, catalog_availability, status, priority,
          candidate_order, created_at, updated_at)
       VALUES (?, ?, ?, 'hetzner', 'fsn1', 'deployment', 'vm', 'standard', 'small', 'cx23',
               2, 4096, 40, NULL, NULL, NULL, 'available', 'active', 0, 0, ?, ?)`
    )
    .run(CANDIDATE_ID, POOL_ID, SOURCE_ID, SEEDED_AT, SEEDED_AT);

  harness.snapshot = {
    placementPlanVersion: 1,
    capacityPoolId: POOL_ID,
    capacityPoolScope: 'installation',
    capacityPoolRevision: 7,
    capacitySourceId: SOURCE_ID,
    capacitySourceGeneration: version,
    capacitySourceExternalRef: null,
    capacityPoolCandidateId: CANDIDATE_ID,
    placementCredentialSource: 'platform',
    placementCredentialReference: CREDENTIAL_REFERENCE,
    placementCredentialVersion: version,
    capacityPoolProjectId: null,
    workloadRole: 'deployment',
    providerInstanceType: 'cx23',
    providerInstanceVcpuCount: 2,
    providerInstanceMemoryMb: 4096,
    providerInstanceDiskGb: 40,
    providerInstanceBootDiskSizeGb: null,
    providerInstanceImage: null,
    providerInstanceArchitecture: null,
    placementExplanationJson: JSON.stringify({ kind: 'deployment-error-recovery-fixture' }),
  };

  sqlite
    .prepare(
      `INSERT INTO deployment_environments
         (id, project_id, name, status, node_id, provider, location, requires_volumes,
          resolved_reservation_json, observed_status, observed_error_message,
          created_by_user_id, created_at, updated_at)
       VALUES (?, ?, 'staging', ?, ?, 'hetzner', 'fsn1', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ENV_ID,
      PROJECT_ID,
      seed.status,
      seed.nodeId ?? null,
      seed.requiresVolumes ? 1 : 0,
      seed.resolvedReservationJson ?? null,
      seed.observedErrorMessage ? 'failed' : null,
      seed.observedErrorMessage ?? null,
      USER_ID,
      SEEDED_AT,
      SEEDED_AT
    );

  const env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;

  function insertRelease(id: string, version: number, status: string) {
    sqlite
      .prepare(
        `INSERT INTO deployment_releases
           (id, environment_id, manifest, version, status, status_updated_at, source,
            created_by, created_at)
         VALUES (?, ?, '{}', ?, ?, ?, 'compose-publish', ?, ?)`
      )
      .run(id, ENV_ID, version, status, SEEDED_AT, USER_ID, SEEDED_AT);
  }

  function placement(reservation: ResolvedResourceReservation): DeploymentPlacement {
    return {
      projectId: PROJECT_ID,
      provider: 'hetzner',
      location: 'fsn1',
      vmSize: 'small',
      credentialSource: 'platform',
      credentialAttributionUserId: USER_ID,
      credentialAttributionProjectId: null,
      placementCredentialSource: 'platform',
      placementCredentialReference: CREDENTIAL_REFERENCE,
      placementCredentialVersion: version,
      providerInstanceType: 'cx23',
      providerInstanceBootDiskSizeGb: null,
      providerInstanceImage: null,
      providerInstanceArchitecture: null,
      capacityPlacementSnapshot: harness.snapshot,
      capacityPoolSelection: null,
      reservation,
    };
  }

  async function placeRelease(releaseId: string, options: { requiresVolumes?: boolean } = {}) {
    const requiresVolumes = options.requiresVolumes ?? false;
    // Volume manifests resolve to an exclusive-node reservation, as production stored.
    const reservation = { ...RESERVATION, exclusiveNode: requiresVolumes };
    const nodeId = await placeReleaseOnDeploymentNode({
      db,
      env,
      envId: ENV_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
      releaseId,
      requiresVolumes,
      placement: placement(reservation),
      reservation,
      executionCtx,
    }).catch((error: unknown) => error);
    await drain();
    return nodeId;
  }

  async function drain() {
    while (pending.length > 0) {
      await Promise.allSettled(pending.splice(0));
    }
  }

  function environment() {
    return sqlite
      .prepare(
        `SELECT status, node_id AS nodeId, observed_status AS observedStatus,
                observed_error_message AS observedErrorMessage,
                resolved_reservation_json AS resolvedReservationJson
           FROM deployment_environments WHERE id = ?`
      )
      .get(ENV_ID) as {
      status: string;
      nodeId: string | null;
      observedStatus: string | null;
      observedErrorMessage: string | null;
      resolvedReservationJson: string | null;
    };
  }

  function releaseStatus(id: string) {
    return (
      sqlite.prepare('SELECT status FROM deployment_releases WHERE id = ?').get(id) as {
        status: string;
      }
    ).status;
  }

  function nodeRow(id: string) {
    return sqlite
      .prepare(
        `SELECT status, provider_instance_id AS providerInstanceId, error_message AS errorMessage
           FROM nodes WHERE id = ?`
      )
      .get(id) as
      | { status: string; providerInstanceId: string | null; errorMessage: string | null }
      | undefined;
  }

  function lifecycleApp() {
    const app = new Hono<{ Bindings: Env }>();
    app.onError((error, c) =>
      error instanceof AppError
        ? c.json(error.toJSON(), error.statusCode as never)
        : c.json({ error: error.message }, 500)
    );
    const routes = new Hono<{ Bindings: Env }>();
    registerDeploymentEnvironmentLifecycleRoutes(routes);
    app.route('/api/projects', routes);
    return app;
  }

  async function start() {
    const response = await lifecycleApp().request(
      `/api/projects/${PROJECT_ID}/environments/${ENV_ID}/start`,
      { method: 'POST' },
      env,
      executionCtx
    );
    await drain();
    return response;
  }

  function seedRunningPooledNode(nodeId: string) {
    sqlite
      .prepare(
        `INSERT INTO nodes
           (id, user_id, name, status, health_status, runtime, node_class, node_role,
            workload_role, node_mode, cloud_provider, vm_location, vm_size, provider_instance_id,
            provider_instance_type, provider_instance_vcpu_count, provider_instance_memory_mb,
            provider_instance_disk_gb, capacity_pool_id, capacity_pool_scope,
            capacity_pool_revision, capacity_source_id, capacity_source_generation,
            capacity_pool_candidate_id, placement_credential_source,
            placement_credential_reference, placement_credential_version,
            observed_provider_instance_type, observed_provider_instance_vcpu_count,
            observed_provider_instance_memory_mb, observed_provider_instance_disk_gb,
            observed_hardware_source, last_metrics, last_heartbeat_at, created_at, updated_at)
         VALUES (?, ?, 'deploy-node', 'running', 'healthy', 'vm', 'managed', 'deployment',
                 'deployment', 'shared', 'hetzner', 'fsn1', 'small', ?, 'cx23', 2, 4096, 40, ?,
                 'installation', 7, ?, ?, ?, 'platform', ?, ?, 'cx23', 2, 4096, 40, 'observed', ?,
                 ?, ?, ?)`
      )
      .run(
        nodeId,
        USER_ID,
        `server-${nodeId}`,
        POOL_ID,
        SOURCE_ID,
        version,
        CANDIDATE_ID,
        CREDENTIAL_REFERENCE,
        version,
        JSON.stringify({
          version: 1,
          cpuLoadAvg1: 0.1,
          memoryPercent: 10,
          diskPercent: 10,
          creatingWorkspaces: 0,
        }),
        new Date().toISOString(),
        SEEDED_AT,
        SEEDED_AT
      );
  }

  return {
    sqlite,
    env,
    db,
    placement,
    seedRunningPooledNode,
    insertRelease,
    placeRelease,
    start,
    environment,
    releaseStatus,
    nodeRow,
    drain,
  };
}

/** The production incident: v1 failed placement and left the environment in `error`. */
function erroredEnvironment(seed: Partial<EnvironmentSeed> = {}) {
  const f = fixture({
    status: 'error',
    observedErrorMessage: `Deployment node placement failed: ${HETZNER_412}`,
    ...seed,
  });
  f.insertRelease('release-v1', 1, 'failed');
  f.insertRelease('release-v2', 2, 'created');
  return f;
}

describe('a new release recovers an environment parked in error', () => {
  it.each([
    ['with a persistent volume (the production shape)', true],
    ['without volumes', false],
  ])(
    'provisions a node and moves the environment to starting, %s',
    async (_label, requiresVolumes) => {
      const f = erroredEnvironment({ requiresVolumes });

      const nodeId = await f.placeRelease('release-v2', { requiresVolumes });

      expect(typeof nodeId).toBe('string');
      expect(harness.createVmCalls).toEqual([nodeId]);
      expect(f.nodeRow(nodeId as string)?.status).toBe('running');
      expect(f.environment()).toMatchObject({
        status: 'starting',
        nodeId,
        observedErrorMessage: null,
      });
      // The relocation claim taken for the volume attach was released again.
      expect(f.environment().resolvedReservationJson).not.toContain('samRelocationClaim');
      expect(harness.volumeAttachments).toEqual(requiresVolumes ? [ENV_ID] : []);
      // The node's heartbeat applies it: `starting` is what the heartbeat advertises.
      expect(f.releaseStatus('release-v2')).toBe('created');
      expect(f.releaseStatus('release-v1')).toBe('failed');
    }
  );

  it('returns to error with the new reason when the recovery attempt hits capacity again', async () => {
    const f = erroredEnvironment();
    harness.providerError = Object.assign(new Error(HETZNER_412), { name: 'ProviderError' });

    await f.placeRelease('release-v2');

    expect(harness.createVmCalls).toHaveLength(1);
    expect(f.environment()).toMatchObject({
      status: 'error',
      nodeId: null,
      observedStatus: 'failed',
      observedErrorMessage: `Deployment node placement failed: ${HETZNER_412}`,
    });
    expect(f.releaseStatus('release-v2')).toBe('failed');
  });

  it('keeps an ordinary release on an active environment active', async () => {
    const f = fixture({ status: 'active' });
    f.insertRelease('release-v1', 1, 'created');

    const nodeId = await f.placeRelease('release-v1');

    expect(harness.createVmCalls).toEqual([nodeId]);
    expect(f.environment()).toMatchObject({ status: 'active', nodeId });
  });
});

describe('a fix release for an environment that kept its node', () => {
  // The heartbeat moves `starting` to `error` when an apply fails and keeps the node linked.
  // `reserveExistingNodeForRelease` re-admits the environment through this same write; the
  // pool selection it uses to find the node is covered by the pool suites.
  async function relink(status: string) {
    const stored = JSON.stringify({ ...RESERVATION, cpuMillis: 250 });
    const f = fixture({
      status,
      nodeId: null,
      observedErrorMessage: status === 'error' ? 'Compose up failed: exit status 1' : null,
      resolvedReservationJson: stored,
    });
    f.seedRunningPooledNode('node-running');
    f.sqlite
      .prepare('UPDATE deployment_environments SET node_id = ? WHERE id = ?')
      .run('node-running', ENV_ID);
    f.insertRelease('release-v1', 1, 'failed');
    f.insertRelease('release-v2', 2, 'created');
    const linked = await linkEnvironmentToNode({
      env: f.env,
      db: f.db,
      envId: ENV_ID,
      nodeId: 'node-running',
      placement: f.placement(RESERVATION),
      userId: USER_ID,
      expectedNodeStatus: 'running',
      nodeMode: 'shared',
      expectedReservationJson: stored,
      releaseId: 'release-v2',
    });
    return { f, linked };
  }

  it('moves an error environment to starting so the heartbeat delivers the release', async () => {
    const { f, linked } = await relink('error');

    expect(linked).toBe(true);
    expect(f.environment()).toMatchObject({
      status: 'starting',
      nodeId: 'node-running',
      observedErrorMessage: null,
      resolvedReservationJson: JSON.stringify(RESERVATION),
    });
  });

  it('leaves an active environment active', async () => {
    const { f, linked } = await relink('active');

    expect(linked).toBe(true);
    expect(f.environment()).toMatchObject({ status: 'active', nodeId: 'node-running' });
  });
});

describe('Start provisions a fresh node', () => {
  it.each(['stopped', 'error'])('from %s', async (status) => {
    const f = fixture({
      status,
      observedErrorMessage:
        status === 'error' ? `Deployment node placement failed: ${HETZNER_412}` : null,
      resolvedReservationJson: JSON.stringify(RESERVATION),
    });
    f.insertRelease('release-v1', 1, status === 'error' ? 'failed' : 'applied');

    const response = await f.start();

    expect(response.status, await response.clone().text()).toBe(200);
    expect(harness.createVmCalls).toHaveLength(1);
    const environment = f.environment();
    expect(environment).toMatchObject({ status: 'starting', observedErrorMessage: null });
    expect(environment.nodeId).toBe(harness.createVmCalls[0]);
    expect(f.releaseStatus('release-v1')).toBe('created');
  });
});

describe('environments the Stop and Delete paths own never buy a server', () => {
  it('records a release for a stopped environment without provisioning', async () => {
    const f = fixture({ status: 'stopped' });
    f.insertRelease('release-v1', 1, 'created');

    await f.placeRelease('release-v1');

    expect(harness.authorityAttempts).toBe(0);
    expect(f.environment()).toMatchObject({ status: 'stopped', nodeId: null });
    // Liveness: the placement ran and stored the reservation for the next Start.
    expect(f.environment().resolvedReservationJson).toBe(JSON.stringify(RESERVATION));
    expect(f.releaseStatus('release-v1')).toBe('created');
  });

  it('refuses a deleting environment at the paid boundary and writes no failure', async () => {
    const f = fixture({ status: 'deleting' });
    f.insertRelease('release-v1', 1, 'created');

    await f.placeRelease('release-v1');

    // Liveness: the attempt reached the paid boundary and was refused there.
    expect(harness.authorityAttempts).toBe(1);
    expect(harness.createVmCalls).toEqual([]);
    expect(f.environment()).toMatchObject({ status: 'deleting', nodeId: null });
    expect(f.releaseStatus('release-v1')).toBe('created');
  });
});

describe('the paid boundary accepts the statuses that want a node', () => {
  async function checkAt(status: string) {
    const f = fixture({ status, nodeId: null });
    f.sqlite
      .prepare(
        `INSERT INTO nodes
           (id, user_id, name, status, health_status, runtime, node_class, node_role,
            workload_role, node_mode, cloud_provider, vm_location, vm_size, provider_instance_type)
         VALUES ('node-1', ?, 'deploy-node', 'creating', 'stale', 'vm', 'managed', 'deployment',
                 'deployment', 'shared', 'hetzner', 'fsn1', 'small', 'cx23')`
      )
      .run(USER_ID);
    f.sqlite
      .prepare('UPDATE deployment_environments SET node_id = ? WHERE id = ?')
      .run('node-1', ENV_ID);
    return assertDeploymentProvisioningAuthority(f.env, {
      environmentId: ENV_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
      nodeId: 'node-1',
      provider: 'hetzner',
      location: 'fsn1',
      providerInstanceType: 'cx23',
      providerInstanceBootDiskSizeGb: null,
      providerInstanceImage: null,
      providerInstanceArchitecture: null,
      nodeMode: 'shared',
      requiresVolumes: false,
    });
  }

  it.each(['active', 'starting'])('admits %s', async (status) => {
    await expect(checkAt(status)).resolves.toBeUndefined();
  });

  it.each(['error', 'stopping', 'stopped', 'deleting'])('refuses %s', async (status) => {
    await expect(checkAt(status)).rejects.toThrow(
      'Deployment provisioning authority is no longer current'
    );
  });
});

describe('a placement blocked for a reason nothing else will resolve is shown to the user', () => {
  it.each([
    ['active', 'release-v1'],
    ['error', 'release-v2'],
  ])(
    'marks the release failed and the %s environment errored with the reason',
    async (status, releaseId) => {
      const f = status === 'error' ? erroredEnvironment() : fixture({ status: 'active' });
      if (status === 'active') f.insertRelease('release-v1', 1, 'created');
      // The user loses deploy access while the server is being placed.
      harness.beforeAuthority = () => {
        f.sqlite.prepare(`UPDATE project_members SET status = 'removed'`).run();
      };

      await f.placeRelease(releaseId);

      expect(harness.authorityAttempts).toBe(1);
      expect(harness.createVmCalls).toEqual([]);
      expect(f.releaseStatus(releaseId)).toBe('failed');
      expect(f.environment()).toMatchObject({
        status: 'error',
        nodeId: null,
        observedStatus: 'failed',
        observedErrorMessage:
          'Deployment node placement stopped before a server was created: ' +
          'Deployment provisioning authority is no longer current. Deploy again to retry.',
      });
    }
  );

  it('leaves a superseded release to the newer one', async () => {
    const f = fixture({ status: 'active' });
    f.insertRelease('release-v1', 1, 'created');
    harness.beforeAuthority = () => f.insertRelease('release-v2', 2, 'created');

    await f.placeRelease('release-v1');

    expect(harness.authorityAttempts).toBe(1);
    expect(harness.createVmCalls).toEqual([]);
    expect(f.releaseStatus('release-v1')).toBe('created');
    expect(f.environment()).toMatchObject({ status: 'active', observedErrorMessage: null });
  });

  it('leaves an environment the user is stopping to the Stop path', async () => {
    const f = fixture({ status: 'active' });
    f.insertRelease('release-v1', 1, 'created');
    harness.beforeAuthority = () => {
      f.sqlite.prepare(`UPDATE deployment_environments SET status = 'stopping'`).run();
    };

    await f.placeRelease('release-v1');

    expect(harness.authorityAttempts).toBe(1);
    expect(harness.createVmCalls).toEqual([]);
    expect(f.releaseStatus('release-v1')).toBe('created');
    expect(f.environment()).toMatchObject({ status: 'stopping', nodeId: null });
  });
});

describe('recordStrandedDeploymentReleasePlacement', () => {
  const blocked = new Error('Deployment provisioning authority is no longer current');

  it('marks the newest created release of an environment with no node', async () => {
    const f = fixture({ status: 'starting' });
    f.insertRelease('release-v1', 1, 'created');

    await expect(
      recordStrandedDeploymentReleasePlacement(f.env, ENV_ID, 'release-v1', blocked)
    ).resolves.toBe(true);
    expect(f.releaseStatus('release-v1')).toBe('failed');
    expect(f.environment().status).toBe('error');
  });

  it.each<[string, (f: ReturnType<typeof fixture>) => void]>([
    ['a newer release exists', (f) => f.insertRelease('release-v2', 2, 'created')],
    [
      'the environment is stopped',
      (f) => f.sqlite.prepare(`UPDATE deployment_environments SET status = 'stopped'`).run(),
    ],
    [
      'the environment is being deleted',
      (f) => f.sqlite.prepare(`UPDATE deployment_environments SET status = 'deleting'`).run(),
    ],
    [
      'a node is linked',
      (f) => {
        f.sqlite
          .prepare(
            `INSERT INTO nodes (id, user_id, name, status, vm_size, vm_location)
             VALUES ('node-1', ?, 'other', 'running', 'small', 'fsn1')`
          )
          .run(USER_ID);
        f.sqlite.prepare(`UPDATE deployment_environments SET node_id = 'node-1'`).run();
      },
    ],
    [
      'a relocation claim is in flight',
      (f) =>
        f.sqlite
          .prepare('UPDATE deployment_environments SET resolved_reservation_json = ?')
          .run(JSON.stringify({ ...RESERVATION, samRelocationClaim: true })),
    ],
    [
      'the release already moved on',
      (f) => f.sqlite.prepare(`UPDATE deployment_releases SET status = 'applying'`).run(),
    ],
  ])('writes nothing when %s', async (_label, arrange) => {
    const f = fixture({ status: 'active' });
    f.insertRelease('release-v1', 1, 'created');
    arrange(f);
    const before = { environment: f.environment(), release: f.releaseStatus('release-v1') };

    await expect(
      recordStrandedDeploymentReleasePlacement(f.env, ENV_ID, 'release-v1', blocked)
    ).resolves.toBe(false);
    expect(f.environment()).toEqual(before.environment);
    expect(f.releaseStatus('release-v1')).toBe(before.release);
  });
});
