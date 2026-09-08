import { Hono } from 'hono';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { crudRoutes } from '../../../src/routes/workspaces/crud';
import { lifecycleRoutes } from '../../../src/routes/workspaces/lifecycle';
import { registerWorkspaceCreateRoute } from '../../../src/routes/workspaces/workspace-create';
import { clearCapacityCatalogCache } from '../../../src/services/default-capacity-source-credentials';
import { encrypt } from '../../../src/services/encryption';
import { signCallbackToken } from '../../../src/services/jwt';
import { type Fixture, fixture } from './node-pool-upgrade-test-helpers';

vi.mock('../../../src/middleware/auth', () => ({
  getUserId: () => 'user-1',
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getAuth: () => ({
    user: {
      id: 'user-1',
      name: 'User One',
      email: 'user-1@example.com',
      role: 'user',
      status: 'active',
    },
  }),
}));
vi.mock('../../../src/routes/projects/_helpers', async (load) => ({
  ...(await load<typeof import('../../../src/routes/projects/_helpers')>()),
  requireRepositoryUserAccess: vi.fn(async () => undefined),
}));

// The shared fixture replaces auth/repository access and DO transport only.
// Provisioning, native authority, final SQL attachment and compute writes are real.
let keys: { JWT_PRIVATE_KEY: string; JWT_PUBLIC_KEY: string };
beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  keys = {
    JWT_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
    JWT_PUBLIC_KEY: await exportSPKI(pair.publicKey),
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearCapacityCatalogCache();
});

async function createMeteringFixture(options: {
  rejectProvider?: boolean;
  cleanupClaimed?: boolean;
  reassignWorkspace?: boolean;
} = {}) {
  const f = fixture();
  const projectStub = f.env.PROJECT_DATA.get(f.env.PROJECT_DATA.idFromName('project-1'));
  Object.assign(projectStub, { recordActivityEvent: vi.fn(async () => 'activity-1') });
  const encryptionKey = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
  Object.assign(f.env, keys, {
    ENCRYPTION_KEY: encryptionKey,
    CF_ZONE_ID: 'test-zone',
    CF_API_TOKEN: 'test-dns-token',
    NODE_AGENT_READY_TIMEOUT_MS: '200',
    NODE_AGENT_READY_POLL_INTERVAL_MS: '200',
  });
  const secret = await encrypt('test-provider-token', encryptionKey);
  f.sqlite
    .prepare('UPDATE credentials SET encrypted_token = ?, iv = ? WHERE id = ?')
    .run(secret.ciphertext, secret.iv, 'cloud');
  if (options.cleanupClaimed) {
    f.sqlite.exec(`CREATE TRIGGER claim_failed_node_cleanup AFTER UPDATE OF status ON nodes
      WHEN NEW.status = 'error'
      BEGIN UPDATE nodes SET status = 'destroying' WHERE id = NEW.id; END`);
  }
  const serverType = {
    id: 1,
    name: 'cx23',
    description: 'CX23',
    cores: 2,
    memory: 4,
    disk: 40,
    architecture: 'x86',
    cpu_type: 'shared',
    deprecated: false,
    prices: [
      {
        location: 'fsn1',
        price_hourly: { net: '0.0048', gross: '0.0048' },
        price_monthly: { net: '3.99', gross: '3.99' },
      },
    ],
  };
  let releaseHealth!: (response: Response) => void;
  const blockedHealth = new Promise<Response>((resolve) => {
    releaseHealth = resolve;
  });
  let healthEntered!: () => void;
  const healthRequested = new Promise<void>((resolve) => {
    healthEntered = resolve;
  });
  const providerCreates: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('api.hetzner.cloud/v1/server_types')) {
        return Response.json({
          server_types: [serverType],
          meta: { pagination: { next_page: null } },
        });
      }
      if (url.endsWith('/servers') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        providerCreates.push(body);
        if (options.rejectProvider) {
          if (options.reassignWorkspace) {
            f.sqlite.prepare("UPDATE workspaces SET user_id = 'owner' WHERE user_id = 'user-1'").run();
          }
          return Response.json({ error: { code: 'placement_error', message: 'No capacity in selected location' } }, { status: 412 });
        }
        return Response.json({
          server: {
            id: 321,
            name: body.name,
            status: 'running',
            created: '2026-09-08T00:00:00Z',
            public_net: { ipv4: { ip: '203.0.113.2' } },
            server_type: serverType,
            labels: body.labels,
          },
        });
      }
      if (url.includes('api.cloudflare.com/client/v4/zones/test-zone/dns_records')) {
        return Response.json({ success: true, result: { id: 'dns-host' } });
      }
      if (url.endsWith('/health')) {
        healthEntered();
        return blockedHealth;
      }
      throw new Error(`Unexpected external HTTP: ${init?.method ?? 'GET'} ${url}`);
    })
  );
  clearCapacityCatalogCache();
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as never)
      : c.json({ error: error.message }, 500)
  );
  registerWorkspaceCreateRoute(app);
  app.route('/', lifecycleRoutes);
  app.route('/cleanup', crudRoutes);
  const pending: Promise<unknown>[] = [];
  const executionContext = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
  const response = await app.request(
    '/',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Metered fresh workspace',
        projectId: 'project-1',
        vmLocation: 'fsn1',
      }),
    },
    f.env,
    executionContext
  );
  const result = (await response.json()) as { id: string };
  expect(response.status, JSON.stringify(result)).toBe(201);
  if (options.rejectProvider) await Promise.all(pending);
  else await Promise.race([
    healthRequested,
    Promise.all(pending).then(() => {
      throw new Error('Provisioning finished without reaching readiness');
    }),
  ]);
  return {
    f,
    app,
    pending,
    executionContext,
    workspaceId: result.id,
    providerCreates,
    releaseHealth,
  };
}

function usage(f: Fixture, workspaceId: string) {
  return f.sqlite
    .prepare(
      `SELECT workspace_id, node_id, vcpu_count, provider_instance_type,
    provider_instance_vcpu_count, observed_provider_instance_vcpu_count, observed_hardware_source,
    provider_instance_price_hourly_micros, started_at, ended_at FROM compute_usage WHERE workspace_id = ?`
    )
    .all(workspaceId) as Array<Record<string, unknown>>;
}

describe('fresh workspace metering through registered HTTP and real SQL', () => {
  it('retains authoritative pre-attach failure proof so DELETE completes without a node', async () => {
    const { f, app, workspaceId, providerCreates } = await createMeteringFixture({ rejectProvider: true });
    expect(providerCreates).toHaveLength(2);
    expect(providerCreates.every((request) => request.location === 'fsn1')).toBe(true);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS count FROM nodes').get()).toEqual({ count: 0 });
    expect(usage(f, workspaceId)).toEqual([]);
    expect(f.sqlite.prepare(`SELECT status, node_id, runtime_deletion_proof, runtime_deletion_confirmed_at
      FROM workspaces WHERE id = ?`).get(workspaceId)).toEqual({
      status: 'error', node_id: null, runtime_deletion_proof: 'workspace_never_started',
      runtime_deletion_confirmed_at: expect.any(String),
    });
    expect(f.sqlite.prepare('SELECT status FROM tasks WHERE workspace_id = ?').get(workspaceId))
      .toEqual({ status: 'failed' });
    const response = await app.request(`/cleanup/${workspaceId}`, { method: 'DELETE' }, f.env);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ success: true, deletionStatus: 'confirmed' });
    expect(f.sqlite.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId)).toBeUndefined();
  }, 15_000);

  it('does not invent absence proof when another cleanup owns the failed node', async () => {
    const { f, app, workspaceId } = await createMeteringFixture({ rejectProvider: true, cleanupClaimed: true });
    expect(f.sqlite.prepare('SELECT status FROM nodes').get()).toEqual({ status: 'destroying' });
    expect(f.sqlite.prepare(`SELECT status, runtime_deletion_proof, runtime_deletion_confirmed_at
      FROM workspaces WHERE id = ?`).get(workspaceId)).toEqual({
      status: 'error', runtime_deletion_proof: null, runtime_deletion_confirmed_at: null,
    });
    const response = await app.request(`/cleanup/${workspaceId}`, { method: 'DELETE' }, f.env);
    expect(response.status).toBe(202);
    expect(f.sqlite.prepare('SELECT status FROM workspaces WHERE id = ?').get(workspaceId))
      .toEqual({ status: 'stopping' });
  }, 15_000);

  it('does not mark a reassigned placeholder failed or attach old cleanup proof to its new owner', async () => {
    const { f, workspaceId } = await createMeteringFixture({ rejectProvider: true, reassignWorkspace: true });
    expect(f.sqlite.prepare(`SELECT status, user_id, runtime_deletion_proof, runtime_deletion_confirmed_at
      FROM workspaces WHERE id = ?`).get(workspaceId)).toEqual({
      status: 'creating', user_id: 'owner', runtime_deletion_proof: null, runtime_deletion_confirmed_at: null,
    });
    expect(f.sqlite.prepare('SELECT status FROM tasks WHERE workspace_id = ?').get(workspaceId))
      .toEqual({ status: 'in_progress' });
  }, 15_000);

  it('persists native usage before readiness completes and closes it on readiness failure', async () => {
    const control = await createMeteringFixture();
    try {
      const { f, workspaceId, providerCreates } = control;
      const workspace = f.sqlite
        .prepare('SELECT node_id, status FROM workspaces WHERE id = ?')
        .get(workspaceId) as { node_id: string; status: string };
      expect(workspace.status).toBe('creating');
      expect(workspace.node_id).toEqual(expect.any(String));
      expect(providerCreates).toHaveLength(1);
      expect(providerCreates[0]).toMatchObject({ server_type: 'cx23', location: 'fsn1' });
      expect(usage(f, workspaceId)).toEqual([
        expect.objectContaining({
          workspace_id: workspaceId,
          node_id: workspace.node_id,
          vcpu_count: 2,
          provider_instance_type: 'cx23',
          provider_instance_vcpu_count: 2,
          observed_provider_instance_vcpu_count: 2,
          observed_hardware_source: 'observed',
          provider_instance_price_hourly_micros: 4_800,
          ended_at: null,
        }),
      ]);
    } finally {
      control.releaseHealth(new Response('not ready', { status: 503 }));
      await Promise.all(control.pending);
    }
    expect(usage(control.f, control.workspaceId)).toEqual([
      expect.objectContaining({ ended_at: expect.any(String) }),
    ]);
    expect(
      control.f.sqlite
        .prepare('SELECT status FROM workspaces WHERE id = ?')
        .get(control.workspaceId)
    ).toEqual({ status: 'error' });
  });

  it('closes early usage through the real provisioning-failure callback while readiness is pending', async () => {
    const control = await createMeteringFixture();
    try {
      expect(usage(control.f, control.workspaceId)).toHaveLength(1);
      const callback = await control.app.request(
        `/${control.workspaceId}/provisioning-failed`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${await signCallbackToken(control.workspaceId, control.f.env)}`,
          },
          body: JSON.stringify({ errorMessage: 'Cloud-init failed' }),
        },
        control.f.env,
        control.executionContext
      );
      expect(callback.status, await callback.text()).toBe(200);
      expect(usage(control.f, control.workspaceId)).toEqual([
        expect.objectContaining({ ended_at: expect.any(String) }),
      ]);
    } finally {
      control.releaseHealth(new Response('not ready', { status: 503 }));
      await Promise.all(control.pending);
    }
    expect(
      control.f.sqlite
        .prepare('SELECT status, error_message FROM workspaces WHERE id = ?')
        .get(control.workspaceId)
    ).toEqual({ status: 'error', error_message: 'Cloud-init failed' });
  });

  it('keeps a concurrently running workspace metered when the late readiness check fails', async () => {
    const control = await createMeteringFixture();
    try {
      const callback = await control.app.request(
        `/${control.workspaceId}/ready`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${await signCallbackToken(control.workspaceId, control.f.env)}`,
          },
          body: JSON.stringify({ status: 'running' }),
        },
        control.f.env,
        control.executionContext
      );
      expect(callback.status, await callback.text()).toBe(200);
    } finally {
      control.releaseHealth(new Response('not ready', { status: 503 }));
      await Promise.all(control.pending);
    }
    expect(
      control.f.sqlite
        .prepare('SELECT status, error_message FROM workspaces WHERE id = ?')
        .get(control.workspaceId)
    ).toEqual({ status: 'running', error_message: null });
    expect(usage(control.f, control.workspaceId)).toEqual([
      expect.objectContaining({ ended_at: null }),
    ]);
  });

  it('does not resurrect a concurrently deleted workspace or reopen its usage on late failure', async () => {
    const control = await createMeteringFixture();
    const deletedAt = new Date().toISOString();
    control.f.sqlite
      .prepare(
        "UPDATE workspaces SET status = 'deleted', runtime_deletion_confirmed_at = ? WHERE id = ?"
      )
      .run(deletedAt, control.workspaceId);
    control.f.sqlite
      .prepare('UPDATE compute_usage SET ended_at = ? WHERE workspace_id = ?')
      .run(deletedAt, control.workspaceId);
    control.releaseHealth(new Response('not ready', { status: 503 }));
    await Promise.all(control.pending);

    expect(
      control.f.sqlite
        .prepare('SELECT status, error_message FROM workspaces WHERE id = ?')
        .get(control.workspaceId)
    ).toEqual({ status: 'deleted', error_message: null });
    expect(usage(control.f, control.workspaceId)).toEqual([
      expect.objectContaining({ ended_at: deletedAt }),
    ]);
  });
});
