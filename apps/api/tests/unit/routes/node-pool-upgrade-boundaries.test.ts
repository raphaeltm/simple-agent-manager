/** Shipped migrations and external HTTP/JWT boundaries joined to the shared upgrade slice. */
import { readdirSync,readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { nodeLifecycleRoutes } from '../../../src/routes/node-lifecycle';
import { clearCapacityCatalogCache } from '../../../src/services/default-capacity-source-credentials';
import { encrypt } from '../../../src/services/encryption';
import { signNodeCallbackToken } from '../../../src/services/jwt';
import { provisionNode } from '../../../src/services/nodes';
import {
  assertReserved,
  type Fixture,
  fixture,
  reserve,
  seedHost,
  select,
} from './node-pool-upgrade-test-helpers';

const migrationDirectory = join(process.cwd(), 'src/db/migrations');
const migrations = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const encryptionKey = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
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

async function connectHttpBoundaries(f: Fixture) {
  Object.assign(f.env, keys, {
    ENCRYPTION_KEY: encryptionKey,
    CF_ZONE_ID: 'test-zone',
    CF_API_TOKEN: 'test-dns-token',
  });
  const secret = await encrypt('test-provider-token', encryptionKey);
  f.sqlite
    .prepare('UPDATE credentials SET encrypted_token = ?, iv = ? WHERE id = ?')
    .run(secret.ciphertext, secret.iv, 'cloud');
  clearCapacityCatalogCache();
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    requests.push({ url, method, body });
    if (url.includes('api.hetzner.cloud/v1/server_types'))
      return Response.json({
        server_types: [serverType],
        meta: { pagination: { next_page: null } },
      });
    if (url.endsWith('/servers') && method === 'POST')
      return Response.json({
        server: {
          id: 321,
          name: body?.name,
          status: 'running',
          created: '2026-09-07T00:00:00Z',
          public_net: { ipv4: { ip: '203.0.113.2' } },
          server_type: serverType,
          labels: body?.labels ?? {},
        },
      });
    if (url.includes('api.cloudflare.com/client/v4/zones/test-zone/dns_records'))
      return Response.json({ success: true, result: { id: 'dns-host' } });
    throw new Error(`Unexpected external HTTP boundary: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  return requests;
}

async function heartbeat(
  f: Fixture,
  nodeId: string,
  body: Record<string, unknown>,
  tokenNodeId = nodeId
) {
  Object.assign(f.env, keys);
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as never)
      : c.json({ error: error.message }, 500)
  );
  app.route('/api/nodes', nodeLifecycleRoutes);
  const pending: Promise<unknown>[] = [];
  const response = await app.request(
    `/api/nodes/${nodeId}/heartbeat`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await signNodeCallbackToken(tokenNodeId, f.env)}`,
      },
      body: JSON.stringify(body),
    },
    f.env,
    {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext
  );
  await Promise.allSettled(pending);
  return response;
}

describe('node-pool upgrade boundaries', () => {
  it.each(['pre-pool', 'abstract-candidate'])(
    'preserves %s rows and FKs through the real migration chain and admits the legacy request afterward',
    async (upgradeStage) => {
      const sqlite = new Database(':memory:');
      sqlite.pragma('foreign_keys = ON');
      for (const file of migrations.filter((name) => name < '0125_'))
        sqlite.exec(readFileSync(join(migrationDirectory, file), 'utf8'));
      const f = fixture('user', sqlite);
      sqlite.exec(`INSERT INTO nodes (id, user_id, name, status, vm_size, vm_location, cloud_provider)
      VALUES ('historical-host', 'user-1', 'Existing host', 'running', 'large', 'fsn1', 'hetzner');
      INSERT INTO workspaces (id, user_id, project_id, node_id, installation_id, name, repository, branch, status, vm_size, vm_location)
      VALUES ('historical-workspace', 'user-1', 'project-1', 'historical-host', 'installation-1', 'Existing work', 'acme/capacity-project', 'main', 'sleeping', 'small', 'fsn1');
      UPDATE tasks SET workspace_id = 'historical-workspace' WHERE id = 'task-1';`);
      const history = sqlite
        .prepare('SELECT id, user_id, project_id, node_id, status, vm_size FROM workspaces')
        .all();
      for (const file of migrations.filter((name) => name >= '0125_' && name < '0127_'))
        sqlite.exec(readFileSync(join(migrationDirectory, file), 'utf8'));
      const poolId = 'cap-pool-default:user:user-1';
      const sourceId = 'cap-source-default:user:cloud';
      const abstractId = `cap-candidate-default:${poolId}:${sourceId}:hetzner:fsn1:small`;
      if (upgradeStage === 'abstract-candidate') {
        sqlite
          .prepare(
            `INSERT INTO capacity_pools (id, scope, owner_user_id, name, is_default, created_by)
        VALUES (?, 'user', 'user-1', 'Existing pool', 1, 'user-1')`
          )
          .run(poolId);
        sqlite
          .prepare(
            `INSERT INTO capacity_sources (id, scope, owner_user_id, source_kind, provider, credential_source, credential_id, credential_reference, created_by)
        VALUES (?, 'user', 'user-1', 'cloud-provider-credential', 'hetzner', 'user', 'cloud', 'credentials:cloud', 'user-1')`
          )
          .run(sourceId);
        sqlite
          .prepare(
            `INSERT INTO capacity_pool_candidates (id, pool_id, capacity_source_id, provider, location, workload_role, runtime, machine_class, machine_size)
        VALUES (?, ?, ?, 'hetzner', 'fsn1', 'workspace', 'vm', 'shared-vm', 'small')`
          )
          .run(abstractId, poolId, sourceId);
      }
      for (const file of migrations.filter((name) => name >= '0127_'))
        sqlite.exec(readFileSync(join(migrationDirectory, file), 'utf8'));
      expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
      await connectHttpBoundaries(f);
      const start = await f.run();
      const snapshot = await seedHost(f, start);
      expect(await select(f, start)).toMatchObject({ nodeId: 'host' });
      expect(await reserve(f, start, snapshot)).toBe(true);
      assertReserved(f, start, snapshot);
      if (upgradeStage === 'abstract-candidate') {
        expect(snapshot.capacityPoolId).toBe(poolId);
        expect(snapshot.capacitySourceId).toBe(sourceId);
        expect(snapshot.providerInstanceType).toBe('cx23');
        expect(
          sqlite
            .prepare('SELECT provider_instance_type FROM capacity_pool_candidates WHERE id = ?')
            .get(abstractId)
        ).toEqual({ provider_instance_type: null });
      }
      expect(
        sqlite
          .prepare(
            "SELECT id, user_id, project_id, node_id, status, vm_size FROM workspaces WHERE id = 'historical-workspace'"
          )
          .all()
      ).toEqual(history);
      expect(sqlite.prepare('SELECT count(*) n FROM tasks WHERE id = ?').get('task-1')).toEqual({
        n: 1,
      });
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
      expect(() =>
        sqlite.prepare("UPDATE workspaces SET node_id = 'missing' WHERE id = 'new-workspace'").run()
      ).toThrow(/FOREIGN KEY/);
    }
  );

  it('accepts an old-agent heartbeat without erasing native plans or observed hardware, then admits using those preserved resources', async () => {
    const f = fixture();
    const requests = await connectHttpBoundaries(f);
    const start = await f.run();
    const snapshot = await seedHost(f, start);
    f.sqlite.exec(
      "UPDATE nodes SET ip_address = '203.0.113.2', backend_dns_record_id = 'dns-host' WHERE id = 'host'"
    );
    const hardwareSql = `SELECT provider_instance_type, provider_instance_vcpu_count, provider_instance_memory_mb,
      provider_instance_disk_gb, observed_provider_instance_type, observed_provider_instance_vcpu_count,
      observed_provider_instance_memory_mb, observed_provider_instance_disk_gb, observed_hardware_source,
      capacity_pool_id, capacity_source_id, placement_credential_reference, vm_size FROM nodes WHERE id = 'host'`;
    const before = f.sqlite.prepare(hardwareSql).get();
    // Older agents send aggregate pressure only: no version, native plan or observed hardware.
    const response = await heartbeat(f, 'host', {
      metrics: { cpuLoadAvg1: 0.1, memoryPercent: 5, diskPercent: 5 },
    });
    expect(response.status, await response.text()).toBe(200);
    expect(f.sqlite.prepare(hardwareSql).get()).toEqual(before);
    expect(await select(f, start)).toMatchObject({ nodeId: 'host' });
    expect(await reserve(f, start, snapshot)).toBe(true);
    assertReserved(f, start, snapshot);
    expect(requests.filter((request) => request.method === 'POST')).toEqual([]);
    const denied = await heartbeat(f, 'host', {}, 'other-host');
    expect(denied.status).toBe(401);
    expect(f.sqlite.prepare(hardwareSql).get()).toEqual(before);
  });

  it('provisions an old queued legacy request through the real provider and records observed native hardware before atomic admission', async () => {
    const f = fixture();
    const requests = await connectHttpBoundaries(f);
    const start = await f.run();
    const snapshot = await seedHost(f, start);
    // The row is the queued plan's immutable native allocation, with a deliberately contradictory old hint.
    f.sqlite.exec(
      "UPDATE nodes SET status = 'creating', provider_instance_id = NULL, vm_size = 'large', observed_provider_instance_type = NULL, observed_provider_instance_vcpu_count = NULL, observed_provider_instance_memory_mb = NULL, observed_provider_instance_disk_gb = NULL, observed_hardware_source = NULL WHERE id = 'host'"
    );
    await provisionNode(
      'host',
      f.env,
      { taskId: start.taskId, projectId: start.projectId, chatSessionId: 'chat-1' },
      { rethrowProviderError: true }
    );
    const paid = requests.filter(
      (request) => request.url.endsWith('/servers') && request.method === 'POST'
    );
    expect(paid).toHaveLength(1);
    expect(paid[0]?.body).toMatchObject({
      server_type: snapshot.providerInstanceType,
      location: start.config.vmLocation,
      image: 'docker-ce',
    });
    expect(paid[0]?.body?.user_data).toEqual(expect.stringContaining('host'));
    expect(
      f.sqlite
        .prepare(
          `SELECT status, provider_instance_id, observed_provider_instance_type,
      observed_provider_instance_vcpu_count, observed_provider_instance_memory_mb, observed_provider_instance_disk_gb FROM nodes WHERE id = 'host'`
        )
        .get()
    ).toEqual({
      status: 'running',
      provider_instance_id: '321',
      observed_provider_instance_type: 'cx23',
      observed_provider_instance_vcpu_count: 2,
      observed_provider_instance_memory_mb: 4096,
      observed_provider_instance_disk_gb: 40,
    });
    expect(await reserve(f, start, snapshot)).toBe(true);
    assertReserved(f, start, snapshot);
  });

  it('rejects a removed old queued plan before any paid provider request', async () => {
    const f = fixture();
    const requests = await connectHttpBoundaries(f);
    const start = await f.run();
    const snapshot = await seedHost(f, start);
    f.sqlite.exec(
      "UPDATE nodes SET status = 'creating', provider_instance_id = NULL WHERE id = 'host'"
    );
    f.sqlite
      .prepare("UPDATE capacity_pool_candidates SET status = 'deleted' WHERE id = ?")
      .run(snapshot.capacityPoolCandidateId);
    await expect(
      provisionNode(
        'host',
        f.env,
        { taskId: start.taskId, projectId: start.projectId, chatSessionId: 'chat-1' },
        { rethrowProviderError: true }
      )
    ).rejects.toThrow(/authority|plan|allocation/i);
    expect(
      requests.filter((request) => request.url.endsWith('/servers') && request.method === 'POST')
    ).toEqual([]);
    expect(
      f.sqlite.prepare('SELECT provider_instance_id FROM nodes WHERE id = ?').get('host')
    ).toEqual({ provider_instance_id: null });
    expect(f.sqlite.prepare('SELECT count(*) n FROM workspaces').get()).toEqual({ n: 0 });
  });
});
