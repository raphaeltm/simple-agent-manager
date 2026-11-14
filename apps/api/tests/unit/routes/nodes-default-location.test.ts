/**
 * POST /api/nodes without a location (box round R13 D8).
 *
 * On a self-hosted box with only a Google Cloud platform credential, the route defaulted to
 * DEFAULT_VM_LOCATION (Hetzner nbg1) and the allocation answered "No eligible compute-pool
 * offering ... location nbg1". On a box (VM_AGENT_TRANSPORT=reverse-tunnel) an omitted location
 * now stays unset and the installation pool decides; Cloudflare installs keep nbg1 (control).
 *
 * Real route, real allocation (`resolveCanonicalVmAllocationPlan`) and real pool publication on
 * a real SQLite engine; only the node record write and provisioning start are stubbed, and they
 * record what the route asked for.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { AppError } from '../../../src/middleware/error';
import { updateDefaultCapacityPool } from '../../../src/services/default-capacity-pool-updates';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import { offering } from '../../helpers/capacity-pool-offerings';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
import { seedUser } from './capacity-pool-test-seeds';

const USER_ID = 'user-1';
const created: Array<Record<string, unknown>> = [];

vi.mock('../../../src/middleware/auth', () => ({
  getUserId: () => 'user-1',
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../../src/services/nodes', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createNodeRecord: vi.fn(async (_env: unknown, input: Record<string, unknown>) => {
    created.push(input);
    return { id: 'node-new', ...input };
  }),
}));
vi.mock('../../../src/services/direct-provisioning', () => ({
  scheduleDirectProvisioning: vi.fn(async () => undefined),
}));
vi.mock('../../../src/services/telemetry', () => ({ recordNodeRoutingMetric: vi.fn() }));

let sqlite: Database.Database | null = null;

beforeEach(async () => {
  created.length = 0;
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  seedUser(sqlite, USER_ID, 'superadmin');
  // The box's only cloud account: a Google Cloud platform credential (bootstrap JSON in prod).
  sqlite
    .prepare(
      `INSERT INTO platform_credentials (
         id, credential_type, provider, label, encrypted_token, iv, is_enabled, created_by,
         created_at, updated_at
       ) VALUES ('platform-gcp', 'cloud-provider', 'gcp', 'gcp platform', 'ciphertext', 'iv', 1,
         ?, '2026-11-14T00:00:00.000Z', '2026-11-14T00:00:00.000Z')`
    )
    .run(USER_ID);
  const d1 = drizzle(createSqliteD1(sqlite), { schema });
  await ensureDefaultCapacityPoolsForExistingCredentials(d1 as never, {
    candidatePublishBatchSize: 1000,
    offeringResolver: async () => [offering('gcp', 'europe-west1-b', 'e2-standard-2')],
  });
  // Admin -> Infrastructure: add the machine to the installation pool (R13: "e2-standard-2 Belgium").
  const candidates = sqlite
    .prepare("SELECT id FROM capacity_pool_candidates WHERE workload_role = 'workspace'")
    .all() as Array<{ id: string }>;
  expect(candidates.length).toBeGreaterThan(0);
  const picked = await updateDefaultCapacityPool(d1 as never, {
    scope: 'installation',
    ownerUserId: null,
    ownerProjectId: null,
    candidates: candidates.map(({ id }) => ({ id, status: 'active' as const })),
  });
  expect(picked.conflict).toBe(false);
});

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

async function postNode(body: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const { nodesRoutes } = await import('../../../src/routes/nodes');
  const app = new Hono();
  app.route('/api/nodes', nodesRoutes);
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 500);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: String(err) }, 500);
  });
  const res = await app.request(
    '/api/nodes',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'n1', ...body }),
    },
    {
      DATABASE: createSqliteD1(sqlite as Database.Database),
      COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
      ...extraEnv,
    }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const SELF_HOST = { VM_AGENT_TRANSPORT: 'reverse-tunnel' };

describe('POST /api/nodes without a location', () => {
  it('on a self-hosted box: the installation pool decides (a GCP zone, not nbg1)', async () => {
    const res = await postNode({ vmSize: 'small' }, SELF_HOST);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      cloudProvider: 'gcp',
      vmLocation: 'europe-west1-b',
      providerInstanceType: 'e2-standard-2',
    });
  });

  it('on a self-hosted box: naming the provider without a location also works', async () => {
    const res = await postNode({ provider: 'gcp' }, SELF_HOST);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(created[0]).toMatchObject({ cloudProvider: 'gcp', vmLocation: 'europe-west1-b' });
  });

  it('control, Cloudflare install: the default stays nbg1, exactly as before', async () => {
    const res = await postNode({ vmSize: 'small' });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('location nbg1');
    expect(created).toEqual([]);
  });

  it('control: an explicit location is used as given, on either install', async () => {
    for (const env of [SELF_HOST, {}]) {
      created.length = 0;
      const ok = await postNode({ vmLocation: 'europe-west1-b' }, env);
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect(created[0]).toMatchObject({ vmLocation: 'europe-west1-b' });
    }
    const wrong = await postNode({ vmLocation: 'nbg1' }, SELF_HOST);
    expect(wrong.status).toBe(400);
    expect(String(wrong.body.message)).toContain('location nbg1');
  });
});
