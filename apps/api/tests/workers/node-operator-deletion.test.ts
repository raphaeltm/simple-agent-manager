/**
 * A superadmin can remove a SAM-capacity node that SAM can never finish tearing down.
 *
 * Incident (staging2, 2026-11-17): node 01M7MTMV89F5ZV23VSF0ZVPJPS, a Hetzner managed VM on
 * platform capacity, failed provisioning before any server ID was recorded and sat in
 * `destroying`. Its pinned platform credential was then re-saved, so strict teardown refused it
 * forever with the wrong label ("Cloud provider credentials missing"), the owner path refused it
 * (SAM capacity, 403), and no operator path existed.
 *
 * Driven through the real strict-teardown funnel and the real admin routes (session cookie,
 * superadmin middleware, valibot body), against D1 with every migration applied. Only the
 * Hetzner API is faked, at `fetch`.
 */
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { getCredentialEncryptionKey } from '../../src/lib/secrets';
import { AppError } from '../../src/middleware/error';
import { adminStrandedNodeRoutes } from '../../src/routes/admin-stranded-nodes';
import { encrypt } from '../../src/services/encryption';
import { buildNodeProviderLabels } from '../../src/services/node-provider-labels';
import { NodeTeardownBlockedError } from '../../src/services/node-teardown-authority';
import { deleteNodeResourcesStrict } from '../../src/services/strict-node-deletion';
import { bindDecryptableProviderCredential } from './helpers/managed-vm-node';
import {
  seedManagedVmAbsenceProof,
  seedNode,
  seedSignedInUser,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const HOUR = 60 * 60 * 1000;
const TEST_ENV = {
  ...(env as unknown as Env),
  ENVIRONMENT: 'test',
  SAM_INSTALLATION_ID: '0123456789abcdef0123456789abcdef',
} as Env;

const app = new Hono<{ Bindings: Env }>();
app.onError((error, c) =>
  error instanceof AppError
    ? c.json(error.toJSON(), error.statusCode as never)
    : c.json({ error: 'INTERNAL_ERROR', message: error.message }, 500)
);
app.route('/api/admin/nodes', adminStrandedNodeRoutes);

async function signIn(userId: string, role: 'superadmin' | 'user') {
  await seedUser(userId);
  await env.DATABASE.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, userId).run();
  return seedSignedInUser(userId);
}

async function operatorDeletion(
  cookie: string,
  nodeId: string,
  body: unknown = { confirmation: nodeId, note: 'Checked the Hetzner console: no server.' }
) {
  return app.request(
    `/api/admin/nodes/${nodeId}/operator-deletion`,
    {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    TEST_ENV
  );
}

/** Re-save the platform credential in place: same row and token, new ciphertext generation. */
async function resavePlatformCredential(nodeId: string) {
  const token = await encrypt('hetzner-test-token', getCredentialEncryptionKey(TEST_ENV));
  await env.DATABASE.prepare(
    `UPDATE platform_credentials SET encrypted_token = ?, iv = ?, updated_at = ? WHERE id = ?`
  )
    .bind(
      token.ciphertext,
      token.iv,
      new Date(Date.now() + 1000).toISOString(),
      `${nodeId}-proof-credential`
    )
    .run();
}

/** The incident's shape: providerless platform-capacity Hetzner VM in `destroying`. */
async function seedStrandedPlatformNode(suffix: string) {
  const ownerId = `op-del-owner-${suffix}`;
  const nodeId = `op-del-node-${suffix}`;
  await seedUser(ownerId);
  await seedNode(nodeId, ownerId, {
    status: 'destroying',
    healthStatus: 'stale',
    createdAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    lastHeartbeatAt: null,
  });
  await seedManagedVmAbsenceProof(nodeId, ownerId);
  await bindDecryptableProviderCredential(nodeId);
  await env.DATABASE.prepare(
    `UPDATE nodes SET provider_instance_id = NULL, runtime_termination_confirmed_at = NULL,
       credential_source = 'platform', credential_attribution_source = 'platform',
       runtime_incarnation_id = 'incarnation-a', cleanup_blocked_since = NULL,
       cleanup_blocked_reason = NULL
     WHERE id = ?`
  )
    .bind(nodeId)
    .run();
  return { ownerId, nodeId };
}

/** What a real teardown pass leaves behind once it has refused: the recorded block. */
async function recordBlock(nodeId: string, reason = 'teardown_credential_generation_changed') {
  await env.DATABASE.prepare(
    `UPDATE nodes SET cleanup_blocked_since = ?, cleanup_blocked_reason = ? WHERE id = ?`
  )
    .bind(new Date(Date.now() - HOUR).toISOString(), reason, nodeId)
    .run();
}

async function readNode(nodeId: string) {
  return env.DATABASE.prepare(
    `SELECT status, runtime_termination_confirmed_at, runtime_termination_attested_at,
            cleanup_blocked_since, cleanup_blocked_reason
       FROM nodes WHERE id = ?`
  )
    .bind(nodeId)
    .first<{
      status: string;
      runtime_termination_confirmed_at: string | null;
      runtime_termination_attested_at: string | null;
      cleanup_blocked_since: string | null;
      cleanup_blocked_reason: string | null;
    }>();
}

async function healthEvents(nodeId: string) {
  return (
    await env.DATABASE.prepare('SELECT event, reason FROM node_health_events WHERE node_id = ?')
      .bind(nodeId)
      .all<{ event: string; reason: string }>()
  ).results;
}

/** Fake Hetzner: `servers` is the inventory every listed or fetched server is drawn from. */
function stubHetzner(servers: Array<{ id: number; labels: Record<string, string> }> = []) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      const payload = (server: { id: number; labels: Record<string, string> }) => ({
        id: server.id,
        name: 'node-x',
        status: 'running',
        created: new Date(Date.now() - HOUR).toISOString(),
        public_net: { ipv4: { ip: '203.0.113.9' } },
        server_type: { name: 'cx23' },
        location: { name: 'nbg1' },
        labels: server.labels,
      });
      const byId = url.match(/\/servers\/(\d+)$/);
      if (byId) {
        const found = servers.find((server) => String(server.id) === byId[1]);
        return found
          ? Response.json({ server: payload(found) })
          : Response.json({ error: { code: 'not_found', message: 'not found' } }, { status: 404 });
      }
      if (url.includes('/servers?')) {
        const selector = new URL(url).searchParams.get('label_selector') ?? '';
        const matching = servers.filter((server) =>
          selector
            .split(',')
            .filter(Boolean)
            .every((part) => {
              const [key, value] = part.split('=');
              return server.labels[key!] === value;
            })
        );
        return Response.json({
          servers: matching.map(payload),
          meta: { pagination: { next_page: null } },
        });
      }
      throw new Error(`Unexpected external boundary: ${url}`);
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stranded providerless platform node: teardown names its refusal', () => {
  it('reports a re-saved platform credential as a generation change, not a missing credential', async () => {
    const seeded = await seedStrandedPlatformNode('resaved');
    await resavePlatformCredential(seeded.nodeId);
    const calls = stubHetzner();

    const failure = await deleteNodeResourcesStrict(seeded.nodeId, seeded.ownerId, TEST_ENV).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(NodeTeardownBlockedError);
    expect((failure as NodeTeardownBlockedError).reason).toBe(
      'teardown_credential_generation_changed'
    );
    expect(String((failure as Error).message)).not.toContain('credentials missing');
    // The named refusal is recorded where operators look (the destroying-node anomaly).
    expect(await readNode(seeded.nodeId)).toMatchObject({
      status: 'destroying',
      runtime_termination_confirmed_at: null,
      cleanup_blocked_reason: 'teardown_credential_generation_changed',
      cleanup_blocked_since: expect.any(String),
    });
    // A re-saved credential is never used as absence proof for the old generation.
    expect(calls).toEqual([]);
  });

  it('reports an empty exact inventory as unresolved allocation, and keeps the node', async () => {
    const seeded = await seedStrandedPlatformNode('empty-exact');
    const calls = stubHetzner();

    const failure = await deleteNodeResourcesStrict(seeded.nodeId, seeded.ownerId, TEST_ENV).catch(
      (error: unknown) => error
    );
    expect((failure as NodeTeardownBlockedError).reason).toBe('teardown_allocation_unresolved');
    expect(calls.some((url) => url.includes('/servers?'))).toBe(true);
    expect(await readNode(seeded.nodeId)).toMatchObject({
      status: 'destroying',
      runtime_termination_confirmed_at: null,
      cleanup_blocked_reason: 'teardown_allocation_unresolved',
    });
  });

  it('reports a disabled platform credential as unavailable (control)', async () => {
    const seeded = await seedStrandedPlatformNode('disabled');
    await env.DATABASE.prepare('UPDATE platform_credentials SET is_enabled = 0 WHERE id = ?')
      .bind(`${seeded.nodeId}-proof-credential`)
      .run();
    stubHetzner();

    const failure = await deleteNodeResourcesStrict(seeded.nodeId, seeded.ownerId, TEST_ENV).catch(
      (error: unknown) => error
    );
    expect((failure as NodeTeardownBlockedError).reason).toBe('teardown_credential_unavailable');
  });
});

describe('superadmin attestation removes a stranded SAM-capacity node', () => {
  it('removes the incident node after its teardown refused, and audits who did it', async () => {
    const operatorId = `op-del-admin-${Date.now()}`;
    const cookie = await signIn(operatorId, 'superadmin');
    const seeded = await seedStrandedPlatformNode('incident');
    await resavePlatformCredential(seeded.nodeId);
    const calls = stubHetzner();
    // The real teardown pass records the block the operator path requires.
    await deleteNodeResourcesStrict(seeded.nodeId, seeded.ownerId, TEST_ENV).catch(() => undefined);

    const response = await operatorDeletion(cookie, seeded.nodeId);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });

    // SAM looked with the credential it still has before taking the operator's word.
    expect(
      calls.some((url) => url.includes('/servers?') && url.includes(seeded.nodeId.toLowerCase()))
    ).toBe(true);
    expect(await readNode(seeded.nodeId)).toBeNull();
    expect(await healthEvents(seeded.nodeId)).toEqual([
      { event: 'deleted_by_operator', reason: 'operator_attested_manual_deletion' },
    ]);
    const audit = await env.DATABASE.prepare(
      `SELECT actor_user_id, tool, target_type, outcome, detail FROM operations_audit_log
        WHERE target_id = ?`
    )
      .bind(seeded.nodeId)
      .first<{
        actor_user_id: string;
        tool: string;
        target_type: string;
        outcome: string;
        detail: string;
      }>();
    expect(audit).toMatchObject({
      actor_user_id: operatorId,
      tool: 'admin_operator_node_deletion',
      target_type: 'node',
      outcome: 'succeeded',
    });
    expect(JSON.parse(audit!.detail)).toMatchObject({
      ownerUserId: seeded.ownerId,
      note: 'Checked the Hetzner console: no server.',
      cleanupBlockedReason: 'teardown_credential_generation_changed',
    });

    // The cleanup funnel that failed forever now has nothing left to do.
    await expect(
      deleteNodeResourcesStrict(seeded.nodeId, seeded.ownerId, TEST_ENV)
    ).rejects.toThrow(/not found/);
  });

  it('refuses while the provider still lists a server for this node, and changes nothing', async () => {
    const cookie = await signIn(`op-del-admin-live-${Date.now()}`, 'superadmin');
    const seeded = await seedStrandedPlatformNode('live-labelled');
    await resavePlatformCredential(seeded.nodeId);
    await recordBlock(seeded.nodeId);
    // A late create: the server exists under SAM's account with this node's exact labels.
    const labels = buildNodeProviderLabels({
      nodeId: seeded.nodeId,
      isDeploymentNode: false,
      environmentLabel: 'test',
      installationId: '0123456789abcdef0123456789abcdef',
      runtimeIncarnationId: 'incarnation-a',
    });
    const calls = stubHetzner([{ id: 777001, labels }]);
    const before = await readNode(seeded.nodeId);

    const response = await operatorDeletion(cookie, seeded.nodeId);
    const listed = calls.filter((url) => url.includes('/servers?'));
    expect(listed.length).toBeGreaterThan(0);
    expect(response.status, `listed: ${listed.join(' | ')}`).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      message: expect.stringContaining('777001'),
    });
    expect(await readNode(seeded.nodeId)).toEqual(before);
    expect(await healthEvents(seeded.nodeId)).toEqual([]);
  });

  it('refuses while the provider still has the recorded server ID, and changes nothing', async () => {
    const cookie = await signIn(`op-del-admin-id-${Date.now()}`, 'superadmin');
    const seeded = await seedStrandedPlatformNode('live-id');
    await env.DATABASE.prepare(`UPDATE nodes SET provider_instance_id = '424242' WHERE id = ?`)
      .bind(seeded.nodeId)
      .run();
    await recordBlock(seeded.nodeId, 'teardown_delete_refused');
    stubHetzner([{ id: 424242, labels: {} }]);
    const before = await readNode(seeded.nodeId);

    const response = await operatorDeletion(cookie, seeded.nodeId);
    expect(response.status).toBe(409);
    expect(await readNode(seeded.nodeId)).toEqual(before);
  });

  it('refuses a node with an active workspace in the final write, and changes nothing', async () => {
    const cookie = await signIn(`op-del-admin-ws-${Date.now()}`, 'superadmin');
    const seeded = await seedStrandedPlatformNode('active-workspace');
    await resavePlatformCredential(seeded.nodeId);
    await recordBlock(seeded.nodeId);
    await seedWorkspace(`op-del-ws-${Date.now()}`, seeded.nodeId, seeded.ownerId, {
      status: 'running',
    });
    stubHetzner();
    const before = await readNode(seeded.nodeId);

    const response = await operatorDeletion(cookie, seeded.nodeId);
    expect(response.status).toBe(409);
    expect(await readNode(seeded.nodeId)).toEqual(before);
    expect(await healthEvents(seeded.nodeId)).toEqual([]);
  });

  it('refuses a node that heartbeated recently, and changes nothing', async () => {
    const cookie = await signIn(`op-del-admin-hb-${Date.now()}`, 'superadmin');
    const seeded = await seedStrandedPlatformNode('fresh-heartbeat');
    await resavePlatformCredential(seeded.nodeId);
    await recordBlock(seeded.nodeId);
    await env.DATABASE.prepare('UPDATE nodes SET last_heartbeat_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), seeded.nodeId)
      .run();
    stubHetzner();
    const before = await readNode(seeded.nodeId);

    const response = await operatorDeletion(cookie, seeded.nodeId);
    expect(response.status).toBe(409);
    expect(await readNode(seeded.nodeId)).toEqual(before);
  });

  it('refuses until SAM has recorded a failed teardown', async () => {
    const cookie = await signIn(`op-del-admin-noblock-${Date.now()}`, 'superadmin');
    const seeded = await seedStrandedPlatformNode('no-block');
    stubHetzner();

    const response = await operatorDeletion(cookie, seeded.nodeId);
    expect(response.status).toBe(409);
    expect((await readNode(seeded.nodeId))?.runtime_termination_confirmed_at).toBeNull();
  });

  it('refuses a providerless node still inside its provisioning window', async () => {
    const cookie = await signIn(`op-del-admin-young-${Date.now()}`, 'superadmin');
    const seeded = await seedStrandedPlatformNode('young');
    await recordBlock(seeded.nodeId);
    await env.DATABASE.prepare('UPDATE nodes SET created_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), seeded.nodeId)
      .run();
    stubHetzner();

    const response = await operatorDeletion(cookie, seeded.nodeId);
    expect(response.status).toBe(409);
    expect((await readNode(seeded.nodeId))?.runtime_termination_confirmed_at).toBeNull();
  });

  it('requires the typed node ID and a note', async () => {
    const cookie = await signIn(`op-del-admin-confirm-${Date.now()}`, 'superadmin');
    const seeded = await seedStrandedPlatformNode('confirm');
    await recordBlock(seeded.nodeId);
    stubHetzner();

    const wrongId = await operatorDeletion(cookie, seeded.nodeId, {
      confirmation: 'some-other-node',
      note: 'checked',
    });
    expect(wrongId.status).toBe(400);
    const noNote = await operatorDeletion(cookie, seeded.nodeId, {
      confirmation: seeded.nodeId,
      note: '   ',
    });
    expect(noNote.status).toBe(400);
    expect((await readNode(seeded.nodeId))?.runtime_termination_confirmed_at).toBeNull();
  });

  it('refuses a node on its owner own cloud account; the owner path handles those', async () => {
    const cookie = await signIn(`op-del-admin-user-cap-${Date.now()}`, 'superadmin');
    const seeded = await seedStrandedPlatformNode('user-capacity');
    await env.DATABASE.prepare(
      `UPDATE nodes SET credential_source = 'user', placement_credential_source = 'user',
         credential_attribution_source = 'user' WHERE id = ?`
    )
      .bind(seeded.nodeId)
      .run();
    await recordBlock(seeded.nodeId);
    stubHetzner();
    const before = await readNode(seeded.nodeId);

    const response = await operatorDeletion(cookie, seeded.nodeId);
    expect(response.status).toBe(403);
    expect(await readNode(seeded.nodeId)).toEqual(before);
  });
});

describe('only an active superadmin reaches the stranded-node routes', () => {
  it('refuses the node owner and other users, listing and acting, and changes nothing', async () => {
    const seeded = await seedStrandedPlatformNode('authz');
    await resavePlatformCredential(seeded.nodeId);
    await recordBlock(seeded.nodeId);
    stubHetzner();
    const ownerCookie = await seedSignedInUser(seeded.ownerId);
    const strangerCookie = await signIn(`op-del-stranger-${Date.now()}`, 'user');
    const before = await readNode(seeded.nodeId);

    for (const cookie of [ownerCookie, strangerCookie]) {
      const act = await operatorDeletion(cookie, seeded.nodeId);
      expect(act.status).toBe(403);
      const list = await app.request(
        '/api/admin/nodes/stranded',
        { headers: { Cookie: cookie } },
        TEST_ENV
      );
      expect(list.status).toBe(403);
    }
    expect(await readNode(seeded.nodeId)).toEqual(before);

    // Owner-path control: a superadmin's identical request is accepted.
    const adminCookie = await signIn(`op-del-admin-authz-${Date.now()}`, 'superadmin');
    const accepted = await operatorDeletion(adminCookie, seeded.nodeId);
    expect(accepted.status).toBe(200);
    expect(await readNode(seeded.nodeId)).toBeNull();
  });

  it('lists SAM-capacity stuck nodes only, with a total', async () => {
    const cookie = await signIn(`op-del-admin-list-${Date.now()}`, 'superadmin');
    const platform = await seedStrandedPlatformNode('list-platform');
    await recordBlock(platform.nodeId);
    const userCapacity = await seedStrandedPlatformNode('list-user');
    await env.DATABASE.prepare(
      `UPDATE nodes SET credential_source = 'user', placement_credential_source = 'user',
         credential_attribution_source = 'user' WHERE id = ?`
    )
      .bind(userCapacity.nodeId)
      .run();

    const response = await app.request(
      '/api/admin/nodes/stranded?limit=200',
      { headers: { Cookie: cookie } },
      TEST_ENV
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      nodes: Array<{ id: string; cleanupBlockedReason: string | null; ownerEmail: string | null }>;
      total: number;
    };
    const ids = body.nodes.map((node) => node.id);
    expect(ids).toContain(platform.nodeId);
    expect(ids).not.toContain(userCapacity.nodeId);
    expect(body.total).toBeGreaterThanOrEqual(body.nodes.length);
    expect(body.nodes.find((node) => node.id === platform.nodeId)).toMatchObject({
      cleanupBlockedReason: 'teardown_credential_generation_changed',
      ownerEmail: `${platform.ownerId}@test.com`,
    });
  });
});
