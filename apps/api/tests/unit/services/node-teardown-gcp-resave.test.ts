/**
 * The 2026-11-12 staging incident, reproduced through the real writers.
 *
 * A GCP node is placed with the user's GCP credential. The user saves the same GCP connection
 * again: `replaceUserGcpCredential` deletes the row and inserts a new one with a fresh ID, so the
 * node's pinned placement credential no longer exists. Before the fix, every teardown entry point
 * refused before ever calling GCP, and the VM ran on.
 *
 * Real: SQLite schema, credential encryption, `replaceUserGcpCredential`, credential resolution
 * (`createProviderForUser`), strict teardown, the owner DELETE route and `stopNodeResources`.
 * Faked: only the GCP API, as an in-memory cloud keyed by GCP project (the provider's network
 * boundary). Another GCP project is another account: it cannot see the first project's VMs.
 */
import { GCP_CREDENTIAL_VERSION } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as observabilitySchema from '../../../src/db/observability-schema';
import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import {
  applySqliteMigration,
  createAllSchemaTables,
  createSqliteD1,
} from '../../helpers/sqlite-d1';

type FakeInstance = { id: string; labels: Record<string, string> };
const cloud = vi.hoisted(() => ({
  /** GCP project id -> instance id -> instance. */
  projects: new Map<string, Map<string, { id: string; labels: Record<string, string> }>>(),
  getCalls: [] as Array<{ project: string; id: string }>,
  deleteCalls: [] as Array<{ project: string; id: string }>,
}));

vi.mock('@simple-agent-manager/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simple-agent-manager/providers')>();
  class FakeGcpProvider {
    readonly name = 'gcp';
    constructor(readonly projectId: string) {}
    async getVM(id: string) {
      cloud.getCalls.push({ project: this.projectId, id });
      const instance = cloud.projects.get(this.projectId)?.get(id);
      return instance
        ? {
            id: instance.id,
            name: `node-${id}`,
            ip: '192.0.2.10',
            status: 'running',
            serverType: 'e2-standard-2',
            createdAt: '2026-11-12T00:53:00.000Z',
            labels: { ...instance.labels },
          }
        : null;
    }
    async deleteVM(id: string) {
      cloud.deleteCalls.push({ project: this.projectId, id });
      cloud.projects.get(this.projectId)?.delete(id); // GCP delete is idempotent on 404.
    }
  }
  return { ...actual, GcpProvider: FakeGcpProvider };
});

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireSuperadmin: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => OWNER,
}));
// NodeLifecycle Durable Object RPC: the route's removal tail, not the teardown under test.
vi.mock('../../../src/services/node-lifecycle', () => ({ finalizeDeletion: vi.fn() }));

const { replaceUserGcpCredential } = await import('../../../src/services/gcp-credential-store');
const { createProviderForUser } = await import('../../../src/services/provider-credentials');
const { stopNodeResources } = await import('../../../src/services/nodes');
const { nodesRoutes } = await import('../../../src/routes/nodes');

const OWNER = 'smoke-user';
const NODE_ID = '01M76KWK9N8K6616BM10RPKNWF';
const INSTANCE_ID = '5572383107926504222';
const INCARNATION = '7c1d2a40-0d55-4a7e-9a2f-4f0b5b3c2d11';
const INSTALLATION = '0123456789abcdef0123456789abcdef';
const ENCRYPTION_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

let sqlite: Database.Database;
let observability: Database.Database;
let env: Env;

function gcpCredential(projectId: string) {
  return {
    version: GCP_CREDENTIAL_VERSION,
    provider: 'gcp',
    authType: 'workload-identity',
    gcpProjectId: projectId,
    gcpProjectNumber: '353771248703',
    serviceAccountEmail: `sam-vm-manager@${projectId}.iam.gserviceaccount.com`,
    wifPoolId: 'sam-pool',
    wifProviderId: 'sam-oidc',
    defaultZone: 'europe-west1-b',
  } as Parameters<typeof replaceUserGcpCredential>[2];
}

function samLabels(overrides: Record<string, string> = {}) {
  return {
    'sam-managed': 'true',
    managed: 'simple-agent-manager',
    node: NODE_ID.toLowerCase(),
    role: 'workspace',
    env: 'staging',
    installation: INSTALLATION,
    incarnation: INCARNATION,
    ...overrides,
  };
}

function putInstance(project: string, instance: FakeInstance) {
  if (!cloud.projects.has(project)) cloud.projects.set(project, new Map());
  cloud.projects.get(project)!.set(instance.id, instance);
}

/** Place a node exactly as provisioning does: resolve the owner's credential, pin its binding. */
async function placeNode(nodeRole: 'workspace' | 'deployment' = 'workspace'): Promise<string> {
  const db = drizzle(env.DATABASE, { schema });
  const resolved = await createProviderForUser(db, OWNER, ENCRYPTION_KEY, env, 'gcp', null);
  const binding = resolved?.exactCredentialBinding;
  expect(binding?.credentialReference).toBeTruthy();
  await db.insert(schema.nodes).values({
    id: NODE_ID,
    userId: OWNER,
    name: 'gcp node',
    status: 'running',
    runtime: 'vm',
    nodeRole,
    nodeClass: 'managed',
    vmSize: 'medium',
    vmLocation: 'europe-west1-b',
    cloudProvider: 'gcp',
    providerInstanceId: INSTANCE_ID,
    providerInstanceType: 'e2-standard-2',
    runtimeIncarnationId: INCARNATION,
    credentialSource: 'user',
    credentialAttributionUserId: OWNER,
    credentialAttributionSource: 'user',
    placementCredentialSource: binding!.credentialSource,
    placementCredentialReference: binding!.credentialReference,
    placementCredentialVersion: binding!.credentialVersion ?? null,
    placementCredentialFingerprint: binding!.credentialFingerprint ?? null,
    healthStatus: 'healthy',
  });
  return binding!.credentialReference!;
}

function nodeRow() {
  return sqlite
    .prepare(
      `SELECT status, runtime_termination_confirmed_at AS proof, cleanup_blocked_reason AS reason,
        cleanup_blocked_alerted_at AS alertedAt FROM nodes WHERE id = ?`
    )
    .get(NODE_ID) as
    | { status: string; proof: string | null; reason: string | null; alertedAt: string | null }
    | undefined;
}

function pinnedRowExists(reference: string): boolean {
  const [table, id] = reference.split(':') as [string, string];
  return !!sqlite.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
}

function ownerDelete() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) =>
    err instanceof AppError
      ? c.json(err.toJSON(), err.statusCode as never)
      : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
  );
  app.route('/api/nodes', nodesRoutes);
  return app.request(`/api/nodes/${NODE_ID}`, { method: 'DELETE' }, env);
}

beforeEach(async () => {
  cloud.projects.clear();
  cloud.getCalls.length = 0;
  cloud.deleteCalls.length = 0;
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  // The owner DELETE audit relies on the shipped node_health_events uniqueness constraint.
  sqlite.exec('DROP TABLE node_health_events');
  applySqliteMigration(
    sqlite,
    new URL('../../../src/db/migrations/0172_node_health_events.sql', import.meta.url)
  );
  observability = new Database(':memory:');
  createAllSchemaTables(observability, observabilitySchema);
  sqlite
    .prepare('INSERT INTO users (id, github_id, email, role, status) VALUES (?, ?, ?, ?, ?)')
    .run(OWNER, OWNER, `${OWNER}@example.com`, 'user', 'active');
  sqlite
    .prepare('INSERT INTO users (id, github_id, email, role, status) VALUES (?, ?, ?, ?, ?)')
    .run('other-user', 'other-user', 'other@example.com', 'user', 'active');
  env = {
    DATABASE: createSqliteD1(sqlite),
    OBSERVABILITY_DATABASE: createSqliteD1(observability),
    ENCRYPTION_KEY,
    ENVIRONMENT: 'staging',
    SAM_INSTALLATION_ID: INSTALLATION,
    BASE_DOMAIN: 'sammy.party',
  } as unknown as Env;
  await replaceUserGcpCredential(env, OWNER, gcpCredential('sam-staging-infra'));
});

afterEach(() => {
  sqlite.close();
  observability.close();
});

describe('node teardown after the GCP connection is saved again (incident 2026-11-12)', () => {
  it('owner DELETE tears the VM down through the re-saved credential after proving ownership', async () => {
    const pinned = await placeNode();
    putInstance('sam-staging-infra', { id: INSTANCE_ID, labels: samLabels() });

    // The exact incident shape: same GCP project, re-saved, new row ID.
    await replaceUserGcpCredential(env, OWNER, gcpCredential('sam-staging-infra'));
    expect(pinnedRowExists(pinned)).toBe(false);

    const response = await ownerDelete();

    expect(response.status, await response.clone().text()).toBe(200);
    expect(cloud.deleteCalls).toEqual([{ project: 'sam-staging-infra', id: INSTANCE_ID }]);
    // The instance was re-read before the delete: ownership comes from the resource.
    expect(cloud.getCalls).toEqual([{ project: 'sam-staging-infra', id: INSTANCE_ID }]);
    expect(nodeRow()).toBeUndefined();
  });

  it('NodeLifecycle stop tears the VM down through the re-saved credential', async () => {
    const pinned = await placeNode();
    putInstance('sam-staging-infra', { id: INSTANCE_ID, labels: samLabels() });
    await replaceUserGcpCredential(env, OWNER, gcpCredential('sam-staging-infra'));
    expect(pinnedRowExists(pinned)).toBe(false);

    await stopNodeResources(NODE_ID, OWNER, env);

    expect(cloud.deleteCalls).toEqual([{ project: 'sam-staging-infra', id: INSTANCE_ID }]);
    expect(nodeRow()).toMatchObject({ proof: expect.any(String) });
  });

  it('control: an unrotated credential keeps the pinned path and needs no ownership read', async () => {
    await placeNode();
    putInstance('sam-staging-infra', { id: INSTANCE_ID, labels: {} });

    const response = await ownerDelete();

    expect(response.status).toBe(200);
    expect(cloud.getCalls).toEqual([]);
    expect(cloud.deleteCalls).toEqual([{ project: 'sam-staging-infra', id: INSTANCE_ID }]);
  });

  it('control: a pinned credential still reaches an instance that is already gone', async () => {
    await placeNode();

    const response = await ownerDelete();

    expect(response.status).toBe(200);
    expect(cloud.deleteCalls).toEqual([{ project: 'sam-staging-infra', id: INSTANCE_ID }]);
    expect(nodeRow()).toBeUndefined();
  });

  it('preserves an instance whose provider ID differs from the recorded one, even with matching labels', async () => {
    await placeNode();
    // GCP looks instances up by ID or name; a different instance answering for this node's
    // lookup is not the VM SAM recorded.
    putInstance('sam-staging-infra', { id: '999', labels: samLabels() });
    cloud.projects.get('sam-staging-infra')!.set(INSTANCE_ID, { id: '999', labels: samLabels() });
    await replaceUserGcpCredential(env, OWNER, gcpCredential('sam-staging-infra'));

    const response = await ownerDelete();

    expect(response.status).toBe(409);
    expect(cloud.deleteCalls).toEqual([]);
    expect(nodeRow()).toMatchObject({ reason: 'teardown_instance_ownership_mismatch' });
  });

  it.each([
    ['deployment node with its deployment label', 'deployment', 'deployment', true],
    ['deployment node whose VM is labelled as a workspace', 'deployment', 'workspace', false],
    ['workspace node whose VM is labelled as a deployment', 'workspace', 'deployment', false],
  ] as const)('%s', async (_name, nodeRole, roleLabel, deleted) => {
    await placeNode(nodeRole);
    putInstance('sam-staging-infra', { id: INSTANCE_ID, labels: samLabels({ role: roleLabel }) });
    await replaceUserGcpCredential(env, OWNER, gcpCredential('sam-staging-infra'));

    const response = await ownerDelete();

    expect(response.status).toBe(deleted ? 200 : 409);
    expect(cloud.deleteCalls).toEqual(
      deleted ? [{ project: 'sam-staging-infra', id: INSTANCE_ID }] : []
    );
    if (!deleted) {
      expect(nodeRow()).toMatchObject({ reason: 'teardown_instance_ownership_mismatch' });
    }
  });

  it('claims the operator alert only for the runtime and blocked episode the caller observed', async () => {
    await placeNode();
    const { alertNodeCleanupBlocked } = await import('../../../src/services/node-teardown-blocked');
    sqlite
      .prepare(
        "UPDATE nodes SET status = 'destroying', cleanup_blocked_since = '2026-11-13T23:00:00.000Z' WHERE id = ?"
      )
      .run(NODE_ID);
    const input = {
      nodeId: NODE_ID,
      userId: OWNER,
      status: 'destroying',
      blockedSince: '2026-11-13T23:00:00.000Z',
      reasons: ['teardown_instance_not_visible'],
      provider: 'gcp',
      providerInstanceId: INSTANCE_ID,
      runtimeIncarnationId: INCARNATION,
      recoveryType: 'node_teardown_blocked',
    };
    const now = new Date('2026-11-13T23:05:00.000Z');

    // A stale caller that observed an older incarnation or another episode claims nothing.
    await alertNodeCleanupBlocked(env, { ...input, runtimeIncarnationId: 'older' }, now, 60_000);
    await alertNodeCleanupBlocked(env, { ...input, blockedSince: '2026-11-13T22:00:00.000Z' }, now, 60_000);
    expect(nodeRow()).toMatchObject({ alertedAt: null });

    // Control: the matching runtime and episode is claimed and alerted.
    await alertNodeCleanupBlocked(env, input, now, 60_000);
    expect(nodeRow()).toMatchObject({ alertedAt: now.toISOString() });
  });

  it('records a blocked verdict only on the runtime incarnation that was refused', async () => {
    await placeNode();
    const { recordNodeTeardownBlocked } = await import(
      '../../../src/services/node-teardown-blocked'
    );
    const { NodeTeardownBlockedError } = await import(
      '../../../src/services/node-teardown-authority'
    );
    sqlite.prepare("UPDATE nodes SET status = 'destroying' WHERE id = ?").run(NODE_ID);
    const db = drizzle(env.DATABASE, { schema });
    const [stale] = await db.select().from(schema.nodes);
    // The node was re-provisioned after the refused attempt read it.
    sqlite.prepare("UPDATE nodes SET runtime_incarnation_id = 'replacement' WHERE id = ?").run(NODE_ID);

    await recordNodeTeardownBlocked(
      env,
      stale!,
      new NodeTeardownBlockedError('teardown_instance_not_visible', 'test')
    );
    expect(nodeRow()).toMatchObject({ reason: null, alertedAt: null });

    // Control: the same verdict on the current incarnation is recorded and alerted.
    const [current] = await db.select().from(schema.nodes);
    await recordNodeTeardownBlocked(
      env,
      current!,
      new NodeTeardownBlockedError('teardown_instance_not_visible', 'test')
    );
    expect(nodeRow()).toMatchObject({
      reason: 'teardown_instance_not_visible',
      alertedAt: expect.any(String),
    });
  });

  it('a reconnect to a different GCP project blocks visibly instead of deleting or retrying silently', async () => {
    await placeNode();
    putInstance('sam-staging-infra', { id: INSTANCE_ID, labels: samLabels() });
    await replaceUserGcpCredential(env, OWNER, gcpCredential('another-project'));

    const response = await ownerDelete();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      message: expect.stringContaining('teardown_instance_not_visible'),
    });
    expect(cloud.deleteCalls).toEqual([]);
    expect(cloud.projects.get('sam-staging-infra')?.has(INSTANCE_ID)).toBe(true);
    expect(nodeRow()).toMatchObject({
      status: 'destroying',
      proof: null,
      reason: 'teardown_instance_not_visible',
      alertedAt: expect.any(String),
    });
    const alerts = observability
      .prepare("SELECT message FROM platform_errors WHERE node_id = ? AND level = 'error'")
      .all(NODE_ID) as Array<{ message: string }>;
    expect(alerts).toEqual([
      { message: expect.stringContaining(`VM may still exist at provider: gcp ${INSTANCE_ID}`) },
    ]);
  });

  it('never uses another user\'s credential, even one that can see the instance', async () => {
    await placeNode();
    putInstance('sam-staging-infra', { id: INSTANCE_ID, labels: samLabels() });
    // The owner disconnects GCP; a different user connects the SAME GCP project.
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        "DELETE FROM credentials WHERE user_id = ? AND provider = 'gcp'"
      ).bind(OWNER),
      env.DATABASE.prepare('DELETE FROM cc_attachments WHERE user_id = ?').bind(OWNER),
    ]);
    await replaceUserGcpCredential(env, 'other-user', gcpCredential('sam-staging-infra'));

    const response = await ownerDelete();

    expect(response.status).toBe(409);
    expect(cloud.getCalls).toEqual([]);
    expect(cloud.deleteCalls).toEqual([]);
    expect(nodeRow()).toMatchObject({ reason: 'teardown_credential_unavailable', proof: null });
  });
});

describe('proveNodeInstanceOwnership: provider refusals', () => {
  async function prove(error: Error) {
    const { proveNodeInstanceOwnership } = await import(
      '../../../src/services/node-teardown-authority'
    );
    const node = {
      id: NODE_ID,
      nodeRole: 'workspace',
      providerInstanceId: INSTANCE_ID,
      runtimeIncarnationId: INCARNATION,
    } as unknown as Parameters<typeof proveNodeInstanceOwnership>[0];
    const candidate = {
      provider: { getVM: async () => Promise.reject(error) },
      providerName: 'gcp',
      credentialSource: 'user',
    } as unknown as Parameters<typeof proveNodeInstanceOwnership>[2][number];
    return proveNodeInstanceOwnership(node, env, [candidate]).catch((err: unknown) => err as Error);
  }

  it('a credential the provider rejects cannot see the instance (named verdict)', async () => {
    const { ProviderError } = await import('@simple-agent-manager/providers');
    const result = await prove(new ProviderError('gcp', 403, 'Permission denied'));
    expect(result.message).toMatch(/^teardown_instance_not_visible/);
  });

  it('a GCP token-exchange refusal (GcpApiError 401/403) cannot see the instance', async () => {
    const { GcpApiError } = await import('../../../src/services/gcp-errors');
    for (const statusCode of [401, 403]) {
      const result = await prove(
        new GcpApiError({ step: 'sa_impersonation', message: 'Permission denied', statusCode })
      );
      expect(result.message).toMatch(/^teardown_instance_not_visible/);
    }
  });

  it('a permission refusal whose text merely contains "rate" is still a refusal', async () => {
    const { GcpApiError } = await import('../../../src/services/gcp-errors');
    const result = await prove(
      new GcpApiError({
        step: 'sa_impersonation',
        message: 'Permission denied on projects/corporate-prod',
        statusCode: 403,
        rawBody: '{"error":{"status":"PERMISSION_DENIED","message":"generate access token denied"}}',
      })
    );
    expect(result.message).toMatch(/^teardown_instance_not_visible/);
  });

  it('a refusal whose message names a "quota" resource is still a refusal (structured codes decide)', async () => {
    const { GcpApiError } = await import('../../../src/services/gcp-errors');
    const { ProviderError } = await import('@simple-agent-manager/providers');
    const cases = [
      new GcpApiError({
        step: 'sa_impersonation',
        message: 'Permission denied on projects/quota-prod',
        statusCode: 403,
        rawBody:
          '{"error":{"code":403,"status":"PERMISSION_DENIED","message":"Permission iam.serviceAccounts.getAccessToken denied on projects/quota-prod",' +
          '"details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"IAM_PERMISSION_DENIED"}]}}',
      }),
      new GcpApiError({
        step: 'sts_exchange',
        message: 'The caller does not have access to rate-limit-tests',
        statusCode: 401,
        rawBody: '{"error":"invalid_grant","error_description":"token for project quota-prod is revoked"}',
      }),
      new ProviderError('hetzner', 403, 'hetzner API error (403): forbidden on project quota-prod', {
        providerCode: 'forbidden',
      }),
    ];
    for (const error of cases) {
      expect((await prove(error)).message).toMatch(/^teardown_instance_not_visible/);
    }
  });

  it('a GCP or Hetzner limit stays an ordinary, retryable read failure', async () => {
    const { GcpApiError } = await import('../../../src/services/gcp-errors');
    const { ProviderError } = await import('@simple-agent-manager/providers');
    const cases = [
      new GcpApiError({ step: 'sts_exchange', message: 'Too many requests', statusCode: 429 }),
      new GcpApiError({
        step: 'sa_impersonation',
        message: 'Forbidden',
        statusCode: 403,
        rawBody: '{"error":{"status":"PERMISSION_DENIED","details":[{"reason":"RATE_LIMIT_EXCEEDED"}]}}',
      }),
      new GcpApiError({
        step: 'sa_impersonation',
        message: 'Forbidden',
        statusCode: 403,
        rawBody: '{"error":{"status":"RESOURCE_EXHAUSTED","message":"denied"}}',
      }),
      new GcpApiError({
        step: 'sa_impersonation',
        message: 'Forbidden',
        statusCode: 403,
        rawBody: '{"error":{"status":"PERMISSION_DENIED","errors":[{"reason":"quotaExceeded"}]}}',
      }),
      // providerFetch leaves category unknown; the provider code still says it is a limit.
      new ProviderError('hetzner', 403, 'limit reached', { providerCode: 'rate_limit_exceeded' }),
      // Google ErrorInfo recorded by providerFetch on a GCP compute 403.
      new ProviderError('gcp', 403, 'gcp API error (403): denied', {
        providerCode: 'PERMISSION_DENIED',
        context: { googleErrorInfo: { reason: 'RATE_LIMIT_EXCEEDED', domain: 'googleapis.com' } },
      }),
    ];
    for (const error of cases) {
      expect(await prove(error)).toBe(error);
    }
  });

  it('a rate-limited or quota 403 stays an ordinary, retryable read failure', async () => {
    const { ProviderError } = await import('@simple-agent-manager/providers');
    for (const category of ['rate_limited', 'quota_exceeded'] as const) {
      const error = new ProviderError('gcp', 403, 'Rate limit exceeded', { category });
      const result = await prove(error);
      expect(result).toBe(error);
    }
  });
});

