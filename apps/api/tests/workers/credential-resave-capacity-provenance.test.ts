/**
 * A cloud credential re-save must not matter to compute pools or node cleanup
 * (idea 01M76T4XXVQS1TX8VQM2BRPWFG, task 01M7BNEQ5MYA2NCG54EFHHMT7P).
 *
 * The staging incident (2026-11-12): re-saving a GCP connection deleted the `credentials` row
 * and inserted a new one. `capacity_sources.credential_id` cascades from that row, the pool's
 * candidates cascade from the source, and `nodes.capacity_source_id` is `ON DELETE SET NULL`.
 * So the person's machine choices were deleted (GCP unplaceable) and every node placed before
 * the save lost the column the cleanup provenance predicate required (never reaped).
 *
 * Real: the full D1 migration chain with its foreign keys, the credential save/delete routes
 * (only the browser session is substituted), default-pool reconciliation, the pool editor
 * service, task-start placement selection, the node-cleanup cron and the warm handoff (with its
 * NodeLifecycle Durable Object). Faked: outbound HTTP (cloud APIs) and the provider catalog,
 * which is the cloud's network boundary.
 */
import {
  capacityPlacementSnapshotForCandidate,
  resolveReusableNodeCapacitySnapshot,
} from '@simple-agent-manager/scheduler-core';
import {
  type CapacityPoolScope,
  type CredentialProvider,
  DEFAULT_GCP_COMPUTE_API_BASE_URL,
  DEFAULT_GCP_SERVICE_ACCOUNT_TOKEN_URL,
} from '@simple-agent-manager/shared';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { adminPlatformCredentialRoutes } from '../../src/routes/admin-platform-credentials';
import { credentialsRoutes } from '../../src/routes/credentials';
import { gcpRoutes } from '../../src/routes/gcp';
import { projectCredentialsRoutes } from '../../src/routes/projects/credentials';
import { runNodeCleanupSweep } from '../../src/scheduled/node-cleanup';
import { claimNodeForCleanup } from '../../src/scheduled/node-cleanup/shared';
import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS,
  capacityPlacementSnapshotSqlValues,
} from '../../src/services/capacity-placement-snapshot';
import { updateDefaultCapacityPool } from '../../src/services/default-capacity-pool-updates';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../src/services/default-capacity-pools';
import { handOffEmptyWorkspaceNode } from '../../src/services/node-warm-handoff';
import {
  resolveTaskStartCapacityPoolSelection,
  resolveTaskStartPlacement,
} from '../../src/services/placement-resolver';
import { getStaticProviderCatalogOfferings } from '../../src/services/provider-catalogs';
import { deleteNodeResourcesStrict } from '../../src/services/strict-node-deletion';
import { seedInstallation, seedNode, seedProject, seedUser } from './helpers/seed-d1';

const workerEnv = env as unknown as Env;
const db = drizzle(env.DATABASE, { schema });
const DAY = 24 * 60 * 60 * 1000;

let prefix = '';
let ownerId = '';
let otherUserId = '';

beforeEach(async () => {
  prefix = `resave-${crypto.randomUUID().slice(0, 8)}`;
  ownerId = `${prefix}-owner`;
  otherUserId = `${prefix}-other`;
  await seedUser(ownerId);
  await seedUser(otherUserId);
  // Cloud APIs are the network boundary: every catalog refresh, token exchange, validation and
  // provider delete fails, so nothing here depends on a live cloud.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('cloud api unavailable in tests', { status: 503 }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The worker app with only the browser session substituted; route middleware is real. */
function appFor(userId: string, role: 'user' | 'superadmin' = 'user') {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('auth', {
      user: {
        id: userId,
        email: `${userId}@example.com`,
        name: null,
        avatarUrl: null,
        role,
        status: 'active',
      },
      session: { id: null, token: null, expiresAt: new Date(Date.now() + 60_000) },
    });
    await next();
  });
  app.route('/api/credentials', credentialsRoutes);
  app.route('/api/gcp', gcpRoutes);
  app.route('/api/projects', projectCredentialsRoutes);
  app.route('/api/admin/platform-credentials', adminPlatformCredentialRoutes);
  return app;
}

async function request(
  userId: string,
  method: string,
  path: string,
  body?: unknown,
  role: 'user' | 'superadmin' = 'user'
): Promise<Response> {
  return appFor(userId, role).request(
    path,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    workerEnv
  );
}

const GCP_CONNECTION = {
  provider: 'gcp',
  gcpProjectId: 'sam-staging-infra',
  gcpProjectNumber: '353771248703',
  serviceAccountEmail: 'sam-vm-manager@sam-staging-infra.iam.gserviceaccount.com',
  wifPoolId: 'sam-pool',
  wifProviderId: 'sam-oidc',
  defaultZone: 'europe-west1-b',
};

/** Reconcile the default pools the way the scheduled backfill does, with a complete catalog. */
async function reconcile(scope: { userId?: string; projectId?: string; installation?: boolean }) {
  await ensureDefaultCapacityPoolsForExistingCredentials(db, {
    userId: scope.userId ?? null,
    projectId: scope.projectId ?? null,
    includeInstallation: scope.installation === true,
    offeringResolver: (seed) => ({
      offerings: getStaticProviderCatalogOfferings(seed.provider),
      refreshSucceeded: true,
      catalogComplete: true,
    }),
  });
}

async function defaultPool(
  scope: CapacityPoolScope,
  ownerUserId: string | null,
  projectId: string | null
) {
  const id =
    scope === 'installation'
      ? 'cap-pool-default:installation'
      : scope === 'user'
        ? `cap-pool-default:user:${ownerUserId}`
        : `cap-pool-default:project:${projectId}`;
  return env.DATABASE.prepare(
    `SELECT id, revision, source_order_json AS sourceOrderJson FROM capacity_pools WHERE id = ?`
  )
    .bind(id)
    .first<{ id: string; revision: number; sourceOrderJson: string | null }>();
}

/** The person's choices: switch on every offering of the provider and rank it first. */
async function pickProvider(input: {
  scope: CapacityPoolScope;
  ownerUserId: string | null;
  ownerProjectId: string | null;
  provider: CredentialProvider;
}): Promise<{ sourceId: string; activeCandidateIds: string[] }> {
  const pool = await defaultPool(input.scope, input.ownerUserId, input.ownerProjectId);
  expect(pool).not.toBeNull();
  const rows = await env.DATABASE.prepare(
    `SELECT c.id, c.capacity_source_id AS sourceId
       FROM capacity_pool_candidates c
       JOIN capacity_sources s ON s.id = c.capacity_source_id
      WHERE c.pool_id = ? AND s.provider = ? AND s.status = 'active'
        AND c.workload_role = 'workspace'
      ORDER BY c.id`
  )
    .bind(pool!.id, input.provider)
    .all<{ id: string; sourceId: string }>();
  expect(rows.results.length).toBeGreaterThan(0);
  const sourceId = rows.results[0]!.sourceId;
  const result = await updateDefaultCapacityPool(db, {
    scope: input.scope,
    ownerUserId: input.ownerUserId,
    ownerProjectId: input.ownerProjectId,
    candidates: rows.results.map((row) => ({ id: row.id, status: 'active' as const })),
    sourceOrder: [sourceId],
  });
  expect(result.conflict).toBe(false);
  expect(result.missingCandidateIds).toEqual([]);
  return { sourceId, activeCandidateIds: await activeCandidateIds(pool!.id, sourceId) };
}

async function activeCandidateIds(poolId: string, sourceId: string): Promise<string[]> {
  const rows = await env.DATABASE.prepare(
    `SELECT id FROM capacity_pool_candidates
      WHERE pool_id = ? AND capacity_source_id = ? AND status = 'active' ORDER BY id`
  )
    .bind(poolId, sourceId)
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

/** Task-start placement exactly as the TaskRunner asks for it. */
async function placementSelection(userId: string, projectId: string | null) {
  const selection = await resolveTaskStartCapacityPoolSelection(
    db as never,
    resolveTaskStartPlacement({
      entryPoint: 'direct-workspace',
      taskId: `${prefix}-task`,
      projectId: projectId ?? '',
      userId,
      project: { id: projectId ?? '', defaultProvider: null, defaultVmSize: 'small' },
      credentialProjectPolicy: 'current-project',
      taskModeDefault: 'task',
      resourceRequirements: {},
    }),
    { ensure: false, failOpen: false, env: workerEnv }
  );
  expect(selection).not.toBeNull();
  return selection!;
}

/** Place a node from the first eligible candidate, writing the snapshot provisioning writes. */
async function placeNode(
  nodeId: string,
  userId: string,
  projectId: string | null,
  status: 'running' | 'stopped' = 'running'
) {
  const selection = await placementSelection(userId, projectId);
  const candidate = selection.candidates[0];
  expect(candidate).toBeDefined();
  const snapshot = capacityPlacementSnapshotForCandidate(selection, candidate!);
  expect(snapshot.capacitySourceId).toBeTruthy();
  const createdAt = new Date(Date.now() - 2 * DAY).toISOString();
  await seedNode(nodeId, userId, {
    status,
    vmSize: candidate!.machineSize ?? 'medium',
    createdAt,
    updatedAt: createdAt,
    lastHeartbeatAt: new Date().toISOString(),
  });
  await env.DATABASE.prepare(
    `UPDATE nodes SET ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS},
       runtime = 'vm', node_role = 'workspace', node_class = 'managed',
       cloud_provider = ?, provider_instance_id = ?, runtime_incarnation_id = ?,
       placement_credential_fingerprint = ?
     WHERE id = ?`
  )
    .bind(
      ...capacityPlacementSnapshotSqlValues(snapshot),
      candidate!.provider,
      `${nodeId}-instance`,
      `${nodeId}-incarnation`,
      `${nodeId}-fingerprint`,
      nodeId
    )
    .run();
  return { snapshot, candidate: candidate! };
}

async function readNode(nodeId: string) {
  return env.DATABASE.prepare(
    `SELECT status, capacity_source_id AS capacitySourceId,
            capacity_pool_candidate_id AS capacityPoolCandidateId,
            cleanup_blocked_reason AS cleanupBlockedReason,
            cleanup_backoff_until AS cleanupBackoffUntil
       FROM nodes WHERE id = ?`
  )
    .bind(nodeId)
    .first<{
      status: string;
      capacitySourceId: string | null;
      capacityPoolCandidateId: string | null;
      cleanupBlockedReason: string | null;
      cleanupBackoffUntil: string | null;
    }>();
}

/** The node row the TaskRunner's reuse query reads. */
async function reuseRow(nodeId: string) {
  const row = await env.DATABASE.prepare(
    `SELECT vm_size AS vmSize, vm_location AS vmLocation, cloud_provider AS cloudProvider,
            capacity_pool_id AS capacityPoolId, capacity_pool_scope AS capacityPoolScope,
            capacity_pool_revision AS capacityPoolRevision,
            capacity_source_id AS capacitySourceId,
            capacity_source_generation AS capacitySourceGeneration,
            capacity_pool_candidate_id AS capacityPoolCandidateId,
            placement_credential_source AS placementCredentialSource,
            placement_credential_reference AS placementCredentialReference,
            placement_credential_version AS placementCredentialVersion,
            capacity_pool_project_id AS capacityPoolProjectId, workload_role AS workloadRole,
            provider_instance_type AS providerInstanceType,
            provider_instance_vcpu_count AS providerInstanceVcpuCount,
            provider_instance_memory_mb AS providerInstanceMemoryMb
       FROM nodes WHERE id = ?`
  )
    .bind(nodeId)
    .first<Parameters<typeof resolveReusableNodeCapacitySnapshot>[0]['node']>();
  expect(row).not.toBeNull();
  return row!;
}

async function userGcpCredentialId(userId: string): Promise<string> {
  const row = await env.DATABASE.prepare(
    `SELECT id FROM credentials WHERE user_id = ? AND project_id IS NULL
       AND provider = 'gcp' AND credential_type = 'cloud-provider'`
  )
    .bind(userId)
    .all<{ id: string }>();
  expect(row.results).toHaveLength(1);
  return row.results[0]!.id;
}

function claim(nodeId: string, userId: string, status: string, allowRunning = false) {
  return claimNodeForCleanup(
    workerEnv,
    { id: nodeId, user_id: userId, status },
    new Date().toISOString(),
    { allowManagedRunningProvenance: allowRunning, requireWorkspaceIdle: false }
  );
}

describe('a GCP connection re-saved through the product', () => {
  it('keeps the connection, its pool choices and its order, so GCP stays placeable', async () => {
    const saved = await request(ownerId, 'POST', '/api/credentials', GCP_CONNECTION);
    expect(saved.status).toBe(201);
    await reconcile({ userId: ownerId });
    const credentialId = await userGcpCredentialId(ownerId);
    const picked = await pickProvider({
      scope: 'user',
      ownerUserId: ownerId,
      ownerProjectId: null,
      provider: 'gcp',
    });
    expect(picked.sourceId).toBe(`cap-source-default:user:${credentialId}`);

    const resaved = await request(ownerId, 'POST', '/api/credentials', GCP_CONNECTION);
    expect(resaved.status).toBe(200);
    expect(((await resaved.json()) as { id: string }).id).toBe(credentialId);
    await reconcile({ userId: ownerId });

    expect(await userGcpCredentialId(ownerId)).toBe(credentialId);
    const pool = await defaultPool('user', ownerId, null);
    expect(JSON.parse(pool!.sourceOrderJson!)).toEqual([picked.sourceId]);
    expect(await activeCandidateIds(pool!.id, picked.sourceId)).toEqual(picked.activeCandidateIds);

    const selection = await placementSelection(ownerId, null);
    expect(selection.candidates.length).toBeGreaterThan(0);
    expect(selection.candidates[0]!.capacitySourceId).toBe(picked.sourceId);
    expect(selection.candidates[0]!.provider).toBe('gcp');
  });

  it('leaves nodes placed before the save reapable by the cron and the warm handoff', async () => {
    expect((await request(ownerId, 'POST', '/api/credentials', GCP_CONNECTION)).status).toBe(201);
    await reconcile({ userId: ownerId });
    await pickProvider({
      scope: 'user',
      ownerUserId: ownerId,
      ownerProjectId: null,
      provider: 'gcp',
    });
    const stoppedNode = `${prefix}-stopped`;
    const runningNode = `${prefix}-running`;
    const placed = await placeNode(stoppedNode, ownerId, null, 'stopped');
    await placeNode(runningNode, ownerId, null, 'running');

    expect((await request(ownerId, 'POST', '/api/credentials', GCP_CONNECTION)).status).toBe(200);
    await reconcile({ userId: ownerId });

    // The column the cleanup predicate reads survives the save.
    expect((await readNode(stoppedNode))?.capacitySourceId).toBe(placed.snapshot.capacitySourceId);

    // Warm handoff (every removal path) admits the running node.
    const handoff = await handOffEmptyWorkspaceNode(workerEnv, {
      nodeId: runningNode,
      reason: 'credential_resave_test',
      expectedUserId: ownerId,
    });
    expect(handoff).toEqual({ outcome: 'handed_to_warm' });

    // The cron selects and claims the stopped node. Its GCP delete then fails at the faked
    // network boundary and the failure backoff is written; only a claimed candidate gets one.
    // A node the provenance predicate refuses is never selected and is left untouched.
    expect((await readNode(stoppedNode))?.cleanupBackoffUntil).toBeNull();
    await runNodeCleanupSweep(workerEnv);
    const after = await readNode(stoppedNode);
    expect(after?.cleanupBackoffUntil).not.toBeNull();
    expect(after?.cleanupBlockedReason ?? '').not.toContain('provenance');
  });
});

describe('a GCP service-account key rotated through PUT /api/gcp/service-account', () => {
  it('keeps the source and its choices and moves its credential version to the new key', async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    const privateKey = await exportPKCS8(pair.privateKey);
    // Google is the network boundary: token exchange and the zone check succeed, everything
    // else (catalog refresh) is unavailable.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === DEFAULT_GCP_SERVICE_ACCOUNT_TOKEN_URL) {
          return Response.json({
            access_token: 'short-lived',
            token_type: 'Bearer',
            expires_in: 3600,
          });
        }
        if (
          url ===
          `${DEFAULT_GCP_COMPUTE_API_BASE_URL}/projects/sam-test-project/zones/europe-west1-b`
        ) {
          return Response.json({});
        }
        return new Response('cloud api unavailable in tests', { status: 503 });
      })
    );
    const rotate = (privateKeyId: string) =>
      request(ownerId, 'PUT', '/api/gcp/service-account', {
        serviceAccountJson: JSON.stringify({
          type: 'service_account',
          project_id: 'sam-test-project',
          private_key_id: privateKeyId,
          private_key: privateKey,
          client_email: 'sam-vm@sam-test-project.iam.gserviceaccount.com',
        }),
        defaultZone: 'europe-west1-b',
      });

    expect((await rotate('key-1')).status).toBe(200);
    await reconcile({ userId: ownerId });
    const credentialId = await userGcpCredentialId(ownerId);
    const picked = await pickProvider({
      scope: 'user',
      ownerUserId: ownerId,
      ownerProjectId: null,
      provider: 'gcp',
    });
    const sourceVersion = () =>
      env.DATABASE.prepare(
        `SELECT s.credential_version AS sourceVersion, c.updated_at AS credentialUpdatedAt
           FROM capacity_sources s JOIN credentials c ON c.id = s.credential_id
          WHERE s.id = ?`
      )
        .bind(picked.sourceId)
        .first<{ sourceVersion: number; credentialUpdatedAt: string }>();
    const before = await sourceVersion();
    expect(before?.sourceVersion).toBe(Date.parse(before!.credentialUpdatedAt));

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await rotate('key-2')).status).toBe(200);

    // No manual reconcile: the route itself must carry the source to the new key.
    expect(await userGcpCredentialId(ownerId)).toBe(credentialId);
    const after = await sourceVersion();
    expect(after?.sourceVersion).toBe(Date.parse(after!.credentialUpdatedAt));
    expect(after!.sourceVersion).toBeGreaterThan(before!.sourceVersion);
    const pool = await defaultPool('user', ownerId, null);
    expect(await activeCandidateIds(pool!.id, picked.sourceId)).toEqual(picked.activeCandidateIds);
  });
});

describe('a source deleted with its credential (disconnect, platform rotation)', () => {
  it('a project-scoped node stays claimable after the project credential is removed', async () => {
    const installationId = `${prefix}-install`;
    const projectId = `${prefix}-project`;
    await seedInstallation(installationId, ownerId);
    await seedProject(projectId, ownerId, installationId);

    // The non-GCP replace path: a second save updates the same row and keeps the source.
    const path = `/api/projects/${projectId}/cloud-credentials`;
    expect(
      (await request(ownerId, 'PUT', path, { provider: 'hetzner', token: 'tok-1' })).status
    ).toBe(201);
    await reconcile({ userId: ownerId, projectId });
    const picked = await pickProvider({
      scope: 'project',
      ownerUserId: null,
      ownerProjectId: projectId,
      provider: 'hetzner',
    });
    const nodeId = `${prefix}-project-node`;
    const placed = await placeNode(nodeId, ownerId, projectId, 'stopped');
    expect(placed.snapshot.capacitySourceId).toBe(picked.sourceId);

    expect(
      (await request(ownerId, 'PUT', path, { provider: 'hetzner', token: 'tok-2' })).status
    ).toBe(200);
    await reconcile({ userId: ownerId, projectId });
    expect((await readNode(nodeId))?.capacitySourceId).toBe(picked.sourceId);
    const pool = await defaultPool('project', null, projectId);
    expect(await activeCandidateIds(pool!.id, picked.sourceId)).toEqual(picked.activeCandidateIds);

    // Disconnect: the cascade releases the column on the placed node.
    expect((await request(ownerId, 'DELETE', `${path}/hetzner`)).status).toBe(200);
    const released = await readNode(nodeId);
    expect(released?.capacitySourceId).toBeNull();
    expect(released?.capacityPoolCandidateId).toBe(placed.snapshot.capacityPoolCandidateId);

    // Owner control first, then the real cron.
    expect(await claim(nodeId, otherUserId, 'stopped')).toBe(false);
    expect((await readNode(nodeId))?.cleanupBackoffUntil).toBeNull();
    await runNodeCleanupSweep(workerEnv);
    const after = await readNode(nodeId);
    expect(after?.cleanupBackoffUntil).not.toBeNull();
    expect(after?.cleanupBlockedReason ?? '').not.toContain('provenance');

    // The release grants cleanup only. After reconnecting, new work is never placed on the
    // released node, while a node placed from the new connection is reused.
    expect(
      (await request(ownerId, 'PUT', path, { provider: 'hetzner', token: 'tok-3' })).status
    ).toBe(201);
    await reconcile({ userId: ownerId, projectId });
    await pickProvider({
      scope: 'project',
      ownerUserId: null,
      ownerProjectId: projectId,
      provider: 'hetzner',
    });
    const controlNode = `${prefix}-project-control`;
    await placeNode(controlNode, ownerId, projectId, 'running');
    const selection = await placementSelection(ownerId, projectId);
    const releasedRow = await reuseRow(nodeId);
    const controlRow = await reuseRow(controlNode);
    expect(
      resolveReusableNodeCapacitySnapshot({
        selection,
        node: releasedRow,
        projectId,
        requestedVmSize: releasedRow.vmSize ?? 'medium',
      })
    ).toBeUndefined();
    expect(
      resolveReusableNodeCapacitySnapshot({
        selection,
        node: controlRow,
        projectId,
        requestedVmSize: controlRow.vmSize ?? 'medium',
      })
    ).toMatchObject({ capacitySourceId: controlRow.capacitySourceId });
  });

  it('a platform-placed node stays claimable after the platform credential is rotated', async () => {
    const created = await request(
      ownerId,
      'POST',
      '/api/admin/platform-credentials',
      {
        credentialType: 'cloud-provider',
        provider: 'gcp',
        label: 'platform gcp',
        credential: JSON.stringify({
          ...GCP_CONNECTION,
          version: 2,
          authType: 'workload-identity',
        }),
      },
      'superadmin'
    );
    expect(created.status).toBe(201);
    const platformCredentialId = ((await created.json()) as { id: string }).id;
    await reconcile({ userId: ownerId, installation: true });

    const pool = await env.DATABASE.prepare(
      `SELECT DISTINCT c.pool_id AS poolId, p.scope, p.owner_user_id AS ownerUserId
         FROM capacity_pool_candidates c
         JOIN capacity_pools p ON p.id = c.pool_id
        WHERE c.capacity_source_id = ? AND p.scope IN ('user', 'installation')
        ORDER BY p.scope = 'user' DESC`
    )
      .bind(`cap-source-default:platform:${platformCredentialId}`)
      .first<{ poolId: string; scope: CapacityPoolScope; ownerUserId: string | null }>();
    expect(pool).not.toBeNull();
    await pickProvider({
      scope: pool!.scope,
      ownerUserId: pool!.ownerUserId,
      ownerProjectId: null,
      provider: 'gcp',
    });
    const runningNode = `${prefix}-platform-running`;
    const placed = await placeNode(runningNode, ownerId, null, 'running');
    expect(placed.snapshot.capacitySourceId).toContain(platformCredentialId);

    // Platform rotation today is "add the new one, delete the old one".
    const deleted = await request(
      ownerId,
      'DELETE',
      `/api/admin/platform-credentials/${platformCredentialId}`,
      undefined,
      'superadmin'
    );
    expect(deleted.status).toBe(200);
    expect((await readNode(runningNode))?.capacitySourceId).toBeNull();

    expect(await claim(runningNode, ownerId, 'running')).toBe(false); // no running opt-in
    const handoff = await handOffEmptyWorkspaceNode(workerEnv, {
      nodeId: runningNode,
      reason: 'credential_rotation_test',
      expectedUserId: ownerId,
    });
    expect(handoff).toEqual({ outcome: 'handed_to_warm' });
  });
});

describe('rows already damaged in the production shape', () => {
  /** A placed node whose source row is gone, exactly as the staging rows look today. */
  async function seedReleasedNode(nodeId: string, userId: string, status: string) {
    await seedNode(nodeId, userId, {
      status,
      createdAt: new Date(Date.now() - 2 * DAY).toISOString(),
      updatedAt: new Date(Date.now() - 2 * DAY).toISOString(),
    });
    await env.DATABASE.prepare(
      "INSERT INTO capacity_pools (id, scope, owner_user_id, name) VALUES (?, 'user', ?, 'pool')"
    )
      .bind(`${nodeId}-pool`, userId)
      .run();
    await env.DATABASE.prepare(
      `UPDATE nodes SET runtime = 'vm', node_role = 'workspace', node_class = 'managed',
         workload_role = 'workspace', cloud_provider = 'gcp',
         provider_instance_id = ?, runtime_incarnation_id = ?,
         provider_instance_type = 'e2-medium', provider_instance_vcpu_count = 2,
         provider_instance_memory_mb = 4096,
         capacity_pool_id = ?, capacity_pool_scope = 'user', capacity_pool_revision = 7,
         capacity_source_id = NULL, capacity_source_generation = 794736228,
         capacity_pool_candidate_id = ?,
         placement_credential_source = 'user', placement_credential_reference = ?,
         placement_credential_version = 1794340011966,
         placement_credential_fingerprint = 'fp'
       WHERE id = ?`
    )
      .bind(
        `${nodeId}-instance`,
        `${nodeId}-incarnation`,
        `${nodeId}-pool`,
        `cap-candidate-default:${nodeId}-pool:cap-source-default:user:deleted-gcp-connection:gcp:europe-west1-b:e2-medium`,
        'credentials:deleted-gcp-connection',
        nodeId
      )
      .run();
  }

  it('claims a released stopped node and refuses every variant that is not the release', async () => {
    const released = `${prefix}-released`;
    await seedReleasedNode(released, ownerId, 'stopped');

    // Not the cascade: the candidate the node names still exists.
    const stillListed = `${prefix}-candidate-still-listed`;
    await seedReleasedNode(stillListed, ownerId, 'stopped');
    const candidateId = (await readNode(stillListed))!.capacityPoolCandidateId!;
    await env.DATABASE.prepare(
      `INSERT INTO credentials (id, user_id, provider, credential_type, credential_kind,
         is_active, encrypted_token, iv, created_at, updated_at)
       VALUES (?, ?, 'gcp', 'cloud-provider', 'api-key', 1, 'x', 'y', datetime('now'), datetime('now'))`
    )
      .bind(`${prefix}-cred`, ownerId)
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO capacity_sources (id, scope, owner_user_id, source_kind, provider,
         credential_source, credential_id, credential_reference, credential_version)
       VALUES (?, 'user', ?, 'cloud-provider-credential', 'gcp', 'user', ?, ?, 1)`
    )
      .bind(`${prefix}-source`, ownerId, `${prefix}-cred`, `credentials:${prefix}-cred`)
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO capacity_pool_candidates (id, pool_id, capacity_source_id, provider, location,
         machine_size)
       VALUES (?, ?, ?, 'gcp', 'europe-west1-b', 'medium')`
    )
      .bind(candidateId, `${stillListed}-pool`, `${prefix}-source`)
      .run();

    // Not proof at all: a released node missing another server-written snapshot field.
    const noFingerprint = `${prefix}-no-fingerprint`;
    await seedReleasedNode(noFingerprint, ownerId, 'stopped');
    await env.DATABASE.prepare(
      'UPDATE nodes SET placement_credential_fingerprint = NULL WHERE id = ?'
    )
      .bind(noFingerprint)
      .run();

    // The node names a pool that belongs to someone else.
    const foreignPool = `${prefix}-foreign-pool`;
    await seedReleasedNode(foreignPool, ownerId, 'stopped');
    await env.DATABASE.prepare('UPDATE capacity_pools SET owner_user_id = ? WHERE id = ?')
      .bind(otherUserId, `${foreignPool}-pool`)
      .run();

    // Running, without the caller's opt-in.
    const running = `${prefix}-released-running`;
    await seedReleasedNode(running, ownerId, 'running');

    expect(await claim(released, otherUserId, 'stopped')).toBe(false); // another user's claim
    expect(await claim(stillListed, ownerId, 'stopped')).toBe(false);
    expect(await claim(noFingerprint, ownerId, 'stopped')).toBe(false);
    expect(await claim(foreignPool, ownerId, 'stopped')).toBe(false);
    expect(await claim(running, ownerId, 'running')).toBe(false);
    expect(await claim(released, ownerId, 'stopped')).toBe(true); // owner control
    expect(await claim(running, ownerId, 'running', true)).toBe(true); // opted-in control
  });

  it('strict deletion finalizes a released node that already carries termination proof', async () => {
    // hasManagedVmPlacementProof is the code twin of the SQL predicate. It gates using an
    // existing termination proof for a node with no provider instance id.
    async function seedProvenTerminated(nodeId: string) {
      await seedReleasedNode(nodeId, ownerId, 'destroying');
      await env.DATABASE.prepare(
        `UPDATE nodes SET provider_instance_id = NULL,
           runtime_termination_confirmed_at = datetime('now') WHERE id = ?`
      )
        .bind(nodeId)
        .run();
    }
    const released = `${prefix}-proven-released`;
    await seedProvenTerminated(released);
    await expect(
      deleteNodeResourcesStrict(released, ownerId, workerEnv, { cleanupDns: false })
    ).resolves.toMatchObject({ providerVm: 'no-instance' });

    // Control: NULL column but the candidate still exists, so this is not the cascade's shape.
    const notReleased = `${prefix}-proven-not-released`;
    await seedProvenTerminated(notReleased);
    const candidateId = (await readNode(notReleased))!.capacityPoolCandidateId!;
    await env.DATABASE.prepare(
      `INSERT INTO credentials (id, user_id, provider, credential_type, credential_kind,
         is_active, encrypted_token, iv, created_at, updated_at)
       VALUES (?, ?, 'gcp', 'cloud-provider', 'api-key', 1, 'x', 'y', datetime('now'), datetime('now'))`
    )
      .bind(`${prefix}-proven-cred`, ownerId)
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO capacity_sources (id, scope, owner_user_id, source_kind, provider,
         credential_source, credential_id, credential_reference, credential_version)
       VALUES (?, 'user', ?, 'cloud-provider-credential', 'gcp', 'user', ?, ?, 1)`
    )
      .bind(
        `${prefix}-proven-source`,
        ownerId,
        `${prefix}-proven-cred`,
        `credentials:${prefix}-proven-cred`
      )
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO capacity_pool_candidates (id, pool_id, capacity_source_id, provider, location,
         machine_size)
       VALUES (?, ?, ?, 'gcp', 'europe-west1-b', 'medium')`
    )
      .bind(candidateId, `${notReleased}-pool`, `${prefix}-proven-source`)
      .run();
    await expect(
      deleteNodeResourcesStrict(notReleased, ownerId, workerEnv, { cleanupDns: false })
    ).rejects.toThrow(/lacks managed placement/);
  });

  it('binds a released node to its own pool scope, project and installation', async () => {
    const installationId = `${prefix}-scope-install`;
    const projectA = `${prefix}-project-a`;
    const projectB = `${prefix}-project-b`;
    await seedInstallation(installationId, ownerId);
    await seedProject(projectA, ownerId, installationId);
    await seedProject(projectB, ownerId, installationId);
    const setPool = (
      nodeId: string,
      scope: string,
      ownerUser: string | null,
      ownerProject: string | null
    ) =>
      env.DATABASE.prepare(
        'UPDATE capacity_pools SET scope = ?, owner_user_id = ?, owner_project_id = ? WHERE id = ?'
      )
        .bind(scope, ownerUser, ownerProject, `${nodeId}-pool`)
        .run();
    const setNodeScope = (nodeId: string, scope: string, projectId: string | null) =>
      env.DATABASE.prepare(
        'UPDATE nodes SET capacity_pool_scope = ?, capacity_pool_project_id = ? WHERE id = ?'
      )
        .bind(scope, projectId, nodeId)
        .run();

    // A user-scoped node whose pool row is an installation pool: the scopes must agree.
    const scopeMismatch = `${prefix}-scope-mismatch`;
    await seedReleasedNode(scopeMismatch, ownerId, 'stopped');
    await setPool(scopeMismatch, 'installation', null, null);

    // A project-scoped node whose pool belongs to another project.
    const foreignProject = `${prefix}-foreign-project`;
    await seedReleasedNode(foreignProject, ownerId, 'stopped');
    await setPool(foreignProject, 'project', null, projectB);
    await setNodeScope(foreignProject, 'project', projectA);

    // Controls: the node's own project pool, and an installation pool for an installation node.
    const ownProject = `${prefix}-own-project`;
    await seedReleasedNode(ownProject, ownerId, 'stopped');
    await setPool(ownProject, 'project', null, projectA);
    await setNodeScope(ownProject, 'project', projectA);
    const installationNode = `${prefix}-installation-node`;
    await seedReleasedNode(installationNode, ownerId, 'stopped');
    await setPool(installationNode, 'installation', null, null);
    await setNodeScope(installationNode, 'installation', null);

    // A blank candidate id names nothing, so it is not the cascade's shape.
    const blankCandidate = `${prefix}-blank-candidate`;
    await seedReleasedNode(blankCandidate, ownerId, 'stopped');
    await env.DATABASE.prepare("UPDATE nodes SET capacity_pool_candidate_id = '  ' WHERE id = ?")
      .bind(blankCandidate)
      .run();

    expect(await claim(scopeMismatch, ownerId, 'stopped')).toBe(false);
    expect(await claim(foreignProject, ownerId, 'stopped')).toBe(false);
    expect(await claim(blankCandidate, ownerId, 'stopped')).toBe(false);
    expect(await claim(ownProject, ownerId, 'stopped')).toBe(true);
    expect(await claim(installationNode, ownerId, 'stopped')).toBe(true);
  });

  it('a pool whose order names a deleted source still places on its active options', async () => {
    expect((await request(ownerId, 'POST', '/api/credentials', GCP_CONNECTION)).status).toBe(201);
    await reconcile({ userId: ownerId });
    const picked = await pickProvider({
      scope: 'user',
      ownerUserId: ownerId,
      ownerProjectId: null,
      provider: 'gcp',
    });
    const pool = await defaultPool('user', ownerId, null);
    // The staging shape: the order still leads with the source the 2026-11-12 save deleted.
    await env.DATABASE.prepare('UPDATE capacity_pools SET source_order_json = ? WHERE id = ?')
      .bind(
        JSON.stringify(['cap-source-default:user:deleted-gcp-connection', picked.sourceId]),
        pool!.id
      )
      .run();

    const selection = await placementSelection(ownerId, null);
    expect(selection.candidates.length).toBeGreaterThan(0);
    expect(selection.candidates[0]!.capacitySourceId).toBe(picked.sourceId);
  });
});
