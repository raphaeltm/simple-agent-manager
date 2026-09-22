/**
 * Regression suite for legacy (pre-node-pool) deployment node adoption.
 *
 * Incident (production, 2026-09-21): PR #2114 routed every release for an
 * environment already linked to a deployment node through
 * `findDeploymentNodeWithCapacity` + `linkEnvironmentToNode`, which require a
 * pooled `capacity_pool_id` and trusted `observed_hardware_source = 'observed'`
 * hardware. Deployment nodes created before the node-pool system have every one
 * of those columns NULL, so environment 01M100A361P49T716X6QBV2NV5 (project
 * APEX, node 01M1015FQ9D772EF6HHB5AGZ0Z) failed release v15 with
 * "Existing exclusive deployment node cannot admit the declared resource
 * reservation" and was flipped to status='error', which made the next heartbeat
 * tear down the RUNNING v14.
 *
 * Every predicate under test is a SQL `WHERE` clause, so these tests drive the
 * real statement against a real SQL engine (`.claude/rules/28` §5): a mock whose
 * `.where()` ignores its arguments would pass with the guard deleted. The
 * headline adoption case and the placement-failure cases enter through
 * `placeReleaseOnDeploymentNode`, the way the release route does
 * (`.claude/rules/62`).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { placeReleaseOnDeploymentNode } from '../../../src/routes/deployment-release-placement';
import { linkEnvironmentToLegacyNode } from '../../../src/services/deployment-legacy-node-admission';
import type { DeploymentPlacement } from '../../../src/services/deployment-provisioning';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mockProvisionDeploymentNode = vi.hoisted(() => vi.fn());
const logInfo = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/logger')>();
  return { ...actual, log: { ...actual.log, info: logInfo } };
});
const loggedEvents = () => logInfo.mock.calls.map(([event]) => event);

vi.mock('../../../src/services/deployment-provisioning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/deployment-provisioning')>()),
  provisionDeploymentNode: (...args: unknown[]) => mockProvisionDeploymentNode(...args),
}));

const USER_ID = '4bw1FJlXCOgSGq0TsQgpiMAhQKjGOSXx';
const OTHER_USER_ID = 'some-other-user';
const PROJECT_ID = 'project-apex';
const ENV_ID = '01M100A361P49T716X6QBV2NV5';
const NODE_ID = '01M1015FQ9D772EF6HHB5AGZ0Z';
const OTHER_NODE_ID = '01KXAR1T3XCQKKPBEJEERQ2PSZ';
const RELEASE_V14 = '01M2PKNZXH32QM324BD7KTR0KS';
const RELEASE_V15 = '01M32DYXWVG1Y5W57X5EB9Z2SM';
const PLACEMENT_FAILURE_MESSAGE =
  'Deployment node placement failed: Existing exclusive deployment node cannot admit the declared resource reservation';

const RESERVATION = {
  version: 3 as const,
  cpuMillis: 250,
  memoryMb: 256,
  diskMb: 1024,
  exclusiveNode: true,
  source: 'task' as const,
  sourceId: ENV_ID,
  diagnostics: ['deployment-manifest-reservation:v1'],
};

/**
 * A node that capacity-aware admission still refuses (its native identity no
 * longer matches the placement) and that legacy adoption must never touch.
 */
const NON_LEGACY_NODE = {
  observed_hardware_source: 'observed',
  provider_instance_type: 'cx22',
};

let sqlite: Database.Database;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE: createSqliteD1(sqlite),
    ...overrides,
  } as Env;
}

function db() {
  return drizzle(createSqliteD1(sqlite), { schema });
}

/** Seed the exact production shape of a pre-node-pool deployment node. */
function seedLegacyNode(overrides: Record<string, unknown> = {}): void {
  const row = {
    id: NODE_ID,
    user_id: USER_ID,
    status: 'running',
    health_status: 'healthy',
    node_role: 'deployment',
    node_mode: 'exclusive',
    node_class: 'managed',
    runtime: 'vm',
    cloud_provider: 'hetzner',
    vm_location: 'fsn1',
    vm_size: 'small',
    provider_instance_id: '163715232',
    // Every pool/hardware column is NULL on a pre-node-pool node.
    capacity_pool_id: null,
    workload_role: null,
    provider_instance_type: null,
    observed_hardware_source: null,
    ...overrides,
  };
  const columns = Object.keys(row);
  sqlite
    .prepare(
      `INSERT INTO nodes (${columns.map((c) => `"${c}"`).join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...columns.map((c) => (row as Record<string, unknown>)[c] as never));
}

function seedEnvironment(overrides: Record<string, unknown> = {}): void {
  const row = {
    id: ENV_ID,
    project_id: PROJECT_ID,
    name: 'production',
    status: 'error',
    node_id: NODE_ID,
    requires_volumes: 1,
    // Legacy environments never had a resolved reservation persisted.
    resolved_reservation_json: null,
    observed_status: 'failed',
    observed_error_message: PLACEMENT_FAILURE_MESSAGE,
    provider: 'hetzner',
    location: 'fsn1',
    created_at: '2026-09-04T00:00:00.000Z',
    updated_at: '2026-09-21T16:49:35.000Z',
    ...overrides,
  };
  const columns = Object.keys(row);
  sqlite
    .prepare(
      `INSERT INTO deployment_environments (${columns.map((c) => `"${c}"`).join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...columns.map((c) => (row as Record<string, unknown>)[c] as never));
}

function seedRelease(id: string, version: number, status: string, environmentId = ENV_ID): void {
  sqlite
    .prepare(
      `INSERT INTO deployment_releases (id, environment_id, manifest, version, status, created_by, created_at)
       VALUES (?, ?, '{}', ?, ?, ?, ?)`
    )
    .run(id, environmentId, version, status, USER_ID, `2026-09-2${version % 10}T00:00:00.000Z`);
}

function readEnvironment(id = ENV_ID) {
  return sqlite
    .prepare(
      `SELECT status, node_id AS nodeId, resolved_reservation_json AS reservationJson,
              observed_status AS observedStatus, observed_error_message AS observedErrorMessage,
              updated_at AS updatedAt
         FROM deployment_environments WHERE id = ?`
    )
    .get(id) as {
    status: string;
    nodeId: string | null;
    reservationJson: string | null;
    observedStatus: string | null;
    observedErrorMessage: string | null;
    updatedAt: string;
  };
}

function readRelease(id: string) {
  return sqlite.prepare(`SELECT status FROM deployment_releases WHERE id = ?`).get(id) as {
    status: string;
  };
}

function adopt(overrides: Partial<Parameters<typeof linkEnvironmentToLegacyNode>[0]> = {}) {
  return linkEnvironmentToLegacyNode({
    env: makeEnv(),
    envId: ENV_ID,
    nodeId: NODE_ID,
    userId: USER_ID,
    releaseId: RELEASE_V15,
    requiresVolumes: true,
    reservation: RESERVATION,
    expectedReservationJson: null,
    ...overrides,
  });
}

/** Placement the deployment resolver produces today: a concrete pooled offering. */
function placement(): DeploymentPlacement {
  return {
    projectId: PROJECT_ID,
    provider: 'hetzner',
    location: 'fsn1',
    vmSize: 'small',
    credentialSource: 'user',
    credentialAttributionUserId: USER_ID,
    credentialAttributionProjectId: null,
    placementCredentialSource: 'user',
    placementCredentialReference: 'cred-1',
    placementCredentialVersion: 1,
    providerInstanceType: 'cx22',
    providerInstanceBootDiskSizeGb: 40,
    providerInstanceImage: 'ubuntu-24.04',
    providerInstanceArchitecture: 'x86',
    capacityPlacementSnapshot: null,
    capacityPoolSelection: null,
    reservation: RESERVATION,
  } as DeploymentPlacement;
}

function placeRelease(overrides: Record<string, unknown> = {}) {
  return placeReleaseOnDeploymentNode({
    db: db(),
    env: makeEnv(),
    envId: ENV_ID,
    projectId: PROJECT_ID,
    userId: USER_ID,
    releaseId: RELEASE_V15,
    requiresVolumes: true,
    placement: placement(),
    reservation: RESERVATION,
    ...overrides,
  } as Parameters<typeof placeReleaseOnDeploymentNode>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  mockProvisionDeploymentNode.mockResolvedValue(null);
});

describe('linkEnvironmentToLegacyNode — owner path', () => {
  beforeEach(() => {
    seedLegacyNode();
    seedEnvironment();
    seedRelease(RELEASE_V14, 14, 'applied');
    seedRelease(RELEASE_V15, 15, 'created');
  });

  it('adopts the legacy node the environment already runs on and unblocks release delivery', async () => {
    await expect(adopt()).resolves.toBe(true);

    const row = readEnvironment();
    expect(row.reservationJson).toBe(JSON.stringify(RESERVATION));
    // 'starting' is what lets the heartbeat advertise pendingReleases again.
    expect(row.status).toBe('starting');
    expect(row.observedErrorMessage).toBeNull();
    expect(row.nodeId).toBe(NODE_ID);
  });

  it('adopts through the real release placement entry point', async () => {
    const nodeId = await placeRelease();

    expect(nodeId).toBe(NODE_ID);
    const row = readEnvironment();
    expect(row.status).toBe('starting');
    expect(row.reservationJson).toBe(JSON.stringify(RESERVATION));
    expect(row.observedErrorMessage).toBeNull();
    // The placement never fell through to the failure path.
    expect(readRelease(RELEASE_V15).status).toBe('created');
    expect(mockProvisionDeploymentNode).not.toHaveBeenCalled();
    // The volumes are already attached to the node's provider instance; the
    // attach step is skipped rather than attempted with an unobtainable claim.
    expect(loggedEvents()).toContain('deployment_release.legacy_node_volume_attach_skipped');
  });

  it('leaves an active environment active (only error flips)', async () => {
    sqlite.prepare(`UPDATE deployment_environments SET status = 'active' WHERE id = ?`).run(ENV_ID);

    await expect(adopt()).resolves.toBe(true);

    const row = readEnvironment();
    expect(row.status).toBe('active');
    expect(row.reservationJson).toBe(JSON.stringify(RESERVATION));
    // Liveness: the write did happen, it just did not touch status.
    expect(row.updatedAt).not.toBe('2026-09-21T16:49:35.000Z');
  });

  it('adopts a shared legacy node for a release that does not require volumes', async () => {
    sqlite.prepare(`UPDATE nodes SET node_mode = 'shared' WHERE id = ?`).run(NODE_ID);
    sqlite
      .prepare(`UPDATE deployment_environments SET requires_volumes = 0 WHERE id = ?`)
      .run(ENV_ID);

    await expect(
      adopt({
        requiresVolumes: false,
        reservation: { ...RESERVATION, exclusiveNode: false },
      })
    ).resolves.toBe(true);
    expect(readEnvironment().status).toBe('starting');
  });
});

describe('linkEnvironmentToLegacyNode — refusals', () => {
  beforeEach(() => {
    seedLegacyNode();
    seedEnvironment();
    seedRelease(RELEASE_V14, 14, 'applied');
    seedRelease(RELEASE_V15, 15, 'created');
  });

  /** Every case must refuse AND leave the row byte-identical. */
  async function expectRefusedAndUntouched(
    run: () => Promise<boolean>,
    expected = readEnvironment()
  ) {
    await expect(run()).resolves.toBe(false);
    expect(readEnvironment()).toEqual(expected);
  }

  it('refuses a pooled node (capacity_pool_id set)', async () => {
    sqlite.prepare(`UPDATE nodes SET capacity_pool_id = 'pool-1' WHERE id = ?`).run(NODE_ID);
    await expectRefusedAndUntouched(() => adopt());
  });

  it('refuses a node carrying trusted observed hardware', async () => {
    sqlite
      .prepare(`UPDATE nodes SET observed_hardware_source = 'observed' WHERE id = ?`)
      .run(NODE_ID);
    await expectRefusedAndUntouched(() => adopt());
  });

  it('refuses a node carrying a concrete provider_instance_type', async () => {
    sqlite.prepare(`UPDATE nodes SET provider_instance_type = 'cx22' WHERE id = ?`).run(NODE_ID);
    await expectRefusedAndUntouched(() => adopt());
  });

  it('refuses a node the environment is not linked to', async () => {
    seedLegacyNode({ id: OTHER_NODE_ID });
    await expectRefusedAndUntouched(() => adopt({ nodeId: OTHER_NODE_ID }));
  });

  it('refuses when a second environment occupies the exclusive node', async () => {
    seedEnvironment({
      id: 'env-co-tenant',
      name: 'staging',
      status: 'active',
      observed_status: null,
      observed_error_message: null,
    });
    const expected = readEnvironment();
    await expect(adopt()).resolves.toBe(false);
    expect(readEnvironment()).toEqual(expected);
  });

  it('refuses a stale (non-latest) releaseId', async () => {
    await expectRefusedAndUntouched(() => adopt({ releaseId: RELEASE_V14 }));
  });

  it('refuses an expectedReservationJson mismatch', async () => {
    await expectRefusedAndUntouched(() =>
      adopt({ expectedReservationJson: JSON.stringify(RESERVATION) })
    );
  });

  it('refuses a node that is not running', async () => {
    sqlite.prepare(`UPDATE nodes SET status = 'stopped' WHERE id = ?`).run(NODE_ID);
    await expectRefusedAndUntouched(() => adopt());
  });

  it('refuses an unhealthy node', async () => {
    sqlite.prepare(`UPDATE nodes SET health_status = 'unhealthy' WHERE id = ?`).run(NODE_ID);
    await expectRefusedAndUntouched(() => adopt());
  });

  it('refuses a node owned by another user', async () => {
    await expectRefusedAndUntouched(() => adopt({ userId: OTHER_USER_ID }));
  });

  it('refuses a shared-mode node when the release requires volumes', async () => {
    sqlite.prepare(`UPDATE nodes SET node_mode = 'shared' WHERE id = ?`).run(NODE_ID);
    await expectRefusedAndUntouched(() => adopt());
  });

  it('refuses a node whose role is not deployment', async () => {
    sqlite.prepare(`UPDATE nodes SET node_role = 'workspace' WHERE id = ?`).run(NODE_ID);
    await expectRefusedAndUntouched(() => adopt());
  });

  it('refuses while a relocation claim fences the environment', async () => {
    const claimJson = JSON.stringify({ ...RESERVATION, samRelocationClaim: true });
    sqlite
      .prepare(`UPDATE deployment_environments SET resolved_reservation_json = ? WHERE id = ?`)
      .run(claimJson, ENV_ID);
    await expectRefusedAndUntouched(() => adopt({ expectedReservationJson: claimJson }));
  });

  it('refuses when the D1 binding cannot prepare statements', async () => {
    await expect(adopt({ env: { DATABASE: {} } as unknown as Env })).resolves.toBe(false);
  });
});

describe('markDeploymentReleasePlacementFailed — a failed placement must not retire a running app', () => {
  it('leaves status untouched while a release is still applied on the node', async () => {
    // A non-legacy node whose native identity no longer matches the placement:
    // capacity-aware admission refuses it, and legacy adoption refuses it twice
    // over (trusted observed hardware + a concrete instance type), so this
    // fixture stays valid independently of any single legacy predicate.
    seedLegacyNode(NON_LEGACY_NODE);
    seedEnvironment({ status: 'active', observed_status: 'applied', observed_error_message: null });
    seedRelease(RELEASE_V14, 14, 'applied');
    seedRelease(RELEASE_V15, 15, 'created');

    const nodeId = await placeRelease();

    expect(nodeId).toBeNull();
    const row = readEnvironment();
    // status='error' is what makes the next heartbeat tear the running app down.
    expect(row.status).toBe('active');
    expect(row.nodeId).toBe(NODE_ID);
    expect(readRelease(RELEASE_V15).status).toBe('failed');
    expect(row.observedStatus).toBe('failed');
    expect(row.observedErrorMessage).toBe(PLACEMENT_FAILURE_MESSAGE);
    // The already-applied release is untouched.
    expect(readRelease(RELEASE_V14).status).toBe('applied');
  });

  it('still flips to error when the environment has no applied release', async () => {
    seedLegacyNode(NON_LEGACY_NODE);
    seedEnvironment({ status: 'active', observed_status: null, observed_error_message: null });
    seedRelease(RELEASE_V14, 14, 'failed');
    seedRelease(RELEASE_V15, 15, 'created');

    const nodeId = await placeRelease();

    expect(nodeId).toBeNull();
    const row = readEnvironment();
    expect(row.status).toBe('error');
    expect(row.observedErrorMessage).toBe(PLACEMENT_FAILURE_MESSAGE);
    expect(readRelease(RELEASE_V15).status).toBe('failed');
  });

  it('still flips to error when the environment has no node', async () => {
    seedEnvironment({ status: 'active', node_id: null, observed_error_message: null });
    seedRelease(RELEASE_V14, 14, 'applied');
    seedRelease(RELEASE_V15, 15, 'created');

    const nodeId = await placeRelease();

    expect(nodeId).toBeNull();
    const row = readEnvironment();
    expect(row.status).toBe('error');
    expect(row.observedErrorMessage).toBe(
      'Deployment node placement failed: No deployment node could be provisioned'
    );
    expect(readRelease(RELEASE_V15).status).toBe('failed');
  });
});
