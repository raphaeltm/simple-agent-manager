/**
 * `POST /api/workspaces` with a `nodeId` on a managed node whose allocation authority changed.
 * The route used to surface the guard's plain Error as HTTP 500 (#2853); it must answer a
 * designed 409 and persist nothing, while the same request on a current node still succeeds.
 */
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { registerWorkspaceCreateRoute } from '../../../src/routes/workspaces/workspace-create';
import { directProvisioningHarness } from '../../helpers/direct-provisioning';
import { fixture, seedHost } from './node-pool-upgrade-test-helpers';

vi.mock('../../../src/middleware/auth', () => ({
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

afterEach(() => vi.unstubAllGlobals());

async function pinnedHost() {
  const f = fixture();
  const start = await f.run();
  const snapshot = await seedHost(f, start);
  // A provisioned node has a runtime incarnation; direct provisioning refuses one without it.
  f.sqlite
    .prepare("UPDATE nodes SET runtime_incarnation_id = 'incarnation-1' WHERE id = 'host'")
    .run();
  directProvisioningHarness(f.env);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('External HTTP unavailable in test');
    })
  );
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as never)
      : c.json({ error: error.message }, 500)
  );
  registerWorkspaceCreateRoute(app);
  const create = async (name: string) => {
    const pending: Promise<unknown>[] = [];
    const response = await app.request(
      '/',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, projectId: 'project-1', nodeId: 'host' }),
      },
      f.env,
      {
        waitUntil: (promise: Promise<unknown>) => {
          pending.push(promise);
        },
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext
    );
    const body = (await response.json()) as Record<string, unknown>;
    await Promise.allSettled(pending);
    return { status: response.status, body };
  };
  const workspacesNamed = (name: string) =>
    (
      f.sqlite.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE name = ?').get(name) as {
        n: number;
      }
    ).n;
  return { f, snapshot, create, workspacesNamed };
}

describe('pinned workspace creation on a node whose allocation authority changed', () => {
  it('places on the current node, then answers 409 and persists nothing once its source is excluded', async () => {
    const { f, snapshot, create, workspacesNamed } = await pinnedHost();

    // Owner-path control: the identical request succeeds while the node's source is current.
    const placed = await create('pinned-current');
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(placed.body.nodeId).toBe('host');
    expect(workspacesNamed('pinned-current')).toBe(1);

    f.sqlite
      .prepare('UPDATE capacity_pools SET excluded_source_ids_json = json_array(?) WHERE id = ?')
      .run(snapshot.capacitySourceId, snapshot.capacityPoolId);
    const refused = await create('pinned-excluded');
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body).toMatchObject({
      error: 'CONFLICT',
      message: 'Node allocation plan is no longer current. Choose another node or omit nodeId.',
    });
    expect(workspacesNamed('pinned-excluded')).toBe(0);
  });
});
