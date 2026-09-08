import { HetznerProvider } from '@simple-agent-manager/providers';
import { Hono } from 'hono';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { nodeLifecycleRoutes } from '../../../src/routes/node-lifecycle';
import { crudRoutes } from '../../../src/routes/workspaces/crud';
import { lifecycleRoutes } from '../../../src/routes/workspaces/lifecycle';
import { registerWorkspaceCreateRoute } from '../../../src/routes/workspaces/workspace-create';
import { clearCapacityCatalogCache } from '../../../src/services/default-capacity-source-credentials';
import { encrypt } from '../../../src/services/encryption';
import { signCallbackToken, signNodeCallbackToken } from '../../../src/services/jwt';
import { directProvisioningHarness } from '../../helpers/direct-provisioning';
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
  vi.restoreAllMocks();
  clearCapacityCatalogCache();
});

async function createMeteringFixture(options: {
  rejectProvider?: boolean;
  durableOnly?: boolean;
  deferProvider?: boolean;
  interruptProvider?: boolean;
  hangProvider?: boolean;
  interruptDispatch?: boolean;
  wrongDispatchAck?: boolean;
  hangDnsBody?: boolean;
  awaitingIp?: boolean;
  emptyInventory?: boolean;
  duplicateInventory?: boolean;
  multiWorkspace?: boolean;
  cleanupClaimed?: boolean;
  reassignWorkspace?: boolean;
} = {}) {
  const f = fixture();
  if (options.awaitingIp) {
    const create = HetznerProvider.prototype.createVM;
    vi.spyOn(HetznerProvider.prototype, 'createVM').mockImplementation(async function (this: HetznerProvider, ...args: Parameters<HetznerProvider['createVM']>) {
      // Model the Provider contract's successful asynchronous-IP response (used by Scaleway),
      // retaining the real HTTP response, identity publication and authority path.
      return { ...await create.apply(this, args), ip: '', location: undefined };
    });
  }
  const durable = directProvisioningHarness(f.env);
  const durableStarts = vi.fn(async () => undefined);
  if (options.durableOnly) Object.assign(f.env, { NODE_LIFECYCLE: {
    idFromName: (name: string) => name, get: () => ({ startProvisioning: durableStarts }),
  } });
  const projectStub = f.env.PROJECT_DATA.get(f.env.PROJECT_DATA.idFromName('project-1'));
  Object.assign(projectStub, { recordActivityEvent: vi.fn(async () => 'activity-1') });
  const encryptionKey = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
  Object.assign(f.env, keys, {
    ENCRYPTION_KEY: encryptionKey,
    CF_ZONE_ID: 'test-zone',
    CF_API_TOKEN: 'test-dns-token',
    NODE_PROVISIONING_REQUEST_TIMEOUT_MS: options.rejectProvider ? '10000' : options.hangProvider || options.hangDnsBody ? '200' : '1000',
    ENVIRONMENT: 'test', SAM_INSTALLATION_ID: '0123456789abcdef0123456789abcdef',
    NODE_PROVISIONING_MAX_ATTEMPTS: options.interruptProvider || options.hangProvider || options.interruptDispatch || options.wrongDispatchAck || options.hangDnsBody || options.awaitingIp ? '3' : '1',
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
  const dispatches: Record<string, unknown>[] = [];
  const logicalWorkspaces = new Set<string>();
  const providerDeletes: string[] = [];
  const providerSignals: AbortSignal[] = [];
  const inventory: Record<string, unknown>[] = [];
  const inventoryRequests: string[] = [];
  const dnsRecords: Record<string, unknown>[] = [];
  const dnsPosts: Record<string, unknown>[] = [];
  let releaseProvider!: () => void;
  const blockedProvider = new Promise<void>(resolve => { releaseProvider = resolve; });
  let providerEntered!: () => void;
  const providerRequested = new Promise<void>(resolve => { providerEntered = resolve; });
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
        const server = {
            id: 321,
            name: body.name,
            status: 'running',
            created: new Date().toISOString(),
            public_net: { ipv4: { ip: '203.0.113.2' } },
            server_type: serverType,
            location: { name: body.location },
            labels: body.labels,
          };
        inventory.push(server);
        if (init?.signal) providerSignals.push(init.signal);
        if (options.hangProvider) await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
        providerEntered();
        if (options.interruptProvider) throw new TypeError('connection lost after provider accepted create');
        if (options.deferProvider) await blockedProvider;
        return Response.json({ server });
      }
      if (url.includes('api.hetzner.cloud/v1/servers/') && init?.method === 'DELETE') {
        providerDeletes.push(url); return new Response(null, { status: 204 });
      }
      if (url.includes('api.hetzner.cloud/v1/servers?')) {
        inventoryRequests.push(url);
        return Response.json({ servers: options.emptyInventory ? [] : options.duplicateInventory
          ? [...inventory, { ...inventory[0], id: 322 }] : inventory,
          meta: { pagination: { next_page: null } } });
      }
      if (url.endsWith('/workspaces') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        dispatches.push(body);
        logicalWorkspaces.add(body.workspaceId);
        if (options.interruptDispatch && dispatches.length === 1) throw new TypeError("dispatch response lost");
        if (options.wrongDispatchAck && dispatches.length === 1) return Response.json({ workspaceId: 'foreign-workspace' });
        return Response.json({ workspaceId: body.workspaceId, status: 'creating' });
      }
      if (url.includes('/dns_records?')) return Response.json({ success: true, result: dnsRecords });
      if (url.includes('api.cloudflare.com/client/v4/zones/test-zone/dns_records')) {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          const record = { ...body, name: `${body.name}.${f.env.BASE_DOMAIN}`, id: 'dns-host' };
          dnsRecords.push(record); dnsPosts.push(record);
          if (options.hangDnsBody && dnsPosts.length === 1) return new Response(new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode('{"success":')); },
          }));
        }
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
  app.route('/node-callback', nodeLifecycleRoutes);
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
        ...(options.multiWorkspace ? { resourceRequirements: { minVcpu: 0.25, minMemoryGb: 0.5, minDiskGb: 0, maxCoTenants: 3 } } : {}),
      }),
    },
    f.env,
    executionContext
  );
  const result = (await response.json()) as { id: string };
  expect(response.status, JSON.stringify(result)).toBe(201);
  if (!options.durableOnly) { await durable.tick(); pending.push(...durable.pending); }
  if (options.durableOnly) { /* The route must only persist a durable handoff. */ }
  else if (options.rejectProvider || options.interruptProvider || options.hangProvider || options.hangDnsBody || options.awaitingIp) await Promise.all(pending);
  else if (options.deferProvider) await providerRequested;
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
    durableStarts,
    durable,
    releaseProvider,
    dispatches,
    logicalWorkspaces,
    inventory,
    providerDeletes,
    providerSignals,
    inventoryRequests,
    dnsPosts,
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
  it('accepts a fresh workspace only after durable handoff, without provider work in request waitUntil', async () => {
    const control = await createMeteringFixture({ durableOnly: true });
    try {
      expect(control.durableStarts).toHaveBeenCalledTimes(1);
      expect(control.providerCreates).toEqual([]);
      expect(usage(control.f, control.workspaceId)).toEqual([]);
      expect(control.f.sqlite.prepare('SELECT status,node_id FROM workspaces WHERE id=?')
        .get(control.workspaceId)).toEqual({ status: 'creating', node_id: null });
    } finally {
      control.releaseHealth(new Response('not ready', { status: 503 }));
      await Promise.all(control.pending);
      await control.durable.tick();
      await Promise.all(control.durable.pending);
    }
  });

  it('continues the actual provider, SQL attachment, native usage and dispatch after the HTTP owner ends', async () => {
    const control = await createMeteringFixture({ deferProvider: true });
    expect(control.providerCreates).toHaveLength(1);
    expect(control.f.sqlite.prepare('SELECT provider_instance_id FROM nodes').get())
      .toEqual({ provider_instance_id: null });
    expect(usage(control.f, control.workspaceId)).toEqual([]);
    // The accepted HTTP request owns only an activity event; its background work can finish here.
    // Allocation remains held by the separately persisted durable intent/controller.
    await Promise.all([control.durable.tick(), control.durable.tick()]);
    control.releaseHealth(Response.json({ status: 'ok' }));
    control.releaseProvider();
    await Promise.all(control.durable.pending);
    expect(control.f.sqlite.prepare('SELECT provider_instance_id FROM nodes').get())
      .toEqual({ provider_instance_id: '321' });
    expect(usage(control.f, control.workspaceId)).toEqual([expect.objectContaining({
      provider_instance_type: 'cx23', vcpu_count: 2, provider_instance_price_hourly_micros: 4800,
      ended_at: null,
    })]);
    expect(control.dispatches).toHaveLength(1);
    expect(control.f.sqlite.prepare('SELECT dispatched_at FROM workspaces WHERE id=?')
      .get(control.workspaceId)).toEqual({ dispatched_at: expect.any(String) });
    await control.durable.tick();
    expect(control.providerCreates).toHaveLength(1);
    expect(control.dispatches).toHaveLength(1);
  });

  it('recovers the exact provider incarnation after a lost successful create response without another POST', async () => {
    const control = await createMeteringFixture({ interruptProvider: true });
    expect(control.providerCreates).toHaveLength(1);
    const first = control.f.sqlite.prepare('SELECT provider_instance_id,runtime_termination_confirmed_at FROM nodes').get();
    expect(first).toEqual({ provider_instance_id: null, runtime_termination_confirmed_at: null });
    control.releaseHealth(Response.json({ status: 'ok' }));
    await control.durable.tick();
    await Promise.all(control.durable.pending);
    expect(control.providerCreates).toHaveLength(1);
    expect(control.f.sqlite.prepare('SELECT provider_instance_id FROM nodes').get()).toEqual({ provider_instance_id: '321' });
    expect(usage(control.f, control.workspaceId)).toHaveLength(1);
    expect(control.dispatches).toHaveLength(1);
  });

  it.each(['lost-response', 'wrong-identity'])('replays workspace dispatch after %s and restart while preserving one logical workspace', async failure => {
    const f = await createMeteringFixture({ interruptDispatch: failure === 'lost-response', wrongDispatchAck: failure === 'wrong-identity' });
    f.releaseHealth(Response.json({ status: 'ok' }));
    await Promise.all(f.durable.pending);
    expect(f.f.sqlite.prepare('SELECT status,dispatched_at FROM workspaces WHERE id=?').get(f.workspaceId))
      .toEqual({ status: 'creating', dispatched_at: null });
    const instance = [...f.durable.instances.values()][0]!;
    instance.restart();
    await f.durable.tick();
    await Promise.all(f.durable.pending);
    expect(f.dispatches).toHaveLength(2);
    expect(f.logicalWorkspaces.size).toBe(1);
    expect(f.providerCreates).toHaveLength(1);
    expect(usage(f.f, f.workspaceId)).toHaveLength(1);
    expect(f.f.sqlite.prepare('SELECT dispatched_at FROM workspaces WHERE id=?').get(f.workspaceId))
      .toEqual({ dispatched_at: expect.any(String) });
  });

  it('rechecks allocation authority after identity publication and a heartbeat before the durable completion checkpoint', async () => {
    const f = await createMeteringFixture({ interruptProvider: true });
    // A direct node allocation has no workspace admission check to rescue a skipped authority check.
    const instance = [...f.durable.instances.values()][0]!;
    const intent = [...instance.values.values()][0] as { input: { workspace?: unknown } };
    delete intent.input.workspace;
    // Simulate a crash after the provider response was recorded, before post-allocation authority.
    f.f.sqlite.prepare("UPDATE nodes SET provider_instance_id='321',status='running'").run();
    f.f.sqlite.prepare('UPDATE capacity_pools SET revision=revision+1').run();
    [...f.durable.instances.values()][0]!.restart();
    f.releaseHealth(Response.json({ status: 'ok' }));
    await f.durable.tick();
    await Promise.all(f.durable.pending);
    expect(f.providerDeletes).toHaveLength(1);
    expect(f.providerCreates).toHaveLength(1);
    expect(f.dispatches).toHaveLength(0);
    expect(f.f.sqlite.prepare('SELECT status,runtime_termination_confirmed_at FROM nodes').get())
      .toEqual({ status: 'destroying', runtime_termination_confirmed_at: expect.any(String) });
  });

  it.each([{ emptyInventory: true }, { duplicateInventory: true }])(
    'does not retry paid creation or invent absence for ambiguous inventory %j', async (options) => {
      const control = await createMeteringFixture({ interruptProvider: true, ...options });
      for (let tick = 0; tick < 3; tick++) {
        await control.durable.tick();
        await Promise.all(control.durable.pending);
      }
      expect(control.providerCreates).toHaveLength(1);
      expect(control.dispatches).toEqual([]);
      expect(usage(control.f, control.workspaceId)).toEqual([]);
      expect(control.f.sqlite.prepare('SELECT provider_instance_id,runtime_termination_confirmed_at FROM nodes').get())
        .toEqual({ provider_instance_id: null, runtime_termination_confirmed_at: null });
      expect([...control.durable.instances.values()].map(instance => instance.alarm)).toEqual([null]);
    });

  it('lets two different workspaces share the running node while the fresh workspace still awaits readiness', async () => {
    const f = await createMeteringFixture({ multiWorkspace: true });
    const node = f.f.sqlite.prepare('SELECT id FROM nodes').get() as { id: string };
    f.f.sqlite.prepare(`UPDATE nodes SET agent_version='current-agent',health_status='healthy',last_heartbeat_at=?,last_metrics=? WHERE id=?`)
      .run(new Date().toISOString(), JSON.stringify({ version: 1, cpuLoadAvg1: 0.1, memoryPercent: 5, diskPercent: 5 }), node.id);
    const responses = await Promise.all(['Second workspace', 'Third workspace'].map(name => f.app.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name,
        projectId: 'project-1', nodeId: node.id,
        resourceRequirements: { minVcpu: 0.25, minMemoryGb: 0.5, minDiskGb: 0, maxCoTenants: 3 } }),
    }, f.f.env, f.executionContext)));
    for (const response of responses) expect(response.status, await response.clone().text()).toBe(201);
    expect(f.durable.instances.size).toBe(3);
    await f.durable.tick();
    await Promise.all(f.durable.pending.slice(1));
    expect(f.dispatches).toHaveLength(2);
    expect(f.providerCreates).toHaveLength(1);
    f.releaseHealth(Response.json({ status: 'ok' }));
    await Promise.all(f.durable.pending);
    expect(f.dispatches).toHaveLength(3);
    expect(f.f.sqlite.prepare('SELECT COUNT(*) AS count FROM compute_usage WHERE ended_at IS NULL').get()).toEqual({ count: 3 });
  });

  it.each(['incarnation', 'labels', 'pool-revocation'])('fences recovery against %s changing after the provider accepted creation', async change => {
    const f = await createMeteringFixture({ interruptProvider: true });
    if (change === 'incarnation') f.f.sqlite.prepare("UPDATE nodes SET runtime_incarnation_id='new-incarnation'").run();
    if (change === 'labels') (f.inventory[0]!.labels as Record<string, string>).incarnation = 'foreign';
    if (change === 'pool-revocation') f.f.sqlite.prepare('UPDATE capacity_pools SET revision=revision+1').run();
    f.releaseHealth(Response.json({ status: 'ok' }));
    await f.durable.tick();
    await Promise.all(f.durable.pending);
    expect(f.providerCreates).toHaveLength(1);
    expect(f.dispatches).toEqual([]);
    expect(usage(f.f, f.workspaceId)).toEqual([]);
    if (change === 'pool-revocation') {
      expect(f.providerDeletes).toHaveLength(1);
      expect(f.f.sqlite.prepare('SELECT provider_instance_id,runtime_termination_confirmed_at FROM nodes').get())
        .toEqual({ provider_instance_id: '321', runtime_termination_confirmed_at: expect.any(String) });
      expect(f.f.sqlite.prepare('SELECT runtime_deletion_proof FROM workspaces WHERE id=?').get(f.workspaceId))
        .toEqual({ runtime_deletion_proof: 'node_runtime_terminated' });
      const deletion = await f.app.request(`/cleanup/${f.workspaceId}`, { method: 'DELETE' }, f.f.env);
      expect(deletion.status, await deletion.clone().text()).toBe(200);
    } else {
      expect(f.providerDeletes).toEqual([]);
      expect(f.f.sqlite.prepare('SELECT provider_instance_id,runtime_termination_confirmed_at FROM nodes').get())
        .toEqual({ provider_instance_id: null, runtime_termination_confirmed_at: null });
    }
  });

  it('aborts a dead create request at the background deadline and reconciles the accepted VM on a later tick', async () => {
    const f = await createMeteringFixture({ hangProvider: true });
    expect(f.providerSignals[0]?.aborted).toBe(true);
    expect(f.providerCreates).toHaveLength(1);
    expect(usage(f.f, f.workspaceId)).toEqual([]);
    f.releaseHealth(Response.json({ status: 'ok' }));
    await f.durable.tick();
    await Promise.all(f.durable.pending);
    expect(f.providerCreates).toHaveLength(1);
    expect(f.dispatches).toHaveLength(1);
    expect(usage(f.f, f.workspaceId)).toHaveLength(1);
  });

  it('checkpoints a successful asynchronous-IP allocation and continues after the real heartbeat without inventory adoption', async () => {
    const f = await createMeteringFixture({ awaitingIp: true, emptyInventory: true });
    const node = f.f.sqlite.prepare('SELECT id,provider_instance_id,status,ip_address FROM nodes').get() as { id: string };
    expect(node).toMatchObject({ provider_instance_id: '321', status: 'creating', ip_address: null });
    expect([...f.durable.instances.values()][0]!.values.get('direct-provisioning:v1'))
      .toMatchObject({ allocationComplete: true, status: 'pending' });
    [...f.durable.instances.values()][0]!.restart();
    await f.durable.tick(); await Promise.all(f.durable.pending);
    expect(f.inventoryRequests).toHaveLength(0);
    const token = await signNodeCallbackToken(node.id, f.f.env);
    const heartbeat = await f.app.request(`/node-callback/${node.id}/heartbeat`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.2' },
      body: JSON.stringify({}),
    }, f.f.env, f.executionContext);
    expect(heartbeat.status, await heartbeat.clone().text()).toBe(200);
    f.releaseHealth(Response.json({ status: 'ok' }));
    await f.durable.tick(); await Promise.all(f.durable.pending);
    expect(f.providerCreates).toHaveLength(1);
    expect(f.inventoryRequests).toHaveLength(0);
    expect(f.dispatches).toHaveLength(1);
    expect(usage(f.f, f.workspaceId)).toHaveLength(1);
  });

  it('adopts a late-visible allocation after two empty inventory ticks without a second provider POST', async () => {
    const options = { interruptProvider: true, emptyInventory: true };
    const f = await createMeteringFixture(options);
    f.f.env.NODE_PROVISIONING_MAX_ATTEMPTS = '5';
    for (let tick = 0; tick < 2; tick++) { await f.durable.tick(); await Promise.all(f.durable.pending); }
    expect(f.providerCreates).toHaveLength(1);
    expect(f.f.sqlite.prepare('SELECT provider_instance_id FROM nodes').get()).toEqual({ provider_instance_id: null });
    options.emptyInventory = false;
    f.releaseHealth(Response.json({ status: 'ok' }));
    await f.durable.tick(); await Promise.all(f.durable.pending);
    expect(f.providerCreates).toHaveLength(1);
    expect(f.dispatches).toHaveLength(1);
    expect(usage(f.f, f.workspaceId)).toHaveLength(1);
  });

  it.each(['wrong-location', 'missing-location', 'old-created-at', 'future-created-at'])(
    'rejects exact nonce inventory with %s without inventing termination proof', async change => {
      const f = await createMeteringFixture({ interruptProvider: true });
      const server = f.inventory[0]!;
      if (change === 'wrong-location') server.location = { name: 'nbg1' };
      if (change === 'missing-location') delete server.location;
      if (change === 'old-created-at') server.created = new Date(Date.now() - 60000).toISOString();
      if (change === 'future-created-at') server.created = new Date(Date.now() + 60000).toISOString();
      await f.durable.tick(); await Promise.all(f.durable.pending);
      expect(f.providerCreates).toHaveLength(1);
      expect(f.providerDeletes).toHaveLength(0);
      expect(f.dispatches).toHaveLength(0);
      expect(f.f.sqlite.prepare('SELECT provider_instance_id,runtime_termination_confirmed_at FROM nodes').get())
        .toEqual({ provider_instance_id: null, runtime_termination_confirmed_at: null });
    });

  it('bounds a lost successful DNS response body and adopts the exact record on replay', async () => {
    const f = await createMeteringFixture({ hangDnsBody: true });
    expect(f.dnsPosts).toHaveLength(1);
    expect([...f.durable.instances.values()][0]!.values.get('direct-provisioning:v1'))
      .toMatchObject({ status: 'pending', lastError: expect.stringContaining('deadline') });
    expect(f.f.sqlite.prepare('SELECT backend_dns_record_id FROM nodes').get()).toEqual({ backend_dns_record_id: null });
    [...f.durable.instances.values()][0]!.restart();
    f.releaseHealth(Response.json({ status: 'ok' }));
    await f.durable.tick(); await Promise.all(f.durable.pending);
    expect(f.providerCreates).toHaveLength(1);
    expect(f.dnsPosts).toHaveLength(1);
    expect(f.f.sqlite.prepare('SELECT backend_dns_record_id,status FROM nodes').get())
      .toEqual({ backend_dns_record_id: 'dns-host', status: 'running' });
    expect(f.dispatches).toHaveLength(1);
  });

  it.each(['nodes', 'tasks'])('retries terminal publication after a transient %s write failure without provider work', async table => {
    const f = await createMeteringFixture({ interruptProvider: true, emptyInventory: true });
    const instance = [...f.durable.instances.values()][0]!;
    const intent = [...instance.values.values()][0] as { createdAt: number };
    intent.createdAt = Date.now() - 16 * 60_000;
    f.f.sqlite.exec(`CREATE TRIGGER transient_publication_failure BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'temporary D1 failure'); END`);
    await f.durable.tick(); await Promise.all(f.durable.pending);
    expect(instance.alarm).not.toBeNull();
    expect(f.f.sqlite.prepare('SELECT status FROM tasks WHERE workspace_id=?').get(f.workspaceId))
      .toEqual({ status: 'in_progress' });
    expect(f.f.sqlite.prepare('SELECT status FROM workspaces WHERE id=?').get(f.workspaceId))
      .toEqual({ status: table === 'tasks' ? 'error' : 'creating' });
    f.f.sqlite.exec('DROP TRIGGER transient_publication_failure');
    instance.restart();
    await f.durable.tick(); await Promise.all(f.durable.pending);
    expect(instance.alarm).toBeNull();
    expect(f.f.sqlite.prepare('SELECT status FROM tasks WHERE workspace_id=?').get(f.workspaceId))
      .toEqual({ status: 'failed' });
    expect(f.f.sqlite.prepare('SELECT status,runtime_deletion_confirmed_at FROM workspaces WHERE id=?').get(f.workspaceId))
      .toEqual({ status: 'error', runtime_deletion_confirmed_at: null });
    expect(f.providerCreates).toHaveLength(1);
    expect(f.providerDeletes).toHaveLength(0);
  });

  it('terminalizes an expired unresolved intent with a null deadline and alerts operators once', async () => {
    const f = await createMeteringFixture({ interruptProvider: true, emptyInventory: true });
    f.f.sqlite.prepare("UPDATE users SET role='superadmin' WHERE id='superadmin-1'").run();
    const alerts = vi.fn(async () => ({ id: 'operator-alert' }));
    Object.assign(f.f.env, { KV: { get: async () => null, put: async () => undefined },
      NOTIFICATION: { idFromName: (id: string) => id, get: () => ({
        claimNotificationDeduplication: async () => true, createNotification: alerts,
      }) } });
    const instance = [...f.durable.instances.values()][0]!;
    const intent = [...instance.values.values()][0] as { createdAt: number; nextAttemptAt: number | null };
    intent.createdAt = Date.now() - 16 * 60_000;
    intent.nextAttemptAt = null;
    await f.durable.tick();
    await Promise.all(f.durable.pending);
    expect(instance.alarm).toBeNull();
    expect(alerts).toHaveBeenCalledOnce();
    expect(alerts).toHaveBeenCalledWith('superadmin-1', expect.objectContaining({ type: 'cron_failure', urgency: 'high' }));
    await f.durable.tick();
    await Promise.all(f.durable.pending);
    expect(instance.alarm).toBeNull();
    expect(alerts).toHaveBeenCalledOnce();
    expect(f.providerCreates).toHaveLength(1);
    expect(f.f.sqlite.prepare('SELECT runtime_termination_confirmed_at FROM nodes').get())
      .toEqual({ runtime_termination_confirmed_at: null });
  });

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
      await control.durable.tick();
      await Promise.all(control.durable.pending);
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
      await control.durable.tick();
      await Promise.all(control.durable.pending);
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
      await control.durable.tick();
      await Promise.all(control.durable.pending);
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
