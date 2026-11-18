import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import {
  applySqliteMigration,
  createAllSchemaTables,
  createSqliteD1,
} from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  requireNodeOwnership: vi.fn(),
  deleteNodeResources: vi.fn(),
  finalizeDeletion: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-1',
}));

vi.mock('../../../src/middleware/node-auth', () => ({
  requireNodeOwnership: (...args: unknown[]) => mocks.requireNodeOwnership(...args),
}));

vi.mock('../../../src/services/nodes', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/services/nodes')>();
  return {
    ...original,
    deleteNodeResources: (...args: unknown[]) => mocks.deleteNodeResources(...args),
  };
});

vi.mock('../../../src/services/node-lifecycle', () => ({
  finalizeDeletion: (...args: unknown[]) => mocks.finalizeDeletion(...args),
}));

import { drizzle } from 'drizzle-orm/d1';

import { nodesRoutes } from '../../../src/routes/nodes';
import { deleteOwnedNode } from '../../../src/routes/nodes/delete';

const TERMINATION_PROOF_AT = '2026-09-04T09:00:00.000Z';
const ORIGINAL_INCARNATION = 'runtime-node-1';

describe('DELETE /api/nodes/:id managed-node proof predicates — real SQL vertical slice', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  function seedNode(runtimeIncarnationId = ORIGINAL_INCARNATION): void {
    sqlite
      .prepare(
        `INSERT INTO nodes (
           id, user_id, name, status, node_role, node_class,
           runtime_termination_confirmed_at, runtime_incarnation_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'node-1',
        'user-1',
        'Managed node',
        'deleted',
        'workspace',
        'managed',
        TERMINATION_PROOF_AT,
        runtimeIncarnationId
      );
  }

  function seedWorkspace(id: string, proofAt: string | null, userId = 'user-1'): void {
    sqlite
      .prepare(
        `INSERT INTO workspaces (
           id, node_id, user_id, name, repository, branch, status,
           vm_size, vm_location, runtime_deletion_confirmed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        'node-1',
        userId,
        id,
        'example/repository',
        'main',
        'stopping',
        'small',
        'nbg1',
        proofAt
      );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    // This route now relies on the shipped audit uniqueness constraint.
    sqlite.exec('DROP TABLE node_health_events');
    applySqliteMigration(
      sqlite,
      new URL('../../../src/db/migrations/0172_node_health_events.sql', import.meta.url)
    );
    env = { DATABASE: createSqliteD1(sqlite) } as Env;

    mocks.requireNodeOwnership.mockResolvedValue({
      id: 'node-1',
      userId: 'user-1',
      status: 'deleted',
      healthStatus: 'unhealthy',
      createdAt: '2026-09-04T08:00:00.000Z',
      lastHeartbeatAt: null,
      nodeRole: 'workspace',
      nodeClass: 'managed',
      runtimeIncarnationId: ORIGINAL_INCARNATION,
    });
    mocks.deleteNodeResources.mockResolvedValue({
      nodeFound: true,
      runtimeTerminationConfirmed: true,
      runtimeTerminationConfirmedAt: TERMINATION_PROOF_AT,
      runtimeIncarnationId: ORIGINAL_INCARNATION,
      providerVmDeleted: true,
      providerVmDeleteSkippedReason: null,
      backendDnsDeleted: true,
      errors: [],
    });
    mocks.finalizeDeletion.mockResolvedValue(undefined);

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) =>
      err instanceof AppError
        ? c.json(err.toJSON(), err.statusCode as never)
        : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
    );
    app.route('/api/nodes', nodesRoutes);
  });

  afterEach(() => sqlite.close());

  it.each(['DELETE', 'POST'])(
    'rejects owner/manual %s before provider teardown or attestation when a builder is reserved',
    async (method) => {
      seedNode();
      sqlite.exec(`INSERT INTO deployment_publish_jobs
      (id,node_id,executor,context_shadow,executor_instance_id,status)
      VALUES ('job','node-1','cloudflare',0,'job','succeeded')`);
      const response = await app.request(
        `/api/nodes/node-1${method === 'POST' ? '/manual-deletion' : ''}`,
        {
          method,
          ...(method === 'POST'
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirmed: true }),
              }
            : {}),
        },
        env
      );
      expect(response.status).toBe(409);
      expect(mocks.deleteNodeResources).not.toHaveBeenCalled();
      expect(mocks.finalizeDeletion).not.toHaveBeenCalled();
      expect(sqlite.prepare('SELECT runtime_termination_attested_at FROM nodes').get()).toEqual({
        runtime_termination_attested_at: null,
      });
      expect(sqlite.prepare('SELECT id FROM deployment_publish_jobs').get()).toEqual({ id: 'job' });
    }
  );

  it('the shared Operations delete_node entry point rejects before provider teardown', async () => {
    seedNode();
    sqlite.exec(`INSERT INTO deployment_publish_jobs
      (id,node_id,executor,context_shadow,executor_instance_id,status)
      VALUES ('job','node-1','cloudflare',0,'job','building')`);
    await expect(
      deleteOwnedNode(
        env,
        drizzle(env.DATABASE, { schema }),
        await mocks.requireNodeOwnership(),
        'user-1'
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.deleteNodeResources).not.toHaveBeenCalled();
    expect(mocks.finalizeDeletion).not.toHaveBeenCalled();
  });

  it('deletes only workspaces carrying the matching proof and the exact node incarnation', async () => {
    seedNode();
    seedWorkspace('workspace-confirmed', TERMINATION_PROOF_AT);
    seedWorkspace('workspace-unconfirmed', null);
    seedWorkspace('workspace-stale-proof', '2026-09-04T08:59:59.000Z');
    seedWorkspace('workspace-other-user', TERMINATION_PROOF_AT, 'user-2');

    const response = await app.request('/api/nodes/node-1', { method: 'DELETE' }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(sqlite.prepare('SELECT id FROM workspaces ORDER BY id').all()).toEqual([
      { id: 'workspace-other-user' },
      { id: 'workspace-stale-proof' },
      { id: 'workspace-unconfirmed' },
    ]);
    expect(sqlite.prepare('SELECT id FROM nodes WHERE id = ?').get('node-1')).toBeUndefined();
    expect(mocks.finalizeDeletion).toHaveBeenCalledWith(env, 'node-1', 'user-1');
  });

  it('returns 409 and refuses lifecycle finalization when the node incarnation changes', async () => {
    seedNode('runtime-node-2');
    seedWorkspace('workspace-confirmed', TERMINATION_PROOF_AT);

    const response = await app.request('/api/nodes/node-1', { method: 'DELETE' }, env);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      message: 'Node incarnation changed before deletion audit',
    });
    expect(
      sqlite.prepare('SELECT runtime_incarnation_id FROM nodes WHERE id = ?').get('node-1')
    ).toEqual({ runtime_incarnation_id: 'runtime-node-2' });
    expect(mocks.finalizeDeletion).not.toHaveBeenCalled();
  });
});
