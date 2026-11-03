/**
 * The owner can remove a node SAM cannot tear down, after deleting its server by hand.
 *
 * Production: deployment node 01KXAR1T… (Hetzner server deleted by hand long ago)
 * sat in `destroying` for weeks because strict deletion refuses a node with no
 * recorded credential binding ("exact provider credential binding is missing"),
 * and the deployment-node cron retried it hourly forever.
 *
 * Driven through the real route handlers, strict deletion, the shared removal
 * tail, migrated D1 foreign keys, and the real hourly deployment-node cron.
 */
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { getCredentialEncryptionKey } from '../../src/lib/secrets';
import { AppError } from '../../src/middleware/error';
import { nodesRoutes } from '../../src/routes/nodes';
import { runDeploymentNodeCleanup } from '../../src/scheduled/deployment-node-cleanup';
import { encrypt } from '../../src/services/encryption';
import { recordManualNodeDeletion } from '../../src/services/node-manual-deletion';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const STRICT_REFUSAL =
  'Stop failed during managed node teardown: Cannot strictly delete node: exact provider credential binding is missing';

function handlersFor(method: string, path: string) {
  return nodesRoutes.routes
    .filter((route) => route.method === method && route.path === path)
    .map((route) => route.handler);
}

function appFor(userId: string) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as never)
      : c.json({ error: error.message }, 500)
  );
  app.use('*', async (c, next) => {
    c.set('auth', {
      user: {
        id: userId,
        email: `${userId}@test.com`,
        name: null,
        avatarUrl: null,
        role: 'user',
        status: 'active',
      },
      session: { id: null, token: null, expiresAt: new Date(Date.now() + 60_000) },
    });
    await next();
  });
  // Mount the exact handlers registered on nodesRoutes, including the body validator.
  app.delete('/nodes/:id', ...(handlersFor('DELETE', '/:id') as [never]));
  app.post(
    '/nodes/:id/manual-deletion',
    ...(handlersFor('POST', '/:id/manual-deletion') as [never])
  );
  return app;
}

async function confirmManualDeletion(
  userId: string,
  nodeId: string,
  body: unknown = { confirmed: true }
) {
  return appFor(userId).request(
    `/nodes/${nodeId}/manual-deletion`,
    { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } },
    env as unknown as Env
  );
}

/** The incident's shape: a legacy deployment node whose strict teardown keeps failing. */
async function seedStuckDeploymentNode(suffix: string) {
  const userId = `manual-del-user-${suffix}`;
  const projectId = `manual-del-project-${suffix}`;
  const installationId = `manual-del-install-${suffix}`;
  const nodeId = `manual-del-node-${suffix}`;
  const environmentId = `manual-del-env-${suffix}`;
  await seedUser(userId);
  await seedInstallation(installationId, userId);
  await seedProject(projectId, userId, installationId);
  await seedNode(nodeId, userId, { status: 'destroying', healthStatus: 'stale' });
  await env.DATABASE.prepare(
    `UPDATE nodes SET node_role = 'deployment', runtime = 'vm', cloud_provider = 'hetzner',
       provider_instance_id = '150100869', credential_source = 'user',
       placement_credential_source = NULL, placement_credential_reference = NULL,
       runtime_incarnation_id = 'incarnation-legacy', error_message = ?,
       cleanup_backoff_until = '2000-01-01T00:00:00.000Z'
     WHERE id = ?`
  )
    .bind(STRICT_REFUSAL, nodeId)
    .run();
  await env.DATABASE.prepare(
    `INSERT INTO deployment_environments (id, project_id, name, status, node_id, created_by_user_id)
     VALUES (?, ?, 'production', 'error', ?, ?)`
  )
    .bind(environmentId, projectId, nodeId, userId)
    .run();
  return { userId, projectId, nodeId, environmentId };
}

async function seedHetznerCredential(userId: string) {
  const { ciphertext, iv } = await encrypt(
    'hetzner-test-token',
    getCredentialEncryptionKey(env as unknown as Env)
  );
  await env.DATABASE.prepare(
    `INSERT INTO credentials
       (id, user_id, project_id, credential_type, credential_kind, agent_type, provider,
        encrypted_token, iv, is_active, created_at, updated_at)
     VALUES (?, ?, NULL, 'cloud-provider', 'api-key', NULL, 'hetzner', ?, ?, 1,
             datetime('now'), datetime('now'))`
  )
    .bind(`cred-${userId}`, userId, ciphertext, iv)
    .run();
}

async function readNode(nodeId: string) {
  return env.DATABASE.prepare(
    `SELECT status, runtime_termination_confirmed_at, runtime_termination_attested_at,
            error_message, provider_instance_id
       FROM nodes WHERE id = ?`
  )
    .bind(nodeId)
    .first<{
      status: string;
      runtime_termination_confirmed_at: string | null;
      runtime_termination_attested_at: string | null;
      error_message: string | null;
      provider_instance_id: string | null;
    }>();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('owner-confirmed removal of a node SAM cannot delete', () => {
  it('removes the stuck legacy deployment node and stops the hourly retry', async () => {
    const seeded = await seedStuckDeploymentNode('incident');

    // The stuck state through real code: strict deletion refuses this node.
    const refused = await appFor(seeded.userId).request(
      `/nodes/${seeded.nodeId}`,
      { method: 'DELETE' },
      env as unknown as Env
    );
    expect(refused.status).toBe(409);
    expect((await readNode(seeded.nodeId))?.status).toBe('destroying');

    const response = await confirmManualDeletion(seeded.userId, seeded.nodeId);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });

    const node = await readNode(seeded.nodeId);
    expect(node?.status).toBe('deleted');
    expect(node?.runtime_termination_confirmed_at).toEqual(expect.any(String));
    const environment = await env.DATABASE.prepare(
      'SELECT status, node_id FROM deployment_environments WHERE id = ?'
    )
      .bind(seeded.environmentId)
      .first<{ status: string; node_id: string | null }>();
    expect(environment).toEqual({ status: 'stopped', node_id: null });
    const healthEvent = await env.DATABASE.prepare(
      'SELECT event, reason FROM node_health_events WHERE node_id = ?'
    )
      .bind(seeded.nodeId)
      .first<{ event: string; reason: string }>();
    expect(healthEvent).toEqual({
      event: 'deleted_by_owner',
      reason: 'owner_attested_manual_deletion',
    });

    // The hourly cron that retried it forever no longer touches it.
    const fetchSpy = vi.fn(async () => new Response('unexpected', { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);
    await runDeploymentNodeCleanup(env as unknown as Env);
    expect(await readNode(seeded.nodeId)).toEqual(node);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // A manual removal records its proof first and finishes the removal after it.
  // If it stops in between, the owner's next Delete consumes that proof. Its audit
  // reason must still say the proof was attested, not strict: readers that trust
  // `owner_requested_node_deletion` would otherwise accept the weaker evidence.
  async function deleteViaRoute(userId: string, nodeId: string) {
    return appFor(userId).request(`/nodes/${nodeId}`, { method: 'DELETE' }, env as unknown as Env);
  }
  async function ownerRemovalReason(nodeId: string) {
    return (
      await env.DATABASE.prepare(
        `SELECT reason FROM node_health_events WHERE node_id = ? AND event = 'deleted_by_owner'`
      )
        .bind(nodeId)
        .first<{ reason: string }>()
    )?.reason;
  }

  it('keeps the attested provenance when a Delete finishes an interrupted manual removal', async () => {
    const seeded = await seedStuckDeploymentNode('interrupted');
    // The route's first step, then nothing: the request stopped before removal.
    await recordManualNodeDeletion(
      drizzle(env.DATABASE, { schema }),
      env as unknown as Env,
      seeded.nodeId,
      seeded.userId
    );
    const attested = await readNode(seeded.nodeId);
    expect(attested?.status).toBe('destroying');
    expect(attested?.runtime_termination_attested_at).toBe(
      attested?.runtime_termination_confirmed_at
    );

    const response = await deleteViaRoute(seeded.userId, seeded.nodeId);
    expect(response.status).toBe(200);
    expect((await readNode(seeded.nodeId))?.status).toBe('deleted');
    expect(await ownerRemovalReason(seeded.nodeId)).toBe('owner_attested_manual_deletion');
  });

  it('records the owner request when a Delete consumes strict proof (control)', async () => {
    const seeded = await seedStuckDeploymentNode('strict-proof');
    await env.DATABASE.prepare(
      `UPDATE nodes SET runtime_termination_confirmed_at = '2026-11-02T10:00:00.000Z' WHERE id = ?`
    )
      .bind(seeded.nodeId)
      .run();

    const response = await deleteViaRoute(seeded.userId, seeded.nodeId);
    expect(response.status).toBe(200);
    expect(await ownerRemovalReason(seeded.nodeId)).toBe('owner_requested_node_deletion');
  });

  it('treats an attestation as ended once a later proof replaced it', async () => {
    const seeded = await seedStuckDeploymentNode('stale-attestation');
    await env.DATABASE.prepare(
      `UPDATE nodes SET runtime_termination_attested_at = '2026-11-01T10:00:00.000Z',
         runtime_termination_confirmed_at = '2026-11-02T10:00:00.000Z' WHERE id = ?`
    )
      .bind(seeded.nodeId)
      .run();

    const response = await deleteViaRoute(seeded.userId, seeded.nodeId);
    expect(response.status).toBe(200);
    expect(await ownerRemovalReason(seeded.nodeId)).toBe('owner_requested_node_deletion');
  });

  it('refuses while the provider still reports the server, and changes nothing', async () => {
    const seeded = await seedStuckDeploymentNode('still-exists');
    await seedHetznerCredential(seeded.userId);
    const hetznerCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        hetznerCalls.push(url);
        if (url.endsWith('/servers/150100869')) {
          // Fresh body per call: the shape Hetzner returns for a live server.
          return Response.json({
            server: {
              id: 150100869,
              name: 'deploy-01kx9sb1',
              status: 'running',
              public_net: { ipv4: { ip: '203.0.113.7' } },
              server_type: { name: 'cx22' },
              created: '2026-07-12T08:45:39Z',
              labels: {},
            },
          });
        }
        return new Response('not found', { status: 404 });
      })
    );

    const response = await confirmManualDeletion(seeded.userId, seeded.nodeId);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      message: expect.stringContaining('Server 150100869 still exists at hetzner'),
    });
    expect(hetznerCalls.some((url) => url.endsWith('/servers/150100869'))).toBe(true);
    expect(await readNode(seeded.nodeId)).toMatchObject({
      status: 'destroying',
      runtime_termination_confirmed_at: null,
    });
  });

  it('proceeds when the provider no longer has the server', async () => {
    const seeded = await seedStuckDeploymentNode('gone-at-provider');
    await seedHetznerCredential(seeded.userId);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: { code: 'not_found', message: 'server not found' } },
          { status: 404 }
        )
      )
    );

    const response = await confirmManualDeletion(seeded.userId, seeded.nodeId);
    expect(response.status).toBe(200);
    expect((await readNode(seeded.nodeId))?.status).toBe('deleted');
  });

  it('removes a legacy node that never got a provider instance without asking the provider', async () => {
    const seeded = await seedStuckDeploymentNode('no-instance');
    await seedHetznerCredential(seeded.userId);
    await env.DATABASE.prepare(`UPDATE nodes SET provider_instance_id = NULL WHERE id = ?`)
      .bind(seeded.nodeId)
      .run();
    const fetchSpy = vi.fn(async () => new Response('unexpected', { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);

    const response = await confirmManualDeletion(seeded.userId, seeded.nodeId);
    expect(response.status).toBe(200);
    expect((await readNode(seeded.nodeId))?.status).toBe('deleted');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends a machine the owner enrolled to Delete instead, and changes nothing', async () => {
    const seeded = await seedStuckDeploymentNode('user-owned');
    await env.DATABASE.prepare(`UPDATE nodes SET node_class = 'user-owned' WHERE id = ?`)
      .bind(seeded.nodeId)
      .run();
    const response = await confirmManualDeletion(seeded.userId, seeded.nodeId);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      message: expect.stringContaining('remove it with Delete'),
    });
    expect(await readNode(seeded.nodeId)).toMatchObject({
      status: 'destroying',
      runtime_termination_confirmed_at: null,
    });
  });

  it('removes a stuck workspace node but keeps workspaces a sleeping session can wake from', async () => {
    const userId = 'manual-del-user-workspace-node';
    const projectId = 'manual-del-project-workspace-node';
    const nodeId = 'manual-del-node-workspace-node';
    await seedUser(userId);
    await seedInstallation('manual-del-install-workspace-node', userId);
    await seedProject(projectId, userId, 'manual-del-install-workspace-node');
    await seedNode(nodeId, userId, { status: 'destroying', healthStatus: 'stale' });
    await env.DATABASE.prepare(
      `UPDATE nodes SET runtime = 'vm', cloud_provider = 'hetzner', provider_instance_id = '170000001',
         credential_source = 'user', runtime_incarnation_id = 'incarnation-ws' WHERE id = ?`
    )
      .bind(nodeId)
      .run();
    await seedWorkspace('manual-del-ws-plain', nodeId, userId, { projectId, status: 'stopped' });
    await seedWorkspace('manual-del-ws-snap', nodeId, userId, {
      projectId,
      status: 'stopping',
      chatSessionId: 'manual-del-chat-snap',
    });
    await env.DATABASE.prepare(
      `INSERT INTO session_snapshots (id, project_id, workspace_id, node_id, user_id, chat_session_id,
         runtime, status, degradation, manifest_r2_key, expires_at, sleep_status)
       VALUES ('manual-del-snap', ?, 'manual-del-ws-snap', ?, ?, 'manual-del-chat-snap', 'vm',
         'available', 'none', 'snapshots/manual-del/manifest.json', '2099-01-01T00:00:00.000Z',
         'sleeping')`
    )
      .bind(projectId, nodeId, userId)
      .run();

    const response = await confirmManualDeletion(userId, nodeId);
    expect(response.status).toBe(200);

    expect(await readNode(nodeId)).toBeNull();
    const workspaces = await env.DATABASE.prepare(
      `SELECT id, status, runtime_deletion_proof FROM workspaces
        WHERE id IN ('manual-del-ws-plain', 'manual-del-ws-snap') ORDER BY id`
    ).all<{ id: string; status: string; runtime_deletion_proof: string | null }>();
    expect(workspaces.results).toEqual([
      {
        id: 'manual-del-ws-snap',
        status: 'deleted',
        runtime_deletion_proof: 'node_runtime_terminated',
      },
    ]);
  });

  // Each column alone marks SAM's own capacity: Instant nodes set only the
  // attribution column, capacity placement only the placement column.
  it.each([
    ['credential_source', `credential_source = 'platform'`],
    ['placement_credential_source', `placement_credential_source = 'platform'`],
    ['credential_attribution_source', `credential_attribution_source = 'platform'`],
    // The Instant node shape: a container on SAM's account, no provider instance.
    [
      'an Instant container node',
      `runtime = 'cf-container', credential_attribution_source = 'platform', provider_instance_id = NULL`,
    ],
    // A container node attributed to the user still has no server the owner could delete.
    ['a container runtime', `runtime = 'cf-container'`],
  ])('refuses a node on SAM-managed capacity or runtime: %s', async (label, assignment) => {
    const seeded = await seedStuckDeploymentNode(`samcap-${label.replace(/\W+/g, '-')}`);
    await env.DATABASE.prepare(`UPDATE nodes SET ${assignment} WHERE id = ?`)
      .bind(seeded.nodeId)
      .run();
    const response = await confirmManualDeletion(seeded.userId, seeded.nodeId);
    expect(response.status).toBe(403);
    expect(await readNode(seeded.nodeId)).toMatchObject({
      status: 'destroying',
      runtime_termination_confirmed_at: null,
    });
  });

  it('refuses a node SAM has not failed to delete', async () => {
    const seeded = await seedStuckDeploymentNode('running');
    await env.DATABASE.prepare(`UPDATE nodes SET status = 'running' WHERE id = ?`)
      .bind(seeded.nodeId)
      .run();
    const response = await confirmManualDeletion(seeded.userId, seeded.nodeId);
    expect(response.status).toBe(409);
    expect(await readNode(seeded.nodeId)).toMatchObject({
      status: 'running',
      runtime_termination_confirmed_at: null,
    });
  });

  it("refuses another user's node and changes nothing", async () => {
    const seeded = await seedStuckDeploymentNode('victim');
    await seedUser('manual-del-attacker');
    const response = await confirmManualDeletion('manual-del-attacker', seeded.nodeId);
    expect(response.status).toBe(404);
    expect(await readNode(seeded.nodeId)).toMatchObject({
      status: 'destroying',
      runtime_termination_confirmed_at: null,
    });
  });

  it('requires an explicit confirmation in the request body', async () => {
    const seeded = await seedStuckDeploymentNode('unconfirmed');
    const response = await confirmManualDeletion(seeded.userId, seeded.nodeId, {});
    expect(response.status).toBe(400);
    expect((await readNode(seeded.nodeId))?.status).toBe('destroying');
  });
});
