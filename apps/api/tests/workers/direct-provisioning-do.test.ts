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
import { crudRoutes } from '../../src/routes/workspaces/crud';
import { registerWorkspaceCreateRoute } from '../../src/routes/workspaces/workspace-create';
import { clearCapacityCatalogCache } from '../../src/services/default-capacity-source-credentials';
import { encrypt } from '../../src/services/encryption';
import { getSession } from '../../src/services/project-data';
import {
  attemptWorkspaceDeletion,
  loadWorkspaceDeletionIdentity,
} from '../../src/services/workspace-deletion';
import { seedInstallation, seedNode, seedProject, seedUser } from './helpers/seed-d1';

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
        const target = stub;
        return {
          confirmUnassignedWorkspaceDeletion: (
            identity: Parameters<NodeLifecycle['confirmUnassignedWorkspaceDeletion']>[0]
          ) => target.confirmUnassignedWorkspaceDeletion(identity),
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
  async function tick(onlyInitialAttempt = false) {
    await runInDurableObject(stub, async (instance, state) => {
      const intent = await state.storage.get<DirectProvisioningIntent>(DIRECT_PROVISIONING_KEY);
      // An automatically delivered first alarm can win the caller's read race.
      // Do not accidentally run recovery while building an interrupted-create fixture.
      if (onlyInitialAttempt && intent?.attempts !== 0) return;
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
    inventory,
    testEnv,
    cookie,
  };
}

async function orphanedDirectCreation() {
  const f = await setup(true);
  await f.tick(true);
  await vi.waitFor(async () => expect((await f.intent())?.lastError).toMatch(/unresolved/));
  const intent = (await f.intent())!;
  await runInDurableObject(f.stub, async (instance, state) => {
    await state.storage.put(DIRECT_PROVISIONING_KEY, {
      ...intent,
      createdAt: Date.now() - 60_000,
      status: 'unresolved',
      nextAttemptAt: null,
    });
    await state.storage.deleteAlarm();
    (instance as unknown as { provisioningController: unknown }).provisioningController = undefined;
  });
  await env.DATABASE.prepare('DELETE FROM nodes WHERE id=?').bind(intent.input.nodeId).run();
  await env.DATABASE.prepare("UPDATE workspaces SET status='stopping' WHERE id=?")
    .bind(f.workspaceId)
    .run();
  await env.DATABASE.prepare(
    `INSERT INTO node_health_events(id,node_id,episode_started_at,event,reason,created_at)
    VALUES(?,?,?,'deleted_by_owner','owner_requested_node_deletion',?)`
  )
    .bind(
      crypto.randomUUID(),
      intent.input.nodeId,
      new Date().toISOString(),
      new Date().toISOString()
    )
    .run();
  const survivingServer = f.inventory[0];
  f.inventory.splice(0);
  const identity = (await loadWorkspaceDeletionIdentity(env.DATABASE, f.workspaceId))!;
  return { ...f, identity, intentSnapshot: intent, survivingServer };
}

describe('explicit unassigned workspace deletion after host owner deletion', () => {
  it('keeps terminal intent sealed against start and alarm replay after confirmation and controller restart', async () => {
    const f = await orphanedDirectCreation();
    const sealed = await f.intent();
    expect(await f.stub.confirmUnassignedWorkspaceDeletion(f.identity)).toBe(true);
    for (const restart of [false, true]) {
      if (restart)
        await runInDurableObject(f.stub, async (instance) => {
          (instance as unknown as { provisioningController: unknown }).provisioningController =
            undefined;
        });
      await f.stub.startProvisioning(sealed!.input);
      await runInDurableObject(f.stub, (instance) => instance.alarm());
      expect(await f.intent()).toEqual(sealed);
      expect(
        await runInDurableObject(f.stub, (_instance, state) => state.storage.getAlarm())
      ).toBeNull();
    }
    expect(f.creates).toHaveLength(1);
    expect(f.dispatches).toHaveLength(0);
  });

  it('rejects proof while the provisioning controller has live work in flight', async () => {
    const f = await orphanedDirectCreation();
    // Set only the live-work flag: this isolates the guard without inventing a
    // provider timeout or leaving an unresolved network promise in the test pool.
    await runInDurableObject(f.stub, async (instance) => {
      const controller = (
        instance as unknown as {
          provisioning(): { inFlight: boolean };
        }
      ).provisioning();
      controller.inFlight = true;
    });
    const before = vi.mocked(fetch).mock.calls.length;
    expect(await f.stub.confirmUnassignedWorkspaceDeletion(f.identity)).toBe(false);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(before);
    await runInDurableObject(f.stub, async (instance) => {
      (instance as unknown as { provisioning(): { inFlight: boolean } }).provisioning().inFlight =
        false;
    });
    expect(await f.stub.confirmUnassignedWorkspaceDeletion(f.identity)).toBe(true);
  });

  it.each([false, true])(
    'uses the saved account, never a different empty account (saved missing: %s)',
    async (missing) => {
      const f = await orphanedDirectCreation();
      const second = await encrypt('different-account-token', f.testEnv.ENCRYPTION_KEY);
      await env.DATABASE.prepare(
        `INSERT INTO credentials(id,user_id,provider,credential_type,credential_kind,is_active,encrypted_token,iv,created_at,updated_at)
      VALUES(?,?,'hetzner','cloud-provider','api-key',1,?,?,?,?)`
      )
        .bind(
          'other-' + f.userId,
          f.userId,
          second.ciphertext,
          second.iv,
          new Date().toISOString(),
          new Date().toISOString()
        )
        .run();
      if (missing)
        await env.DATABASE.prepare('DELETE FROM credentials WHERE id=?')
          .bind('credential-' + f.userId)
          .run();
      const original = fetch;
      const inventoryAccounts: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
          if (!String(url).includes('/servers?')) return original(url, init);
          const account = new Headers(init?.headers).get('Authorization') ?? '';
          inventoryAccounts.push(account);
          const selector = new URL(String(url)).searchParams.get('label_selector');
          expect(selector).toBe(`node=${f.intentSnapshot.input.nodeId.toLowerCase()}`);
          return Response.json({
            servers: account === 'Bearer provider-test-token' ? [f.survivingServer] : [],
            meta: { pagination: { next_page: null } },
          });
        })
      );
      expect(await f.stub.confirmUnassignedWorkspaceDeletion(f.identity)).toBe(false);
      expect(inventoryAccounts).toEqual(missing ? [] : ['Bearer provider-test-token']);
      expect(f.creates).toHaveLength(1);
    }
  );

  it.each(
    ['environment', 'installation', 'missing-configuration'].flatMap((drift) =>
      [false, true].map((absent) => ({ drift, absent }))
    )
  )(
    'uses node-wide inventory despite current configuration drift: $drift / absent=$absent',
    async ({ drift, absent }) => {
      const f = await orphanedDirectCreation();
      await runInDurableObject(f.stub, async (instance) => {
        const current = (instance as unknown as { env: Env }).env;
        if (drift === 'environment') current.ENVIRONMENT = 'changed-environment';
        if (drift === 'installation')
          current.SAM_INSTALLATION_ID = 'fedcba9876543210fedcba9876543210';
        if (drift === 'missing-configuration') {
          delete current.ENVIRONMENT;
          delete current.SAM_INSTALLATION_ID;
        }
      });
      const original = fetch;
      const selectors: string[] = [];
      const accounts: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
          if (!String(url).includes('/servers?')) return original(url, init);
          const selector = new URL(String(url)).searchParams.get('label_selector') ?? '';
          selectors.push(selector);
          accounts.push(new Headers(init?.headers).get('Authorization') ?? '');
          // Model actual provider filtering: querying current deployment labels would
          // hide this original allocation and turn surviving inventory into false absence.
          const originalServer = f.survivingServer!;
          const labels = originalServer.labels as Record<string, string>;
          const matches = selector.split(',').every((term) => {
            const [key, value] = term.split('=');
            return labels[key!] === value;
          });
          return Response.json({
            servers: !absent && matches ? [originalServer] : [],
            meta: { pagination: { next_page: null } },
          });
        })
      );
      // Legacy saved intents have credential generation but no immutable deployment labels.
      expect(await f.stub.confirmUnassignedWorkspaceDeletion(f.identity)).toBe(absent);
      expect(selectors).toEqual([`node=${f.intentSnapshot.input.nodeId.toLowerCase()}`]);
      expect(accounts).toEqual(['Bearer provider-test-token']);
      expect(f.creates).toHaveLength(1);
      expect(f.dispatches).toHaveLength(0);
    }
  );

  it.each([true, false])(
    'authenticated HTTP DELETE confirms only absent inventory: %s',
    async (absent) => {
      const f = await orphanedDirectCreation();
      if (!absent) f.inventory.push(f.survivingServer!);
      const app = new Hono<{ Bindings: Env }>();
      app.route('/api/workspaces', crudRoutes);
      const background: Promise<unknown>[] = [];
      const response = await app.request(
        `https://api.test.example.com/api/workspaces/${f.workspaceId}`,
        {
          method: 'DELETE',
          headers: { Cookie: f.cookie },
        },
        { ...f.testEnv, NODE_LIFECYCLE: env.NODE_LIFECYCLE },
        {
          waitUntil: (promise: Promise<unknown>) => background.push(promise),
          passThroughOnException() {},
        } as unknown as ExecutionContext
      );
      expect(response.status, await response.clone().text()).toBe(absent ? 200 : 202);
      expect(await response.json()).toMatchObject({
        success: true,
        deletionStatus: absent ? 'confirmed' : 'pending',
      });
      await Promise.all(background);
      const row = await env.DATABASE.prepare(
        'SELECT status,runtime_deletion_confirmed_at FROM workspaces WHERE id=?'
      )
        .bind(f.workspaceId)
        .first();
      if (absent) {
        expect(row).toBeNull();
        expect(
          await getSession(f.testEnv, f.identity.projectId!, f.identity.chatSessionId!)
        ).toMatchObject({ status: 'stopped' });
      } else expect(row).toEqual({ status: 'stopping', runtime_deletion_confirmed_at: null });
      expect(f.creates).toHaveLength(1);
      expect(f.dispatches).toHaveLength(0);
      expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    }
  );

  it('probes the exact account after DO restart and finalizes through the normal deletion service without another create', async () => {
    const f = await orphanedDirectCreation();
    const result = await attemptWorkspaceDeletion({
      env: f.testEnv,
      expected: f.identity,
      attempt: 1,
      source: 'explicit',
      mode: 'explicit',
    });
    expect(result).toMatchObject({ status: 'confirmed', proof: 'node_runtime_terminated' });
    expect(
      await env.DATABASE.prepare('SELECT status,runtime_deletion_proof FROM workspaces WHERE id=?')
        .bind(f.workspaceId)
        .first()
    ).toEqual({ status: 'deleted', runtime_deletion_proof: 'node_runtime_terminated' });
    const replay = await attemptWorkspaceDeletion({
      env: f.testEnv,
      expected: f.identity,
      attempt: 2,
      source: 'explicit',
      mode: 'explicit',
    });
    expect(replay.status).toBe('confirmed');
    expect(f.creates).toHaveLength(1);
    expect(f.dispatches).toHaveLength(0);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    const inventoryCall = calls.find(([url]) => String(url).includes('/servers?'));
    expect(String(inventoryCall?.[0])).not.toContain('incarnation');
  });

  it.each([
    'runtime',
    'credential',
    'owner',
    'generation',
    'audit',
    'owner-attested-audit',
    'intent',
    'pending-intent',
    'provider-failure',
    'malformed-inventory',
    'credential-during-inventory',
    'generation-during-inventory',
    'node-during-inventory',
    'owner-during-inventory',
    'project-during-inventory',
    'chat-during-inventory',
  ])('keeps deletion pending when proof changes: %s', async (failure) => {
    const f = await orphanedDirectCreation();
    if (failure === 'runtime') f.inventory.push(f.survivingServer!);
    if (failure === 'credential')
      await env.DATABASE.prepare(
        "UPDATE credentials SET updated_at='2099-01-01T00:00:00Z' WHERE user_id=?"
      )
        .bind(f.userId)
        .run();
    if (failure === 'owner') f.identity.userId = 'another-user';
    if (failure === 'generation') f.identity.workspaceGeneration = 'later-generation';
    if (failure === 'audit')
      await env.DATABASE.prepare('DELETE FROM node_health_events WHERE node_id=?')
        .bind(f.intentSnapshot.input.nodeId)
        .run();
    if (failure === 'owner-attested-audit')
      await env.DATABASE.prepare(
        "UPDATE node_health_events SET reason='owner_attested_manual_deletion' WHERE node_id=?"
      )
        .bind(f.intentSnapshot.input.nodeId)
        .run();
    if (failure === 'intent')
      await runInDurableObject(f.stub, async (_instance, state) => {
        const intent =
          (await state.storage.get<DirectProvisioningIntent>(DIRECT_PROVISIONING_KEY))!;
        await state.storage.put(DIRECT_PROVISIONING_KEY, { ...intent, allocationComplete: true });
      });
    if (failure === 'pending-intent')
      await runInDurableObject(f.stub, async (_instance, state) => {
        const intent =
          (await state.storage.get<DirectProvisioningIntent>(DIRECT_PROVISIONING_KEY))!;
        await state.storage.put(DIRECT_PROVISIONING_KEY, { ...intent, status: 'pending' });
      });
    if (failure.includes('inventory') || failure === 'provider-failure') {
      const original = fetch;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
          if (!String(url).includes('/servers?')) return original(url, init);
          if (failure === 'provider-failure')
            return Response.json({ error: 'unavailable' }, { status: 503 });
          if (failure === 'malformed-inventory') return Response.json({ servers: null });
          const response = await original(url, init);
          if (failure === 'credential-during-inventory')
            await env.DATABASE.prepare(
              "UPDATE credentials SET updated_at='2099-01-01T00:00:00Z' WHERE user_id=?"
            )
              .bind(f.userId)
              .run();
          if (failure === 'generation-during-inventory')
            await env.DATABASE.prepare(
              "UPDATE workspaces SET eviction_generation='changed' WHERE id=?"
            )
              .bind(f.workspaceId)
              .run();
          if (failure === 'node-during-inventory')
            await seedNode(f.intentSnapshot.input.nodeId, f.userId);
          if (failure === 'owner-during-inventory') {
            const otherOwner = 'new-owner-' + crypto.randomUUID();
            await seedUser(otherOwner);
            await env.DATABASE.prepare('UPDATE workspaces SET user_id=? WHERE id=?')
              .bind(otherOwner, f.workspaceId)
              .run();
          }
          if (failure === 'project-during-inventory')
            await env.DATABASE.prepare('UPDATE workspaces SET project_id=NULL WHERE id=?')
              .bind(f.workspaceId)
              .run();
          if (failure === 'chat-during-inventory')
            await env.DATABASE.prepare('UPDATE workspaces SET chat_session_id=NULL WHERE id=?')
              .bind(f.workspaceId)
              .run();
          return response;
        })
      );
    }
    await expect(f.stub.confirmUnassignedWorkspaceDeletion(f.identity)).resolves.toBe(false);
    expect(
      await env.DATABASE.prepare(
        'SELECT status,runtime_deletion_confirmed_at FROM workspaces WHERE id=?'
      )
        .bind(f.workspaceId)
        .first()
    ).toEqual({ status: 'stopping', runtime_deletion_confirmed_at: null });
    expect(f.creates).toHaveLength(1);
  });
});

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
