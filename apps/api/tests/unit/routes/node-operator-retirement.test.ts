/**
 * A superadmin retires a node on SAM-managed (installation) capacity whose server is gone.
 *
 * Self-host box R1 (2026-11-12): seven installation-capacity rows sat at "operator recovery
 * required" with no VM behind them, and "I already deleted this server" answered 403 "This
 * server runs on SAM-managed capacity; contact an operator" even for the superadmin, who is the
 * only operator a self-hosted install has.
 *
 * Real SQL engine (the node-cleanup handoff fixture: migrated schema, a platform credential and
 * the node's exact provisioning binding), the real route handlers registered on nodesRoutes,
 * and the real HetznerProvider; only Hetzner's HTTP API is faked at fetch.
 */
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { nodesRoutes } from '../../../src/routes/nodes';
import { createDeclaredIndexes } from '../../helpers/sqlite-d1';
import { handoffFixture } from '../services/node-cleanup-handoff-fixture';

vi.mock('../../../src/services/jwt', () => ({
  signNodeCallbackToken: async () => 'test-token',
  signCurrentNodeCallbackToken: async () => 'test-token',
}));

type Fixture = Awaited<ReturnType<typeof handoffFixture>>;

/** The fixture with production's unique keys (the removal audit upserts on one) and labels. */
async function managedFixture(scope: 'user' | 'installation') {
  const f = await handoffFixture(scope);
  createDeclaredIndexes(f.sqlite, [schema.nodeHealthEvents]);
  // NodeLifecycle is a Durable Object; the removal tail only tells it the node is gone.
  const finalizeDeletion = vi.fn(async () => undefined);
  Object.assign(f.env, {
    NODE_LIFECYCLE: { idFromName: (id: string) => id, get: () => ({ finalizeDeletion }) },
  });
  f.sqlite
    .prepare(
      `UPDATE nodes SET status = 'destroying', health_status = 'stale',
         runtime_incarnation_id = 'incarnation-host' WHERE id = 'host'`
    )
    .run();
  return f;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function handlersFor(method: string, path: string) {
  return nodesRoutes.routes
    .filter((route) => route.method === method && route.path === path)
    .map((route) => route.handler);
}

async function confirm(
  f: Fixture,
  role: 'user' | 'superadmin',
  body: Record<string, unknown> = { confirmed: true },
  userId = 'user-1'
) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as never)
      : c.json({ error: 'INTERNAL', message: error.message }, 500)
  );
  app.use('*', async (c, next) => {
    c.set('auth', {
      user: {
        id: userId,
        email: `${userId}@test.com`,
        name: null,
        avatarUrl: null,
        role,
        status: 'active',
      },
      session: { id: null, token: null, expiresAt: new Date(Date.now() + 60_000) },
    } as never);
    await next();
  });
  // The exact handlers registered on nodesRoutes, including the body validator.
  app.post(
    '/nodes/:id/manual-deletion',
    ...(handlersFor('POST', '/:id/manual-deletion') as [never])
  );
  const response = await app.request(
    '/nodes/host/manual-deletion',
    { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } },
    f.env as unknown as Env
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The box's shape: an installation-capacity node SAM failed to delete, past its window. */
async function stuckInstallationNode() {
  const f = await managedFixture('installation');
  const host = f.sqlite
    .prepare(
      `SELECT placement_credential_source, cloud_provider, provider_instance_id, runtime, node_class, user_id, name
         FROM nodes WHERE id = 'host'`
    )
    .get() as Record<string, string>;
  // Precondition: this is SAM-managed capacity, the case the owner path refuses.
  expect(host).toMatchObject({
    placement_credential_source: 'platform',
    cloud_provider: 'hetzner',
    runtime: 'vm',
    node_class: 'managed',
    user_id: 'user-1',
  });
  return { f, host };
}

function nodeRow(f: Fixture) {
  return f.sqlite
    .prepare(
      `SELECT status, runtime_termination_confirmed_at, runtime_termination_attested_at
         FROM nodes WHERE id = 'host'`
    )
    .get() as Record<string, string | null> | undefined;
}

function auditRows(f: Fixture) {
  return f.sqlite
    .prepare(
      `SELECT actor_user_id, tool, target_type, target_id, outcome, detail
         FROM operations_audit_log WHERE target_id = 'host'`
    )
    .all() as Array<Record<string, string>>;
}

function unchanged(f: Fixture) {
  expect(nodeRow(f)).toMatchObject({
    status: 'destroying',
    runtime_termination_confirmed_at: null,
  });
  expect(auditRows(f)).toEqual([]);
  expect(f.providerDeletes).toEqual([]);
}

describe('superadmin retirement of a SAM-capacity node whose server is gone', () => {
  it('retires the row when the provider has no server with its exact labels, and audits who', async () => {
    const { f } = await stuckInstallationNode();
    const result = await confirm(f, 'superadmin');
    expect(result).toEqual({ status: 200, body: { success: true } });

    // Asked by the node's exact ownership labels and by its instance id; deleted nothing.
    expect(f.inventorySelectors).toEqual([
      expect.objectContaining({
        node: 'host',
        installation: '0123456789abcdef0123456789abcdef',
        incarnation: 'incarnation-host',
      }),
    ]);
    expect(f.providerGets.length).toBeGreaterThan(0);
    expect(f.providerDeletes).toEqual([]);

    // A workspace node's row is removed outright by the shared removal tail.
    expect(nodeRow(f)).toBeUndefined();
    const audit = auditRows(f);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_user_id: 'user-1',
      tool: 'node_operator_retire',
      target_type: 'node',
      outcome: 'succeeded',
    });
    expect(JSON.parse(audit[0]!.detail!)).toMatchObject({
      proof: 'provider_absent',
      ownerUserId: 'user-1',
      previousStatus: 'destroying',
      provider: 'hetzner',
    });
  });

  it('refuses while the provider still lists a server labelled for the node, with the reason', async () => {
    const { f } = await stuckInstallationNode();
    f.inventoryModeByNodeId.set('host', 'exact');
    // A typed name never overrides a server that is still there.
    const result = await confirm(f, 'superadmin', {
      confirmed: true,
      confirmNodeName: 'host',
    });
    expect(result.status).toBe(409);
    expect(result.body.message).toMatch(/hetzner still has server 123 labelled for this node/);
    unchanged(f);
  });

  it('refuses a non-superadmin owner exactly as before', async () => {
    const { f } = await stuckInstallationNode();
    const result = await confirm(f, 'user');
    expect(result.status).toBe(403);
    expect(result.body.message).toBe(
      'This server runs on SAM-managed capacity; contact an operator'
    );
    // Refused before SAM asks the provider anything.
    expect(f.inventorySelectors).toEqual([]);
    unchanged(f);
  });

  it("does not let a superadmin retire another user's node through this route", async () => {
    const { f } = await stuckInstallationNode();
    f.sqlite
      .prepare(`INSERT INTO users (id, email, role, status) VALUES ('admin-2', 'a2@test.com', 'superadmin', 'active')`)
      .run();
    const result = await confirm(f, 'superadmin', { confirmed: true }, 'admin-2');
    expect(result.status).toBe(404);
    unchanged(f);
  });

  it('asks to retry when the provider lookup fails, and changes nothing', async () => {
    const { f } = await stuckInstallationNode();
    f.rejectedInventoryNodeIds.add('host');
    const result = await confirm(f, 'superadmin');
    expect(result.status).toBe(503);
    unchanged(f);
  });

  it('refuses inside the provisioning window, where a create may still land', async () => {
    const { f } = await stuckInstallationNode();
    f.sqlite.prepare(`UPDATE nodes SET created_at = ?`).run(new Date().toISOString());
    const result = await confirm(f, 'superadmin');
    expect(result.status).toBe(409);
    expect(result.body.message).toMatch(/provisioning window/);
    expect(f.inventorySelectors).toEqual([]);
    unchanged(f);
  });

  describe('when the provider cannot be asked (no exact credential binding)', () => {
    async function unaskable() {
      const stuck = await stuckInstallationNode();
      stuck.f.sqlite
        .prepare(`UPDATE nodes SET placement_credential_reference = NULL`)
        .run();
      return stuck;
    }

    it('asks for the typed node name, and changes nothing without it', async () => {
      const { f, host } = await unaskable();
      const result = await confirm(f, 'superadmin');
      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({
        error: 'OPERATOR_CONFIRMATION_REQUIRED',
        details: { nodeName: host.name },
      });
      expect(f.inventorySelectors).toEqual([]);
      unchanged(f);
    });

    it('refuses a typed name that is not this node', async () => {
      const { f } = await unaskable();
      const result = await confirm(f, 'superadmin', {
        confirmed: true,
        confirmNodeName: 'some-other-node',
      });
      expect(result.status).toBe(409);
      expect(result.body.error).toBe('OPERATOR_CONFIRMATION_REQUIRED');
      unchanged(f);
    });

    it('retires the row after the operator types its name, and audits the typed confirmation', async () => {
      const { f, host } = await unaskable();
      const result = await confirm(f, 'superadmin', {
        confirmed: true,
        confirmNodeName: ` ${host.name} `,
      });
      expect(result).toEqual({ status: 200, body: { success: true } });
      expect(nodeRow(f)).toBeUndefined();
      expect(f.providerDeletes).toEqual([]);
      const audit = auditRows(f);
      expect(audit).toHaveLength(1);
      expect(JSON.parse(audit[0]!.detail!)).toMatchObject({
        proof: 'typed_confirmation',
        providerUnavailableReason: expect.stringContaining('exact provider credential binding is missing'),
      });
    });

    it('still refuses a non-superadmin who types the name', async () => {
      const { f, host } = await unaskable();
      const result = await confirm(f, 'user', { confirmed: true, confirmNodeName: host.name });
      expect(result.status).toBe(403);
      unchanged(f);
    });
  });
});

describe('a node on the user’s own cloud credential (control)', () => {
  it('keeps the owner path: no superadmin needed, no operator audit row', async () => {
    const f = await managedFixture('user');
    expect(
      f.sqlite.prepare(`SELECT placement_credential_source FROM nodes WHERE id = 'host'`).get()
    ).toEqual({ placement_credential_source: 'user' });
    const result = await confirm(f, 'user');
    expect(result).toEqual({ status: 200, body: { success: true } });
    expect(nodeRow(f)).toBeUndefined();
    expect(auditRows(f)).toEqual([]);
    // The owner path asks by instance id only, never the label inventory.
    expect(f.inventorySelectors).toEqual([]);
  });
});
