import { HetznerProvider } from '@simple-agent-manager/providers';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { registerDeploymentEnvironmentLifecycleRoutes } from '../../../src/routes/deployment-environment-lifecycle';
import { runDeploymentNodeCleanup } from '../../../src/scheduled/deployment-node-cleanup';
import { cleanupDeploymentNode } from '../../../src/services/deployment-node-cleanup';
import { provisionDeploymentNode } from '../../../src/services/deployment-provisioning';
import { deleteDNSRecord } from '../../../src/services/dns';
import { teardownDeploymentEnvironmentOnNode } from '../../../src/services/node-agent';
import { stopNodeResources } from '../../../src/services/node-resource-lifecycle';
import { exactProviderCredentialBindingFromPlacementSnapshot } from '../../../src/services/provider-credential-exact';
import { createProviderForUser } from '../../../src/services/provider-credentials';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const provider = vi.hoisted(() => ({
  deleteVM: vi.fn(),
  listVMs: vi.fn(),
  getVM: vi.fn(),
  detachVolume: vi.fn(),
  attachVolume: vi.fn(),
}));
vi.mock('../../../src/services/deployment-provisioning', () => ({
  provisionDeploymentNode: vi.fn(),
}));
vi.mock('../../../src/services/provider-credentials', () => ({
  createProviderForUser: vi.fn(async (_db, _user, _key, _env, _provider, _project, binding) => {
    if (binding && binding.credentialFingerprint !== 'sha256:original')
      throw new Error('Credential rotated');
    return { provider, providerName: 'hetzner' };
  }),
  exactProviderCredentialBindingFromPlacementSnapshot: (
    snapshot: Parameters<typeof exactProviderCredentialBindingFromPlacementSnapshot>[0]
  ) => exactProviderCredentialBindingFromPlacementSnapshot(snapshot),
}));
vi.mock('../../../src/lib/secrets', () => ({ getCredentialEncryptionKey: () => 'test-key' }));
vi.mock('../../../src/services/dns', () => ({ deleteDNSRecord: vi.fn() }));
vi.mock('../../../src/services/workspace-lifecycle-finalizer', () => ({
  finalizeWorkspaceLifecycleClosure: vi.fn(),
}));
vi.mock('../../../src/services/project-lifecycle-events', () => ({
  recordDeploymentEnvironmentLifecycleEventBestEffort: vi.fn(),
}));
vi.mock('../../../src/services/node-agent', () => ({
  teardownDeploymentEnvironmentOnNode: vi.fn(),
  getNodeAgentBackgroundRequestTimeoutMs: () => 5000,
}));
vi.mock('../../../src/services/deployment-environment-summary', () => ({
  buildDeploymentEnvironmentResponse: vi.fn(async (_db, _env, row) => row),
}));
vi.mock('../../../src/middleware/auth', () => ({
  getUserId: () => 'user',
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../../src/middleware/project-auth', async (original) => ({
  ...(await original<typeof import('../../../src/middleware/project-auth')>()),
  requireProjectCapability: vi.fn(),
}));

let sqlite: Database.Database;
let env: Env;
const options = { retryAfterMs: 60000, requestTimeoutMs: 5000 };
function row() {
  return sqlite.prepare('SELECT * FROM nodes WHERE id = ?').get('node') as Record<string, unknown>;
}
function environment() {
  return sqlite
    .prepare('SELECT * FROM deployment_environments WHERE id = ?')
    .get('environment') as Record<string, unknown>;
}
async function seedNode(overrides: Partial<schema.Node> = {}) {
  await drizzle(env.DATABASE)
    .insert(schema.nodes)
    .values({
      id: 'node',
      userId: 'user',
      name: 'deployment',
      status: 'running',
      runtime: 'vm',
      nodeClass: 'managed',
      nodeRole: 'deployment',
      workloadRole: 'deployment',
      vmSize: 'small',
      vmLocation: 'fsn1',
      cloudProvider: 'hetzner',
      providerInstanceId: '123',
      runtimeIncarnationId: 'incarnation',
      createdAt: '2026-10-22T08:53:43.601Z',
      updatedAt: '2026-10-22T08:53:43.601Z',
      placementCredentialSource: 'user',
      placementCredentialReference: 'credentials:original',
      placementCredentialVersion: 1,
      placementCredentialFingerprint: 'sha256:original',
      capacityPoolId: 'pool',
      capacityPoolScope: 'user',
      capacityPoolRevision: 1,
      capacitySourceId: 'source',
      capacitySourceGeneration: 1,
      capacityPoolCandidateId: 'candidate',
      providerInstanceType: 'cx23',
      providerInstanceVcpuCount: 2,
      providerInstanceMemoryMb: 4096,
      ...overrides,
    });
}
async function seedEnvironment(status = 'active') {
  await drizzle(env.DATABASE)
    .insert(schema.deploymentEnvironments)
    .values({
      id: 'environment',
      projectId: 'project',
      name: 'app',
      nodeId: 'node',
      status,
    } as schema.NewDeploymentEnvironmentRow);
}
function app() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((e, c) => c.json({ message: e.message }, e instanceof AppError ? e.statusCode : 500));
  registerDeploymentEnvironmentLifecycleRoutes(app);
  return app;
}
const start = () =>
  app().request('/project/environments/environment/start', { method: 'POST' }, env);
const stop = () => app().request('/project/environments/environment/stop', { method: 'POST' }, env);

beforeEach(() => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  env = {
    DATABASE: createSqliteD1(sqlite),
    ENVIRONMENT: 'production',
    SAM_INSTALLATION_ID: '0123456789abcdef0123456789abcdef',
    // A Cloudflare installation: app deployments need Cloudflare DNS (platform-capabilities.ts).
    CF_API_TOKEN: 'cf-token',
    CF_ZONE_ID: 'zone-1',
  } as Env;
  vi.clearAllMocks();
  provider.deleteVM.mockResolvedValue(undefined);
  provider.listVMs.mockResolvedValue([]);
  provider.attachVolume.mockResolvedValue({ linuxDevice: '/dev/data' });
});
afterEach(() => {
  sqlite.close();
  vi.unstubAllGlobals();
});

describe('deployment teardown with real SQL and strict provider boundary', () => {
  it('retains placement and visible failure, then retries the real stop to strict termination', async () => {
    await seedNode();
    await seedEnvironment();
    provider.deleteVM.mockRejectedValueOnce(new Error('provider unavailable'));
    expect((await stop()).status).toBe(409);
    expect(environment()).toMatchObject({
      status: 'error',
      node_id: 'node',
      observed_status: 'failed',
    });
    expect(row()).toMatchObject({ status: 'destroying', runtime_termination_confirmed_at: null });
    expect((await stop()).status).toBe(200);
    expect(provider.deleteVM).toHaveBeenCalledTimes(2);
    expect(environment()).toMatchObject({ status: 'stopped', node_id: null });
    expect(row().runtime_termination_confirmed_at).toEqual(expect.any(String));
    expect(row().status).toBe('deleted');
  });

  it('backstop recovers an interrupted claim but protects a healthy legacy deployment', async () => {
    await seedNode({ status: 'destroying' });
    await drizzle(env.DATABASE)
      .insert(schema.nodes)
      .values({
        id: 'healthy',
        userId: 'user',
        name: 'legacy',
        status: 'running',
        runtime: 'vm',
        nodeClass: 'managed',
        nodeRole: 'deployment',
        providerInstanceId: 'healthy-vm',
      } as schema.NewNode);
    expect(await runDeploymentNodeCleanup(env)).toEqual({ deleted: 1, failed: 0 });
    expect(sqlite.prepare('SELECT status FROM nodes WHERE id = ?').get('healthy')).toEqual({
      status: 'running',
    });
    expect(provider.deleteVM).toHaveBeenCalledTimes(1);
    expect(provider.deleteVM.mock.calls[0]?.[0]).toBe('123');
  });

  it('resumes a stale stop before the deletion claim through live teardown and volume detach', async () => {
    await seedNode();
    await seedEnvironment('stopping');
    sqlite
      .prepare(
        "UPDATE deployment_environments SET updated_at = '2026-10-22T09:00:00Z', requires_volumes = 1"
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO deployment_volumes (id, environment_id, name, provider_volume_id,
      provider_name, location, attached_server_id, status) VALUES
      ('volume','environment','data','physical-volume','hetzner','fsn1','123','attached')`
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO deployment_releases (id, environment_id, version) VALUES ('release','environment',1)"
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO deployment_environment_config_vars (id, environment_id, env_key, stored_value) VALUES ('config','environment','MODE','production')"
      )
      .run();
    const releases = sqlite.prepare('SELECT * FROM deployment_releases').all();
    const config = sqlite.prepare('SELECT * FROM deployment_environment_config_vars').all();
    expect(await runDeploymentNodeCleanup(env)).toEqual({ deleted: 0, failed: 0 });
    expect(teardownDeploymentEnvironmentOnNode).toHaveBeenCalled();
    expect(provider.detachVolume).toHaveBeenCalledWith({
      volumeId: 'physical-volume',
      serverId: '123',
      location: 'fsn1',
    });
    expect(environment()).toMatchObject({ status: 'stopped', node_id: null });
    expect(
      sqlite
        .prepare('SELECT provider_volume_id, attached_server_id, status FROM deployment_volumes')
        .get()
    ).toEqual({
      provider_volume_id: 'physical-volume',
      attached_server_id: null,
      status: 'available',
    });
    expect(sqlite.prepare('SELECT * FROM deployment_releases').all()).toEqual(releases);
    expect(sqlite.prepare('SELECT * FROM deployment_environment_config_vars').all()).toEqual(
      config
    );
  });

  it.each(['environment', 'node'])(
    'keeps DNS cleanup retryable after provider termination: %s',
    async (entryPoint) => {
      await seedNode({ backendDnsRecordId: 'dns-record' });
      await seedEnvironment();
      vi.mocked(deleteDNSRecord).mockRejectedValueOnce(new Error('DNS unavailable'));
      if (entryPoint === 'environment') expect((await stop()).status).toBe(409);
      else
        await expect(stopNodeResources('node', 'user', env)).rejects.toThrow(
          'DNS cleanup remains pending'
        );
      expect(environment()).toMatchObject({ status: 'error', node_id: 'node' });
      expect(row()).toMatchObject({ status: 'destroying', backend_dns_record_id: 'dns-record' });
      expect(row().runtime_termination_confirmed_at).toEqual(expect.any(String));
      expect((await stop()).status).toBe(200);
      expect(deleteDNSRecord).toHaveBeenCalledTimes(2);
      expect(provider.deleteVM).toHaveBeenCalledTimes(1);
    }
  );

  it('rolls back terminalization atomically and retries using existing external deletion proof', async () => {
    await seedNode();
    await seedEnvironment();
    sqlite.exec(`CREATE TRIGGER fail_environment_retirement BEFORE UPDATE ON deployment_environments
      WHEN NEW.status = 'stopped' BEGIN SELECT RAISE(ABORT, 'simulated commit failure'); END;`);
    expect((await stop()).status).toBe(409);
    expect(row()).toMatchObject({ status: 'destroying', provider_instance_id: '123' });
    expect(row().runtime_termination_confirmed_at).toEqual(expect.any(String));
    expect(environment()).toMatchObject({ status: 'error', node_id: 'node' });
    sqlite.exec('DROP TRIGGER fail_environment_retirement');
    expect((await stop()).status).toBe(200);
    expect(provider.deleteVM).toHaveBeenCalledTimes(1);
    expect(environment()).toMatchObject({ status: 'stopped', node_id: null });
  });

  it('recovers old partial terminalization from exact persisted proof without provider I/O', async () => {
    await seedNode({
      status: 'deleted',
      providerInstanceId: null,
      runtimeTerminationConfirmedAt: '2026-10-22T10:00:00Z',
    });
    await seedEnvironment('stopping');
    expect(await runDeploymentNodeCleanup(env)).toEqual({ deleted: 1, failed: 0 });
    expect(environment()).toMatchObject({ status: 'stopped', node_id: null });
    expect(provider.deleteVM).not.toHaveBeenCalled();
  });

  it('recovers a direct node stop failure with a linked environment', async () => {
    await seedNode();
    await seedEnvironment();
    provider.deleteVM.mockRejectedValueOnce(new Error('transient provider failure'));
    await expect(stopNodeResources('node', 'user', env)).rejects.toThrow('remains unconfirmed');
    expect(environment()).toMatchObject({ status: 'error', node_id: 'node' });
    expect(await runDeploymentNodeCleanup(env)).toEqual({ deleted: 1, failed: 0 });
    expect(environment()).toMatchObject({ status: 'stopped', node_id: null });
  });

  it('preserves the same provider volume through a real SQL stop/start round trip', async () => {
    await seedNode();
    await seedEnvironment();
    sqlite.prepare('UPDATE deployment_environments SET requires_volumes = 1').run();
    sqlite
      .prepare(
        `INSERT INTO deployment_volumes (id,environment_id,name,provider_volume_id,
      provider_name,location,attached_server_id,status) VALUES
      ('volume','environment','data','physical-volume','hetzner','fsn1','123','attached')`
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO deployment_releases (id,environment_id,version) VALUES ('release','environment',1)"
      )
      .run();
    expect((await stop()).status).toBe(200);
    vi.mocked(provisionDeploymentNode).mockImplementation(async () => {
      await seedNode({ id: 'replacement', providerInstanceId: '456' });
      sqlite.prepare("UPDATE deployment_environments SET node_id = 'replacement'").run();
      return {
        nodeId: 'replacement',
        provisioningStarted: false,
        provisioningPromise: Promise.resolve(),
      };
    });
    const response = await start();
    expect(response.status, await response.clone().text()).toBe(200);
    expect(provider.attachVolume).toHaveBeenCalledWith({
      volumeId: 'physical-volume',
      serverId: '456',
      location: 'fsn1',
    });
    expect(
      sqlite.prepare('SELECT provider_volume_id, attached_server_id FROM deployment_volumes').get()
    ).toEqual({ provider_volume_id: 'physical-volume', attached_server_id: '456' });
  });

  it('rejects malformed stored reservations before provisioning a stopped environment', async () => {
    await seedEnvironment('stopped');
    sqlite
      .prepare(
        "UPDATE deployment_environments SET node_id = NULL, resolved_reservation_json = 'malformed'"
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO deployment_releases (id,environment_id,version) VALUES ('release','environment',1)"
      )
      .run();
    expect((await start()).status).toBe(409);
    expect(provisionDeploymentNode).not.toHaveBeenCalled();
  });

  it('marks failed provisioning visibly rather than leaving a start stuck', async () => {
    await seedEnvironment('stopped');
    sqlite.prepare('UPDATE deployment_environments SET node_id = NULL').run();
    sqlite
      .prepare(
        "INSERT INTO deployment_releases (id,environment_id,version) VALUES ('release','environment',1)"
      )
      .run();
    vi.mocked(provisionDeploymentNode).mockResolvedValueOnce(null);
    expect((await start()).status).toBe(409);
    expect(environment()).toMatchObject({ status: 'error', node_id: null });
  });

  it('keeps workspace bytes and snapshots protected during deployment cleanup', async () => {
    await seedNode({ status: 'destroying' });
    sqlite
      .prepare(
        "INSERT INTO workspaces (id,node_id,user_id,status) VALUES ('workspace','node','user','sleeping')"
      )
      .run();
    expect((await cleanupDeploymentNode(env, 'node', 'user', options)).nodeDeleted).toBe(false);
    expect(provider.deleteVM).not.toHaveBeenCalled();
    expect(row().runtime_termination_confirmed_at).toBeNull();
    expect(sqlite.prepare('SELECT status FROM workspaces').get()).toEqual({ status: 'sleeping' });
  });

  it('backs off provider failures so another sweep does not repeat I/O immediately', async () => {
    await seedNode({ status: 'destroying' });
    provider.deleteVM.mockRejectedValue(new Error('timeout'));
    expect(await runDeploymentNodeCleanup(env)).toEqual({ deleted: 0, failed: 1 });
    expect(await runDeploymentNodeCleanup(env)).toEqual({ deleted: 0, failed: 0 });
    expect(provider.deleteVM).toHaveBeenCalledTimes(1);
  });

  it('retains unresolved providerless deployments after empty inventory with exact labels', async () => {
    await seedNode({ status: 'destroying', providerInstanceId: null });
    expect(await cleanupDeploymentNode(env, 'node', 'user', options)).toEqual({
      nodeDeleted: false,
      warnings: [expect.stringContaining('allocation remains unresolved despite empty inventory')],
    });
    expect(provider.listVMs.mock.calls[0]?.[0]).toMatchObject({
      role: 'deployment',
      incarnation: 'incarnation',
      node: 'node',
    });
    expect(provider.deleteVM).not.toHaveBeenCalled();
    expect(row().runtime_termination_confirmed_at).toBeNull();
    expect(row().status).toBe('destroying');
  });

  it('never treats an empty inventory during a fresh in-flight allocation as termination proof', async () => {
    await seedNode({ providerInstanceId: null, createdAt: new Date().toISOString() });
    await seedEnvironment();
    expect((await stop()).status).toBe(409);
    expect(environment()).toMatchObject({ status: 'error', node_id: 'node' });
    expect(row().runtime_termination_confirmed_at).toBeNull();
    expect(provider.listVMs).not.toHaveBeenCalled();
    expect(provider.deleteVM).not.toHaveBeenCalled();
  });

  it('applies the fresh-allocation fence to direct node stops too', async () => {
    await seedNode({ providerInstanceId: null, createdAt: new Date().toISOString() });
    await seedEnvironment();
    await expect(stopNodeResources('node', 'user', env)).rejects.toThrow('remains unconfirmed');
    expect(provider.listVMs).not.toHaveBeenCalled();
    expect(row().runtime_termination_confirmed_at).toBeNull();
    expect(environment()).toMatchObject({ status: 'error', node_id: 'node' });
  });

  it.each(['exact', 'foreign', 'duplicate'])(
    'revalidates discovered providerless deployment ownership: %s',
    async (kind) => {
      await seedNode({ status: 'destroying', providerInstanceId: null });
      const vm = {
        id: 'discovered',
        location: 'fsn1',
        serverType: 'cx23',
        createdAt: '2026-10-22T08:53:44.000Z',
        labels: {
          node: 'node',
          role: 'deployment',
          managed: 'simple-agent-manager',
          env: 'production',
          installation: '0123456789abcdef0123456789abcdef',
          incarnation: kind === 'foreign' ? 'foreign' : 'incarnation',
        },
      };
      provider.listVMs.mockResolvedValue(kind === 'duplicate' ? [vm, vm] : [vm]);
      provider.getVM.mockResolvedValue(vm);
      const cleanup = await cleanupDeploymentNode(env, 'node', 'user', options);
      expect(cleanup.nodeDeleted).toBe(kind === 'exact');
      if (kind === 'exact') {
        expect(provider.getVM).toHaveBeenCalledWith(
          'discovered',
          expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
        expect(provider.deleteVM).toHaveBeenCalledWith(
          'discovered',
          expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
      } else {
        expect(provider.deleteVM).not.toHaveBeenCalled();
        expect(row().runtime_termination_confirmed_at).toBeNull();
      }
    }
  );

  it('confirms externally deleted VMs through the real provider adapter 404 path', async () => {
    await seedNode({ status: 'destroying' });
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'not_found', message: 'Server not found' } }),
          { status: 404 }
        )
    );
    vi.stubGlobal('fetch', fetch);
    const adapter = new HetznerProvider('fixture-token');
    provider.deleteVM.mockImplementationOnce((id, context) => adapter.deleteVM(id, context));
    expect(await cleanupDeploymentNode(env, 'node', 'user', options)).toEqual({
      nodeDeleted: true,
      warnings: [],
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.hetzner.cloud/v1/servers/123',
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(row().runtime_termination_confirmed_at).toEqual(expect.any(String));
    expect(row().status).toBe('deleted');
  });

  it('refuses missing legacy binding even if a guessed provider account would report absence', async () => {
    await seedNode({
      status: 'destroying',
      placementCredentialSource: null,
      placementCredentialReference: null,
      placementCredentialVersion: null,
      placementCredentialFingerprint: null,
    });
    expect((await cleanupDeploymentNode(env, 'node', 'user', options)).warnings).not.toHaveLength(
      0
    );
    expect(row().runtime_termination_confirmed_at).toBeNull();
    expect(provider.deleteVM).not.toHaveBeenCalled();
    expect(provider.listVMs).not.toHaveBeenCalled();
  });

  // Production node 01KXAR1T3XCQKKPBEJEERQ2PSZ (idea 01M6K6R2255R7414WSER4N3STJ): provisioned in
  // July with no placement credential binding, it sat `destroying` for 10 days. Strict deletion
  // refused it every hour, legacy binding recovery (#2472) refused it with a bare `false`, and the
  // claim cleared `cleanup_blocked_*` on every attempt, so nothing recorded why.
  describe('a legacy unbound deployment node that is already being torn down', () => {
    const LEGACY = {
      status: 'destroying',
      placementCredentialSource: null,
      placementCredentialReference: null,
      placementCredentialVersion: null,
      placementCredentialFingerprint: null,
      ipAddress: '203.0.113.8',
      agentReadyAt: '2026-10-22T08:58:00.000Z',
      credentialAttributionUserId: 'user',
      credentialAttributionSource: 'user',
    } as const;

    function decisions() {
      return sqlite
        .prepare(
          'SELECT source, decision, reason FROM node_lifecycle_decisions WHERE node_id = ? ORDER BY created_at'
        )
        .all('node') as Array<{ source: string; decision: string; reason: string | null }>;
    }

    it('recovers its binding from positive provider evidence, then deletes it', async () => {
      await seedNode(LEGACY);
      sqlite
        .prepare(
          `INSERT INTO credentials (id, user_id, provider, credential_type, is_active, encrypted_token, iv, created_at, updated_at)
           VALUES ('cloud-key', 'user', 'hetzner', 'cloud-provider', 1, 'ciphertext', 'fixture-iv', ?, ?)`
        )
        .run('2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
      // The exact credential the recovery binds resolves; any other generation is refused.
      const original = vi.mocked(createProviderForUser).getMockImplementation()!;
      onTestFinished(() => {
        vi.mocked(createProviderForUser).mockImplementation(original);
      });
      vi.mocked(createProviderForUser).mockImplementation(
        async (_db, _user, _key, _env, _provider, _project, binding) => {
          if (binding?.credentialReference !== 'credentials:cloud-key')
            throw new Error('Credential rotated');
          return { provider, providerName: 'hetzner' } as never;
        }
      );
      provider.getVM.mockResolvedValue({
        id: '123',
        ip: '203.0.113.8',
        location: 'fsn1',
        createdAt: '2026-10-22T08:55:00.000Z',
        labels: { node: 'node', managed: 'simple-agent-manager', role: 'deployment' },
      });

      expect(await runDeploymentNodeCleanup(env)).toEqual({ deleted: 1, failed: 0 });

      expect(provider.deleteVM).toHaveBeenCalledTimes(1);
      expect(provider.deleteVM.mock.calls[0]?.[0]).toBe('123');
      expect(row()).toMatchObject({
        status: 'deleted',
        placement_credential_reference: 'credentials:cloud-key',
        cleanup_blocked_since: null,
        cleanup_blocked_reason: null,
      });
      expect(decisions()).toEqual([
        {
          source: 'deployment_teardown',
          decision: 'destroyed',
          reason: 'strict_termination_proof',
        },
      ]);
    });

    it('records why it cannot be deleted and keeps the blocked clock across retries', async () => {
      // No provider evidence is possible (never reached agent-ready), so no binding is recovered.
      await seedNode({ ...LEGACY, agentReadyAt: null });
      vi.useFakeTimers({ now: Date.parse('2026-11-01T00:00:00.000Z'), toFake: ['Date'] });
      try {
        await cleanupDeploymentNode(env, 'node', 'user', options);
        const first = row();
        vi.setSystemTime(Date.parse('2026-11-01T01:05:00.000Z'));
        await cleanupDeploymentNode(env, 'node', 'user', options);

        expect(first.cleanup_blocked_since).toBe('2026-11-01T00:00:00.000Z');
        expect(row()).toMatchObject({
          status: 'destroying',
          cleanup_blocked_since: '2026-11-01T00:00:00.000Z',
          cleanup_blocked_reason: expect.stringContaining(
            'exact provider credential binding is missing'
          ),
        });
        expect(provider.deleteVM).not.toHaveBeenCalled();
        // Each attempt records the teardown failure and the ownership evidence that was missing.
        expect(
          decisions().map(({ source, decision, reason }) => ({ source, decision, reason }))
        ).toEqual([
          {
            source: 'cleanup_sweep',
            decision: 'legacy_binding_refused',
            reason: 'missing_agent_ready',
          },
          {
            source: 'deployment_teardown',
            decision: 'destroy_failed',
            reason: expect.stringContaining('exact provider credential binding is missing'),
          },
          {
            source: 'cleanup_sweep',
            decision: 'legacy_binding_refused',
            reason: 'missing_agent_ready',
          },
          {
            source: 'deployment_teardown',
            decision: 'destroy_failed',
            reason: expect.stringContaining('exact provider credential binding is missing'),
          },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears the recorded refusal once a later attempt deletes the node (control)', async () => {
      await seedNode({ status: 'destroying' });
      provider.deleteVM.mockRejectedValueOnce(new Error('provider unavailable'));
      await cleanupDeploymentNode(env, 'node', 'user', options);
      expect(row().cleanup_blocked_reason).toContain('provider unavailable');

      expect((await cleanupDeploymentNode(env, 'node', 'user', options)).nodeDeleted).toBe(true);
      expect(row()).toMatchObject({
        status: 'deleted',
        cleanup_blocked_since: null,
        cleanup_blocked_reason: null,
      });
    });
  });

  it('does not delete a shared node with another active environment', async () => {
    await seedNode();
    await seedEnvironment();
    await drizzle(env.DATABASE)
      .insert(schema.deploymentEnvironments)
      .values({
        id: 'other',
        projectId: 'project',
        name: 'other',
        nodeId: 'node',
        status: 'active',
      } as schema.NewDeploymentEnvironmentRow);
    expect((await stop()).status).toBe(200);
    expect(environment()).toMatchObject({ status: 'stopped', node_id: null });
    expect(row().status).toBe('running');
    expect(provider.deleteVM).not.toHaveBeenCalled();
  });

  it('does not mutate another owner or user-owned hardware', async () => {
    await seedNode({ nodeClass: 'user-owned' });
    expect(await cleanupDeploymentNode(env, 'node', 'user', options)).toEqual({
      nodeDeleted: false,
      warnings: [],
    });
    expect(await cleanupDeploymentNode(env, 'node', 'foreign', options)).toEqual({
      nodeDeleted: false,
      warnings: [],
    });
    expect(row().status).toBe('running');
    expect(provider.deleteVM).not.toHaveBeenCalled();
  });

  it('refuses incomplete providerless placement and inventory failure without inventing proof', async () => {
    await seedNode({ status: 'destroying', providerInstanceId: null, capacityPoolId: null });
    expect((await cleanupDeploymentNode(env, 'node', 'user', options)).nodeDeleted).toBe(false);
    expect(provider.listVMs).not.toHaveBeenCalled();
    sqlite.prepare("UPDATE nodes SET capacity_pool_id = 'pool'").run();
    provider.listVMs.mockRejectedValue(new Error('partial inventory'));
    expect((await cleanupDeploymentNode(env, 'node', 'user', options)).nodeDeleted).toBe(false);
    expect(row().runtime_termination_confirmed_at).toBeNull();
  });
});
