import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => {
    const authHeader = c.req.header('x-test-auth');
    if (authHeader === 'none') {
      throw new ErrorWithStatus(401, 'UNAUTHORIZED', 'Authentication required');
    }

    c.set('auth', {
      user: {
        id: c.req.header('x-test-user-id') ?? 'admin-1',
        email: 'admin@example.com',
        name: 'Admin User',
        avatarUrl: null,
        role: c.req.header('x-test-role') ?? 'admin',
        status: c.req.header('x-test-status') ?? 'active',
      },
      session: {
        id: 'session-1',
        expiresAt: new Date('2026-04-22T00:00:00.000Z'),
      },
    });

    return next();
  }),
  requireApproved: () => vi.fn((c: any, next: any) => {
    const auth = c.get('auth');
    const requireApproval = c.env.REQUIRE_APPROVAL === 'true';
    if (!requireApproval || auth.user.role === 'admin' || auth.user.role === 'superadmin') {
      return next();
    }
    if (auth.user.status === 'active') {
      return next();
    }
    if (auth.user.status === 'suspended') {
      throw new ErrorWithStatus(403, 'FORBIDDEN', 'Your account has been suspended');
    }
    throw new ErrorWithStatus(403, 'APPROVAL_REQUIRED', 'Your account is pending admin approval');
  }),
  requireAdmin: () => vi.fn((c: any, next: any) => {
    const auth = c.get('auth');
    if (auth.user.role !== 'admin' && auth.user.role !== 'superadmin') {
      throw new ErrorWithStatus(403, 'FORBIDDEN', 'Admin access required');
    }
    return next();
  }),
  getUserId: (c: any) => c.get('auth').user.id,
}));

class ErrorWithStatus extends Error {
  statusCode: number;
  error: string;

  constructor(statusCode: number, error: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.error = error;
  }
}

vi.mock('../../../src/middleware/error', () => {
  return {
    errors: {
      badRequest: (msg: string) => new ErrorWithStatus(400, 'BAD_REQUEST', msg),
      notFound: (entity: string) => new ErrorWithStatus(404, 'NOT_FOUND', `${entity} not found`),
      forbidden: (msg: string) => new ErrorWithStatus(403, 'FORBIDDEN', msg),
      unauthorized: (msg: string) => new ErrorWithStatus(401, 'UNAUTHORIZED', msg),
    },
    AppError: ErrorWithStatus,
  };
});

const selectQueue: unknown[] = [];
const insertValues = vi.fn();
const updateSet = vi.fn();
const deleteWhere = vi.fn();

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => {
      const runner = {
        from: () => runner,
        where: () => runner,
        orderBy: () => Promise.resolve(selectQueue.shift() ?? []),
        limit: () => Promise.resolve(selectQueue.shift() ?? []),
        then: (resolve: (value: unknown) => unknown) => resolve(selectQueue.shift() ?? []),
      };
      return runner;
    },
    insert: () => ({
      values: (...args: unknown[]) => {
        insertValues(...args);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (...args: unknown[]) => {
        updateSet(...args);
        return {
          where: (...whereArgs: unknown[]) => {
            updateSet.mock.lastCall?.push(whereArgs);
            return Promise.resolve();
          },
        };
      },
    }),
    delete: () => ({
      where: (...args: unknown[]) => {
        deleteWhere(...args);
        return Promise.resolve();
      },
    }),
  }),
}));

vi.mock('../../../src/schemas', () => ({
  UpsertPlatformInfraAssociationSchema: {},
  jsonValidator: () => async (c: any, next: any) => {
    const body = await c.req.json();
    c.req.valid = () => body;
    await next();
  },
}));

const { adminPlatformInfraRoutes } = await import('../../../src/routes/admin-platform-infra');

describe('Admin platform infra routes', () => {
  let app: Hono<{ Bindings: Env }>;

  function createEnv(): Env {
    return {
      DATABASE: {} as D1Database,
    } as Env;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/admin/platform-infra', adminPlatformInfraRoutes);
  });

  it('lists platform-managed nodes with users and associations', async () => {
    selectQueue.push(
      [
        {
          id: 'node-1',
          userId: 'system_anonymous_trials',
          name: 'trial-node',
          status: 'running',
          healthStatus: 'healthy',
          cloudProvider: 'hetzner',
          vmSize: 'medium',
          vmLocation: 'nbg1',
          credentialSource: 'platform',
          lastHeartbeatAt: null,
          errorMessage: null,
          createdAt: '2026-04-22T00:00:00.000Z',
        },
      ],
      [{ id: 'user-1', email: 'alice@example.com', name: 'Alice' }],
      [{ id: 'ws-1', nodeId: 'node-1', status: 'running', projectId: 'proj-1' }],
      [{ nodeId: 'node-1', userId: 'user-1', reason: 'trial', associatedBy: 'admin-1', createdAt: '2026-04-22T00:00:00.000Z', updatedAt: '2026-04-22T00:00:00.000Z' }],
      [{ id: 'trial-1', projectId: 'proj-1', status: 'ready', repoOwner: 'acme', repoName: 'demo', claimedByUserId: null }],
      [{ id: 'user-1', email: 'alice@example.com', name: 'Alice' }],
    );

    const res = await app.request('/api/admin/platform-infra', {}, createEnv());
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body.users).toHaveLength(1);
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].association.userEmail).toBe('alice@example.com');
    expect(body.nodes[0].trial.repoName).toBe('demo');
  });

  it('creates an association for a platform node', async () => {
    selectQueue.push(
      [{ id: 'node-1', credentialSource: 'platform', status: 'running' }],
      [{ id: 'user-1', email: 'alice@example.com', name: 'Alice', status: 'active' }],
      [],
    );

    const res = await app.request(
      '/api/admin/platform-infra/nodes/node-1/association',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1', reason: 'trial' }),
      },
      createEnv(),
    );

    expect(res.status).toBe(200);
    expect(insertValues).toHaveBeenCalled();
    const body = await res.json() as any;
    expect(body.userId).toBe('user-1');
    expect(body.reason).toBe('trial');
  });

  it('rejects associating a non-platform node', async () => {
    selectQueue.push(
      [{ id: 'node-1', credentialSource: 'user', status: 'running' }],
      [{ id: 'user-1', email: 'alice@example.com', name: 'Alice', status: 'active' }],
    );

    const res = await app.request(
      '/api/admin/platform-infra/nodes/node-1/association',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1', reason: 'trial' }),
      },
      createEnv(),
    );

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.message).toContain('Only platform-managed nodes');
  });

  it('rejects unauthenticated access', async () => {
    const res = await app.request(
      '/api/admin/platform-infra',
      {
        headers: { 'x-test-auth': 'none' },
      },
      createEnv(),
    );

    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.message).toContain('Authentication required');
  });

  it('rejects non-admin access', async () => {
    const res = await app.request(
      '/api/admin/platform-infra',
      {
        headers: { 'x-test-role': 'user', 'x-test-status': 'active' },
      },
      createEnv(),
    );

    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.message).toContain('Admin access required');
  });
});
