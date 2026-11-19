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
import { env, SELF } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { getCredentialEncryptionKey } from '../../src/lib/secrets';
import { AppError } from '../../src/middleware/error';
import { adminStrandedNodeRoutes } from '../../src/routes/admin-stranded-nodes';
import { handleCleanupFailure } from '../../src/scheduled/node-cleanup/cleanup-outcome';
import {
  __resetAdminSettingsCacheForTest,
  updateAdminSettings,
} from '../../src/services/admin-settings';
import { encrypt } from '../../src/services/encryption';
import { recordOperatorNodeDeletion } from '../../src/services/node-operator-deletion';
import { buildNodeProviderLabels } from '../../src/services/node-provider-labels';
import { NodeTeardownBlockedError } from '../../src/services/node-teardown-authority';
import { deleteNodeResourcesStrict } from '../../src/services/strict-node-deletion';
import { bindDecryptableProviderCredential } from './helpers/managed-vm-node';
import {
  seedInstallation,
  seedManagedVmAbsenceProof,
  seedNode,
  seedProject,
  seedSignedInUser,
  seedTask,
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

async function currentBlockedReason(nodeId: string): Promise<string | null> {
  const row = await env.DATABASE.prepare('SELECT cleanup_blocked_reason FROM nodes WHERE id = ?')
    .bind(nodeId)
    .first<{ cleanup_blocked_reason: string | null }>();
  return row?.cleanup_blocked_reason ?? null;
}

async function operatorDeletion(cookie: string, nodeId: string, body?: unknown) {
  const payload = body ?? {
    confirmation: nodeId,
    // The refusal the operator was shown in the list.
    expectedBlockedReason: await currentBlockedReason(nodeId),
    note: 'Checked the Hetzner console: no server.',
  };
  return app.request(
    `/api/admin/nodes/${nodeId}/operator-deletion`,
    {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    TEST_ENV
  );
}

/** Re-save the platform credential in place: same row and token, new ciphertext generation. */
async function resavePlatformCredential(nodeId: string, plaintext = 'hetzner-test-token') {
  const token = await encrypt(plaintext, getCredentialEncryptionKey(TEST_ENV));
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

/** A task in `status` holding a warm placement claim on the node. */
async function seedClaimingTask(seeded: { ownerId: string; nodeId: string }, status: string) {
  const suffix = `${seeded.nodeId}-${status}`;
  await seedInstallation(`inst-${suffix}`, seeded.ownerId);
  await seedProject(`proj-${suffix}`, seeded.ownerId, `inst-${suffix}`);
  await seedTask(`task-${suffix}`, `proj-${suffix}`, seeded.ownerId, { status });
  await env.DATABASE.prepare(
    'UPDATE tasks SET claimed_warm_node_id = ?, claimed_warm_node_at = ? WHERE id = ?'
  )
    .bind(seeded.nodeId, new Date().toISOString(), `task-${suffix}`)
    .run();
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

async function auditOutcomes(nodeId: string) {
  return (
    await env.DATABASE.prepare(
      'SELECT outcome FROM operations_audit_log WHERE target_id = ? ORDER BY created_at, id'
    )
      .bind(nodeId)
      .all<{ outcome: string }>()
  ).results.map((row) => row.outcome);
}

/** Another enabled platform credential for the same provider (a second SAM account or key). */
async function seedExtraPlatformCredential(id: string, token: string, createdBy: string) {
  const secret = await encrypt(token, getCredentialEncryptionKey(TEST_ENV));
  await env.DATABASE.prepare(
    `INSERT INTO platform_credentials
       (id, credential_type, provider, label, encrypted_token, iv, created_by, is_enabled)
     VALUES (?, 'cloud-provider', 'hetzner', ?, ?, ?, ?, 1)`
  )
    .bind(id, id, secret.ciphertext, secret.iv, createdBy)
    .run();
}

/** Tokens the latest `stubHetzner` saw, in call order. */
let lastTokens: string[] = [];

/** Fake Hetzner: `servers` is the inventory every listed or fetched server is drawn from. */
function stubHetzner(
  servers: Array<{ id: number; labels: Record<string, string> }> = [],
  options: { byToken?: Record<string, 'empty' | 'reject' | 'error'> } = {}
) {
  const calls: string[] = [];
  const tokens: string[] = [];
  lastTokens = tokens;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      const auth = new Headers(input instanceof Request ? input.headers : init?.headers).get(
        'Authorization'
      );
      const token = auth?.replace(/^Bearer\s+/i, '') ?? '';
      tokens.push(token);
      const behaviour = options.byToken?.[token];
      if (behaviour === 'reject') {
        return Response.json(
          { error: { code: 'unauthorized', message: 'unable to authenticate' } },
          { status: 401 }
        );
      }
      if (behaviour === 'error') {
        return Response.json(
          { error: { code: 'server_error', message: 'internal server error' } },
          { status: 500 }
        );
      }
      const visible = behaviour === 'empty' ? [] : servers;
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
        const found = visible.find((server) => String(server.id) === byId[1]);
        return found
          ? Response.json({ server: payload(found) })
          : Response.json({ error: { code: 'not_found', message: 'not found' } }, { status: 404 });
      }
      if (url.includes('/servers?')) {
        const selector = new URL(url).searchParams.get('label_selector') ?? '';
        const matching = visible.filter((server) =>
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

  it('keeps the full failure backoff for the named refusal past the blocked deadline', async () => {
    const seeded = await seedStrandedPlatformNode('backoff');
    await resavePlatformCredential(seeded.nodeId);
    stubHetzner();
    const failure = await deleteNodeResourcesStrict(seeded.nodeId, seeded.ownerId, TEST_ENV).catch(
      (error: unknown) => error
    );
    // The blocked deadline has long passed, which shrinks an ordinary refusal's backoff to zero.
    await env.DATABASE.prepare('UPDATE nodes SET cleanup_blocked_since = ? WHERE id = ?')
      .bind(new Date(Date.now() - 48 * HOUR).toISOString(), seeded.nodeId)
      .run();
    const nowIso = new Date().toISOString();
    const failureBackoffMs = HOUR;
    await handleCleanupFailure(
      TEST_ENV,
      {
        id: seeded.nodeId,
        user_id: seeded.ownerId,
        status: 'destroying',
        cleanup_blocked_since: new Date(Date.now() - 48 * HOUR).toISOString(),
      },
      nowIso,
      {
        failureLogEvent: 'node_cleanup.test_failure',
        successMessage: 'ok',
        failureMessagePrefix: 'Stuck node teardown failed',
        recoveryType: 'test',
        failureRecoveryType: 'test',
        failureBackoffMs,
        blockedRetirementMs: HOUR,
        context: {},
      },
      failure
    );
    const row = await env.DATABASE.prepare(
      'SELECT cleanup_backoff_until, cleanup_blocked_reason FROM nodes WHERE id = ?'
    )
      .bind(seeded.nodeId)
      .first<{ cleanup_backoff_until: string; cleanup_blocked_reason: string }>();
    expect(Date.parse(row!.cleanup_backoff_until)).toBeGreaterThanOrEqual(
      Date.parse(nowIso) + failureBackoffMs - 1000
    );
    expect(row!.cleanup_blocked_reason.split(',')[0]).toBe(
      'teardown_credential_generation_changed'
    );
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
      outcome: 'attested',
    });
    expect(JSON.parse(audit!.detail)).toMatchObject({
      ownerUserId: seeded.ownerId,
      note: 'Checked the Hetzner console: no server.',
      cleanupBlockedReason: 'teardown_credential_generation_changed',
      pinnedCredentialResolved: false,
      credentialsAnswered: expect.any(Number),
      agentSignIn: false,
    });
    expect(JSON.parse(audit!.detail).credentialsAnswered).toBeGreaterThan(0);
    expect(await auditOutcomes(seeded.nodeId)).toEqual(['attested']);

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
    await recordBlock(seeded.nodeId, 'teardown_instance_not_visible');
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
    // The attempt is recorded before the final write, and its refusal after it.
    expect(await auditOutcomes(seeded.nodeId)).toEqual(['attested', 'refused']);
  });

  it.each(['queued', 'draft'])(
    'refuses while a %s task holds a placement claim on the node, and changes nothing',
    async (taskStatus) => {
      const cookie = await signIn(`op-del-admin-claim-${taskStatus}-${Date.now()}`, 'superadmin');
      const seeded = await seedStrandedPlatformNode(`claim-${taskStatus}`);
      await resavePlatformCredential(seeded.nodeId);
      await recordBlock(seeded.nodeId);
      await seedClaimingTask(seeded, taskStatus);
      stubHetzner();
      const before = await readNode(seeded.nodeId);

      const response = await operatorDeletion(cookie, seeded.nodeId);
      expect(response.status).toBe(409);
      expect(await readNode(seeded.nodeId)).toEqual(before);
    }
  );

  it('accepts a node whose only placement claim belongs to a finished task (control)', async () => {
    const cookie = await signIn(`op-del-admin-claim-done-${Date.now()}`, 'superadmin');
    const seeded = await seedStrandedPlatformNode('claim-completed');
    await resavePlatformCredential(seeded.nodeId);
    await recordBlock(seeded.nodeId);
    await seedClaimingTask(seeded, 'completed');
    stubHetzner();

    const response = await operatorDeletion(cookie, seeded.nodeId);
    expect(response.status).toBe(200);
    expect(await readNode(seeded.nodeId)).toBeNull();
  });

  it('refuses a refusal that means the server may still exist, without asking the provider', async () => {
    const cookie = await signIn(`op-del-admin-reason-${Date.now()}`, 'superadmin');
    const seeded = await seedStrandedPlatformNode('live-reason');
    await env.DATABASE.prepare(`UPDATE nodes SET provider_instance_id = '515151' WHERE id = ?`)
      .bind(seeded.nodeId)
      .run();
    await recordBlock(seeded.nodeId, 'teardown_delete_refused, backoff');
    const calls = stubHetzner();
    const before = await readNode(seeded.nodeId);

    const response = await operatorDeletion(cookie, seeded.nodeId);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      message: expect.stringContaining('teardown_delete_refused'),
    });
    expect(calls).toEqual([]);
    expect(await readNode(seeded.nodeId)).toEqual(before);
    expect(await auditOutcomes(seeded.nodeId)).toEqual([]);
  });

  it('keeps asking past a credential that sees nothing or is rejected, and refuses on a later find', async () => {
    const cookie = await signIn(`op-del-admin-multi-${Date.now()}`, 'superadmin');
    const seeded = await seedStrandedPlatformNode('multi-credential');
    await resavePlatformCredential(seeded.nodeId, 'hetzner-multi-own-token');
    await recordBlock(seeded.nodeId);
    // Extra enabled platform credentials; platform rows are tried in id order, so these sort
    // before the node's own `...-proof-credential` row.
    await seedExtraPlatformCredential(
      `${seeded.nodeId}-a1-rejected`,
      'hetzner-rejected-token',
      seeded.ownerId
    );
    await seedExtraPlatformCredential(
      `${seeded.nodeId}-a2-other-account`,
      'hetzner-other-token',
      seeded.ownerId
    );
    const labels = buildNodeProviderLabels({
      nodeId: seeded.nodeId,
      isDeploymentNode: false,
      environmentLabel: 'test',
      installationId: '0123456789abcdef0123456789abcdef',
      runtimeIncarnationId: 'incarnation-a',
    });
    // Only the node's own (re-saved) credential sees the server; the others reject or see nothing.
    const calls = stubHetzner([{ id: 909090, labels }], {
      byToken: {
        // Every other test's node credential: none of them is this node's account.
        'hetzner-test-token': 'empty',
        'hetzner-other-token': 'empty',
        'hetzner-rejected-token': 'reject',
      },
    });
    const before = await readNode(seeded.nodeId);

    const response = await operatorDeletion(cookie, seeded.nodeId);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      message: expect.stringContaining('909090'),
    });
    // Other tests' nodes add their own enabled platform credentials, so assert order, not count:
    // credentials that rejected or saw nothing were asked first and did not end the search.
    expect(calls.some((url) => url.includes('/servers?'))).toBe(true);
    expect(lastTokens.at(-1)).toBe('hetzner-multi-own-token');
    expect(lastTokens, JSON.stringify(lastTokens)).toContain('hetzner-rejected-token');
    expect(
      lastTokens.slice(0, -1).filter((token) => token !== 'hetzner-multi-own-token').length
    ).toBeGreaterThan(0);
    expect(await readNode(seeded.nodeId)).toEqual(before);
  });

  it('asks the operator to retry when a provider lookup fails, and changes nothing', async () => {
    const cookie = await signIn(`op-del-admin-5xx-${Date.now()}`, 'superadmin');
    const seeded = await seedStrandedPlatformNode('provider-5xx');
    await resavePlatformCredential(seeded.nodeId);
    await recordBlock(seeded.nodeId);
    stubHetzner([], { byToken: { 'hetzner-test-token': 'error' } });
    const before = await readNode(seeded.nodeId);

    const response = await operatorDeletion(cookie, seeded.nodeId);
    expect(response.status).toBe(503);
    expect(await readNode(seeded.nodeId)).toEqual(before);
    expect(await auditOutcomes(seeded.nodeId)).toEqual([]);
  });

  it('refuses a providerless node whose ownership labels cannot be built while a credential could look', async () => {
    const cookie = await signIn(`op-del-admin-nolabels-${Date.now()}`, 'superadmin');
    const seeded = await seedStrandedPlatformNode('no-labels');
    await env.DATABASE.prepare('UPDATE nodes SET runtime_incarnation_id = NULL WHERE id = ?')
      .bind(seeded.nodeId)
      .run();
    await recordBlock(seeded.nodeId, 'teardown_allocation_unresolved');
    const calls = stubHetzner();

    const response = await operatorDeletion(cookie, seeded.nodeId);
    expect(response.status).toBe(409);
    expect(calls).toEqual([]);
    expect((await readNode(seeded.nodeId))?.runtime_termination_confirmed_at).toBeNull();
  });

  it('refuses when the refusal changed since the operator looked, and changes nothing', async () => {
    const cookie = await signIn(`op-del-admin-stale-${Date.now()}`, 'superadmin');
    const seeded = await seedStrandedPlatformNode('stale-reason');
    await resavePlatformCredential(seeded.nodeId);
    await recordBlock(seeded.nodeId, 'teardown_credential_unavailable');
    const calls = stubHetzner();
    const before = await readNode(seeded.nodeId);

    const response = await operatorDeletion(cookie, seeded.nodeId, {
      confirmation: seeded.nodeId,
      // Shown in the dialog before cleanup re-recorded a different (also removable) refusal.
      expectedBlockedReason: 'teardown_credential_generation_changed',
      note: 'checked',
    });
    expect(response.status).toBe(409);
    expect(calls).toEqual([]);
    expect(await readNode(seeded.nodeId)).toEqual(before);
  });

  it('refuses in the final write when a Cloudflare build reserved the node after the route check', async () => {
    const seeded = await seedStrandedPlatformNode('build-reserved');
    await resavePlatformCredential(seeded.nodeId);
    await recordBlock(seeded.nodeId);
    const suffix = seeded.nodeId;
    await seedInstallation(`inst-${suffix}`, seeded.ownerId);
    await seedProject(`proj-${suffix}`, seeded.ownerId, `inst-${suffix}`);
    await env.DATABASE.prepare(
      `INSERT INTO deployment_environments (id, project_id, name, status, node_id, created_by_user_id)
       VALUES (?, ?, 'production', 'active', ?, ?)`
    )
      .bind(`env-${suffix}`, `proj-${suffix}`, seeded.nodeId, seeded.ownerId)
      .run();
    // Reserved between the route's precheck and the proof: drive the service directly.
    await env.DATABASE.prepare(
      `INSERT INTO deployment_publish_jobs
         (id, project_id, environment_id, workspace_id, node_id, requested_by,
          environment_name, executor, executor_instance_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'ws-none', ?, ?, 'production', 'cloudflare', 'cf-instance', 'building', ?, ?)`
    )
      .bind(
        `job-${suffix}`,
        `proj-${suffix}`,
        `env-${suffix}`,
        seeded.nodeId,
        seeded.ownerId,
        new Date().toISOString(),
        new Date().toISOString()
      )
      .run();
    stubHetzner();
    const before = await readNode(seeded.nodeId);

    await expect(
      recordOperatorNodeDeletion(drizzle(env.DATABASE, { schema }), TEST_ENV, {
        nodeId: seeded.nodeId,
        operatorUserId: seeded.ownerId,
        confirmation: seeded.nodeId,
        expectedBlockedReason: await currentBlockedReason(seeded.nodeId),
        note: 'checked',
        agentSignIn: false,
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await readNode(seeded.nodeId)).toEqual(before);
    expect(await auditOutcomes(seeded.nodeId)).toEqual(['attested', 'refused']);
  });

  it('asks to retry when a SAM credential exists but cannot be read', async () => {
    const cookie = await signIn(`op-del-admin-unreadable-${Date.now()}`, 'superadmin');
    const seeded = await seedStrandedPlatformNode('unreadable-platform');
    await recordBlock(seeded.nodeId, 'teardown_credential_generation_changed');
    // The node's own platform credential was re-saved into something that no longer decrypts.
    await env.DATABASE.prepare(
      `UPDATE platform_credentials SET encrypted_token = 'garbled', iv = 'garbled', updated_at = ?
        WHERE id = ?`
    )
      .bind(new Date(Date.now() + 1000).toISOString(), `${seeded.nodeId}-proof-credential`)
      .run();
    // The owner has a readable credential of their own, which must not stand in for SAM's.
    await env.DATABASE.prepare(
      `INSERT INTO credentials
         (id, user_id, project_id, credential_type, credential_kind, agent_type, provider,
          encrypted_token, iv, is_active, created_at, updated_at)
       VALUES (?, ?, NULL, 'cloud-provider', 'api-key', NULL, 'hetzner', ?, ?, 1,
               datetime('now'), datetime('now'))`
    )
      .bind(
        `owner-cred-${seeded.nodeId}`,
        seeded.ownerId,
        ...(await (async () => {
          const t = await encrypt('hetzner-owner-token', getCredentialEncryptionKey(TEST_ENV));
          return [t.ciphertext, t.iv];
        })())
      )
      .run();
    // Only this node's platform credential may exist for the duration of this case.
    const others = (
      await env.DATABASE.prepare(
        `SELECT id FROM platform_credentials WHERE is_enabled = 1 AND id != ?`
      )
        .bind(`${seeded.nodeId}-proof-credential`)
        .all<{ id: string }>()
    ).results.map((row) => row.id);
    for (const id of others) {
      await env.DATABASE.prepare('UPDATE platform_credentials SET is_enabled = 0 WHERE id = ?')
        .bind(id)
        .run();
    }
    try {
      const calls = stubHetzner();
      const before = await readNode(seeded.nodeId);
      const response = await operatorDeletion(cookie, seeded.nodeId);
      expect(response.status).toBe(503);
      expect(calls).toEqual([]);
      expect(await readNode(seeded.nodeId)).toEqual(before);
    } finally {
      for (const id of others) {
        await env.DATABASE.prepare('UPDATE platform_credentials SET is_enabled = 1 WHERE id = ?')
          .bind(id)
          .run();
      }
    }
  });

  it('refuses an agent sign-in session by default, and accepts it once the installation opts in', async () => {
    const operatorId = `op-del-admin-agent-${Date.now()}`;
    await signIn(operatorId, 'superadmin');
    const seeded = await seedStrandedPlatformNode('agent-session');
    await resavePlatformCredential(seeded.nodeId);
    await recordBlock(seeded.nodeId);
    const calls = stubHetzner();
    const before = await readNode(seeded.nodeId);
    const attest = async () =>
      recordOperatorNodeDeletion(drizzle(env.DATABASE, { schema }), TEST_ENV, {
        nodeId: seeded.nodeId,
        operatorUserId: operatorId,
        confirmation: seeded.nodeId,
        expectedBlockedReason: await currentBlockedReason(seeded.nodeId),
        note: 'relayed the owner console check',
        agentSignIn: true,
      });

    __resetAdminSettingsCacheForTest();
    await expect(attest()).rejects.toMatchObject({ statusCode: 403 });
    // Refused before anything else: no provider call, no audit row, nothing changed.
    expect(calls).toEqual([]);
    expect(await auditOutcomes(seeded.nodeId)).toEqual([]);
    expect(await readNode(seeded.nodeId)).toEqual(before);

    await updateAdminSettings(TEST_ENV, {
      actorUserId: operatorId,
      changes: [{ name: 'operations.operatorNodeDeletionAllowAgentSessions', value: true }],
    });
    try {
      const proof = await attest();
      expect(proof.runtimeTerminationConfirmedAt).toEqual(expect.any(String));
      const audit = await env.DATABASE.prepare(
        `SELECT json_extract(detail, '$.agentSignIn') AS agent FROM operations_audit_log
          WHERE target_id = ?`
      )
        .bind(seeded.nodeId)
        .first<{ agent: number }>();
      expect(audit?.agent).toBe(1);
    } finally {
      await updateAdminSettings(TEST_ENV, {
        actorUserId: operatorId,
        changes: [{ name: 'operations.operatorNodeDeletionAllowAgentSessions', value: false }],
      });
      __resetAdminSettingsCacheForTest();
    }
  });

  it('changes nothing when the audit entry cannot be written', async () => {
    const cookie = await signIn(`op-del-admin-noaudit-${Date.now()}`, 'superadmin');
    const seeded = await seedStrandedPlatformNode('audit-down');
    await resavePlatformCredential(seeded.nodeId);
    await recordBlock(seeded.nodeId);
    stubHetzner();
    const before = await readNode(seeded.nodeId);
    await env.DATABASE.prepare(
      'ALTER TABLE operations_audit_log RENAME TO operations_audit_log_down'
    ).run();
    try {
      const response = await operatorDeletion(cookie, seeded.nodeId);
      expect(response.status).toBe(503);
      expect(await readNode(seeded.nodeId)).toEqual(before);
    } finally {
      await env.DATABASE.prepare(
        'ALTER TABLE operations_audit_log_down RENAME TO operations_audit_log'
      ).run();
    }
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
      expectedBlockedReason: await currentBlockedReason(seeded.nodeId),
      note: 'checked',
    });
    expect(wrongId.status).toBe(400);
    const noNote = await operatorDeletion(cookie, seeded.nodeId, {
      confirmation: seeded.nodeId,
      expectedBlockedReason: await currentBlockedReason(seeded.nodeId),
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
    await recordBlock(userCapacity.nodeId);
    // Still in its first teardown attempt: not stuck, so not listed.
    const notYetBlocked = await seedStrandedPlatformNode('list-unblocked');
    const liveReason = await seedStrandedPlatformNode('list-live-reason');
    await recordBlock(liveReason.nodeId, 'teardown_deletion_unconfirmed');

    const response = await app.request(
      '/api/admin/nodes/stranded?limit=200',
      { headers: { Cookie: cookie } },
      TEST_ENV
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      nodes: Array<{
        id: string;
        cleanupBlockedReason: string | null;
        ownerEmail: string | null;
        operatorRemovable: boolean;
      }>;
      total: number;
    };
    const ids = body.nodes.map((node) => node.id);
    expect(ids).toContain(platform.nodeId);
    expect(ids).toContain(liveReason.nodeId);
    expect(ids).not.toContain(userCapacity.nodeId);
    expect(ids).not.toContain(notYetBlocked.nodeId);
    expect(body.nodes.find((node) => node.id === liveReason.nodeId)).toMatchObject({
      operatorRemovable: false,
    });
    expect(body.total).toBeGreaterThanOrEqual(body.nodes.length);
    expect(body.nodes.find((node) => node.id === platform.nodeId)).toMatchObject({
      operatorRemovable: true,
      cleanupBlockedReason: 'teardown_credential_generation_changed',
      ownerEmail: `${platform.ownerId}@test.com`,
    });
  });
});

describe('stranded-node routes through the real worker mount', () => {
  it('refuses a non-superadmin and serves a superadmin through the combined app', async () => {
    const api = `https://api.${(env as unknown as Env).BASE_DOMAIN}`;
    const stranger = await signIn(`op-del-self-user-${Date.now()}`, 'user');
    const admin = await signIn(`op-del-self-admin-${Date.now()}`, 'superadmin');
    const refused = await SELF.fetch(`${api}/api/admin/nodes/stranded`, {
      headers: { Cookie: stranger },
    });
    expect(refused.status).toBe(403);
    const refusedAction = await SELF.fetch(`${api}/api/admin/nodes/any-node/operator-deletion`, {
      method: 'POST',
      headers: { Cookie: stranger, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'any-node', expectedBlockedReason: null, note: 'x' }),
    });
    expect(refusedAction.status).toBe(403);
    const served = await SELF.fetch(`${api}/api/admin/nodes/stranded`, {
      headers: { Cookie: admin },
    });
    expect(served.status).toBe(200);
    await expect(served.json()).resolves.toMatchObject({ total: expect.any(Number) });
  });
});
