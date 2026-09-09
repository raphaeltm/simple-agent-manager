/** Registered HTTP -> real NodeLifecycle RPC/alarm/storage -> provider HTTP -> migrated D1. */
import { makeSignature } from 'better-auth/crypto';
import { env, runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NodeLifecycle } from '../../src/durable-objects/node-lifecycle';
import {
  DIRECT_PROVISIONING_KEY,
  type DirectProvisioningIntent,
} from '../../src/durable-objects/node-lifecycle-provisioning';
import type { Env } from '../../src/env';
import { nodesRoutes } from '../../src/routes/nodes';
import { registerWorkspaceCreateRoute } from '../../src/routes/workspaces/workspace-create';
import { clearCapacityCatalogCache } from '../../src/services/default-capacity-source-credentials';
import { encrypt } from '../../src/services/encryption';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

afterEach(() => {
  vi.unstubAllGlobals();
  clearCapacityCatalogCache();
});

async function setup(interrupt: boolean, interruptDispatch = false, directNode = false) {
  const userId = 'durable-user-' + crypto.randomUUID();
  const projectId = 'durable-project-' + crypto.randomUUID();
  const installationId = 'durable-install-' + crypto.randomUUID();
  await seedUser(userId);
  await seedInstallation(installationId, userId);
  await seedProject(projectId, userId, installationId);
  await env.DATABASE.prepare(
    `UPDATE projects SET repo_provider='artifacts',default_provider='hetzner',default_location='fsn1',default_vm_size='small' WHERE id=?`
  )
    .bind(projectId)
    .run();
  await env.DATABASE.prepare("UPDATE users SET status='active' WHERE id=?").bind(userId).run();
  const token = crypto.randomUUID();
  await env.DATABASE.prepare(
    `INSERT INTO sessions(id,expires_at,token,created_at,updated_at,user_id) VALUES(?,?,?,?,?,?)`
  )
    .bind('session-' + userId, Date.now() + 3600000, token, Date.now(), Date.now(), userId)
    .run();
  const cookie = `__Secure-better-auth.session_token=${token}.${await makeSignature(
    token,
    (env as unknown as Env).BETTER_AUTH_SECRET || (env as unknown as Env).ENCRYPTION_KEY
  )}`;
  const secret = await encrypt('provider-test-token', (env as unknown as Env).ENCRYPTION_KEY);
  await env.DATABASE.prepare(
    `INSERT INTO credentials(id,user_id,provider,credential_type,credential_kind,is_active,encrypted_token,iv,created_at,updated_at)
    VALUES(?,?,'hetzner','cloud-provider','api-key',1,?,?,?,?)`
  )
    .bind(
      'credential-' + userId,
      userId,
      secret.ciphertext,
      secret.iv,
      new Date().toISOString(),
      new Date().toISOString()
    )
    .run();
  const overrides = {
    ENVIRONMENT: 'test',
    SAM_INSTALLATION_ID: '0123456789abcdef0123456789abcdef',
    CF_ZONE_ID: 'durable-zone',
    CF_API_TOKEN: 'durable-dns-test',
    NODE_PROVISIONING_REQUEST_TIMEOUT_MS: '3000',
    NODE_PROVISIONING_RETRY_INTERVAL_MS: '30000',
    COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
  };
  let stub!: DurableObjectStub<NodeLifecycle>;
  const testEnv = {
    ...env,
    ...overrides,
    NODE_LIFECYCLE: {
      idFromName: (name: string) => env.NODE_LIFECYCLE.idFromName(name),
      get: (id: DurableObjectId) => {
        stub = env.NODE_LIFECYCLE.get(id) as DurableObjectStub<NodeLifecycle>;
        return {
          startProvisioning: async (input: Parameters<NodeLifecycle['startProvisioning']>[0]) => {
            await runInDurableObject(stub, async (instance) => {
              Object.assign((instance as unknown as { env: Env }).env, overrides);
            });
            await stub.startProvisioning(input);
          },
        };
      },
    },
  } as unknown as Env;
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
  const creates: Record<string, unknown>[] = [];
  const inventory: Record<string, unknown>[] = [];
  const dispatches: Record<string, unknown>[] = [];
  const logicalWorkspaces = new Set<string>();
  let release!: () => void;
  const providerResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/server_types'))
        return Response.json({
          server_types: [serverType],
          meta: { pagination: { next_page: null } },
        });
      if (url.endsWith('/servers') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        creates.push(body);
        const server = {
          id: 9876,
          name: body.name,
          status: 'running',
          created: new Date().toISOString(),
          public_net: { ipv4: { ip: '203.0.113.50' } },
          server_type: serverType,
          location: { name: body.location },
          labels: body.labels,
        };
        inventory.push(server);
        if (interrupt) throw new TypeError('lost successful provider response');
        await providerResponse;
        return Response.json({ server });
      }
      if (url.includes('/servers?'))
        return Response.json({ servers: inventory, meta: { pagination: { next_page: null } } });
      if (url.includes('/dns_records?')) return Response.json({ success: true, result: [] });
      if (url.includes('/dns_records'))
        return Response.json({ success: true, result: { id: 'durable-dns' } });
      if (url.endsWith('/health')) return Response.json({ status: 'ok' });
      if (url.endsWith('/workspaces') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        dispatches.push(body);
        logicalWorkspaces.add(body.workspaceId);
        if (interruptDispatch && dispatches.length === 1)
          throw new TypeError('lost successful dispatch response');
        return Response.json({ workspaceId: body.workspaceId, status: 'creating' });
      }
      throw new Error(`Unexpected external boundary: ${init?.method ?? 'GET'} ${url}`);
    })
  );
  clearCapacityCatalogCache();
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) => c.json({ error: error.message }, 500));
  registerWorkspaceCreateRoute(app);
  app.route('/nodes', nodesRoutes);
  const requestBackground: Promise<unknown>[] = [];
  const response = await app.request(
    directNode ? 'https://api.test.example.com/nodes' : 'https://api.test.example.com/',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: 'Durable create',
        // Keep the durable-lifetime scenario on a fitting 2 GiB reservation:
        // the sole 4 GiB offering cannot fit the default medium plus host reserve.
        ...(directNode ? { vmSize: 'small' } : { projectId }),
        vmLocation: 'fsn1',
      }),
    },
    testEnv,
    {
      waitUntil: (promise: Promise<unknown>) => requestBackground.push(promise),
      passThroughOnException() {},
    } as unknown as ExecutionContext
  );
  const body = (await response.json()) as { id: string; error?: string };
  expect(response.status, body.error).toBe(201);
  await Promise.all(requestBackground);
  async function tick() {
    await runInDurableObject(stub, async (instance, state) => {
      const intent = await state.storage.get<DirectProvisioningIntent>(DIRECT_PROVISIONING_KEY);
      if (intent?.status === 'pending')
        await state.storage.put(DIRECT_PROVISIONING_KEY, { ...intent, nextAttemptAt: 0 });
      await instance.alarm();
    });
  }
  async function intent() {
    return runInDurableObject(stub, (_instance, state) =>
      state.storage.get<DirectProvisioningIntent>(DIRECT_PROVISIONING_KEY)
    );
  }
  return {
    userId,
    workspaceId: body.id,
    stub,
    creates,
    dispatches,
    logicalWorkspaces,
    release,
    tick,
    intent,
  };
}

describe('durable direct workspace allocation', () => {
  it('finishes native attachment, priced usage and dispatch after the HTTP request background work has ended', async () => {
    const f = await setup(false);
    await f.tick();
    await vi.waitFor(() => expect(f.creates).toHaveLength(1));
    expect(
      await env.DATABASE.prepare('SELECT node_id FROM workspaces WHERE id=?')
        .bind(f.workspaceId)
        .first()
    ).toEqual({ node_id: null });
    f.release();
    await vi.waitFor(async () => expect((await f.intent())?.status).toBe('complete'), {
      timeout: 5000,
    });
    expect(f.dispatches).toHaveLength(1);
    expect(
      await env.DATABASE.prepare(
        `SELECT n.provider_instance_id,u.provider_instance_type,u.vcpu_count,
      u.provider_instance_price_hourly_micros,u.ended_at FROM workspaces w JOIN nodes n ON n.id=w.node_id
      JOIN compute_usage u ON u.workspace_id=w.id WHERE w.id=?`
      )
        .bind(f.workspaceId)
        .first()
    ).toEqual({
      provider_instance_id: '9876',
      provider_instance_type: 'cx23',
      vcpu_count: 2,
      provider_instance_price_hourly_micros: 4800,
      ended_at: null,
    });
    await f.tick();
    expect(f.creates).toHaveLength(1);
    expect(f.dispatches).toHaveLength(1);
  });

  it('hands direct node POST to the same durable allocation boundary after its HTTP background owner ends', async () => {
    const f = await setup(false, false, true);
    if ((await f.intent())?.attempts === 0) await f.tick();
    await vi.waitFor(() => expect(f.creates).toHaveLength(1));
    expect(
      await env.DATABASE.prepare('SELECT provider_instance_id FROM nodes WHERE id=?')
        .bind(f.workspaceId)
        .first()
    ).toEqual({ provider_instance_id: null });
    f.release();
    await vi.waitFor(async () => expect((await f.intent())?.status).toBe('complete'), {
      timeout: 5000,
    });
    expect(
      await env.DATABASE.prepare('SELECT provider_instance_id,status FROM nodes WHERE id=?')
        .bind(f.workspaceId)
        .first()
    ).toEqual({ provider_instance_id: '9876', status: 'running' });
    expect(f.creates).toHaveLength(1);
    expect(f.dispatches).toHaveLength(0);
  });

  it('resumes a persisted uncertain allocation by exact incarnation without issuing another paid create', async () => {
    const f = await setup(true);
    if ((await f.intent())?.attempts === 0) await f.tick();
    await vi.waitFor(async () => expect((await f.intent())?.lastError).toMatch(/unresolved/));
    await runInDurableObject(f.stub, async (instance) => {
      (instance as unknown as { provisioningController: unknown }).provisioningController =
        undefined;
    });
    await f.tick();
    await vi.waitFor(async () => expect((await f.intent())?.status).toBe('complete'), {
      timeout: 5000,
    });
    expect(f.creates).toHaveLength(1);
    expect(f.dispatches).toHaveLength(1);
    expect(
      await env.DATABASE.prepare('SELECT COUNT(*) AS count FROM compute_usage WHERE workspace_id=?')
        .bind(f.workspaceId)
        .first()
    ).toEqual({ count: 1 });
  });
  it('replays an accepted dispatch after losing its response and restarting the real DO controller', async () => {
    const f = await setup(false, true);
    f.release();
    if ((await f.intent())?.attempts === 0) await f.tick();
    await vi.waitFor(
      async () => expect((await f.intent())?.lastError).toMatch(/dispatch response/),
      { timeout: 5000 }
    );
    expect(
      await env.DATABASE.prepare('SELECT status,dispatched_at FROM workspaces WHERE id=?')
        .bind(f.workspaceId)
        .first()
    ).toEqual({ status: 'creating', dispatched_at: null });
    await runInDurableObject(f.stub, async (instance) => {
      (instance as unknown as { provisioningController: unknown }).provisioningController =
        undefined;
    });
    await f.tick();
    await vi.waitFor(async () => expect((await f.intent())?.status).toBe('complete'), {
      timeout: 5000,
    });
    expect(f.creates).toHaveLength(1);
    expect(f.dispatches).toHaveLength(2);
    expect(f.logicalWorkspaces.size).toBe(1);
    expect(
      await env.DATABASE.prepare('SELECT COUNT(*) AS count FROM compute_usage WHERE workspace_id=?')
        .bind(f.workspaceId)
        .first()
    ).toEqual({ count: 1 });
    expect(
      await env.DATABASE.prepare('SELECT dispatched_at FROM workspaces WHERE id=?')
        .bind(f.workspaceId)
        .first()
    ).toEqual({ dispatched_at: expect.any(String) });
  });
});
