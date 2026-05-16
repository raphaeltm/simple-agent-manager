import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { profileRuntimeRoutes } from '../../../src/routes/profile-runtime';

const mocks = vi.hoisted(() => ({
  requireOwnedProject: vi.fn(),
  encrypt: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  getUserId: () => 'user-1',
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireOwnedProject: mocks.requireOwnedProject,
}));
vi.mock('../../../src/services/encryption', () => ({
  encrypt: mocks.encrypt,
}));

describe('profile runtime routes', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockDB: any;
  let limitResponses: any[];
  let whereResponses: any[];
  let orderByResponses: any[];

  beforeEach(() => {
    vi.clearAllMocks();
    limitResponses = [];
    whereResponses = [];
    orderByResponses = [];

    const makeQueryBuilder = (isCountQuery = false): any => {
      const queryBuilder = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn(() => {
          if (isCountQuery) {
            return Promise.resolve(whereResponses.shift() ?? []);
          }
          return queryBuilder;
        }),
        limit: vi.fn(() => Promise.resolve(limitResponses.shift() ?? [])),
        orderBy: vi.fn(() => Promise.resolve(orderByResponses.shift() ?? [])),
      };
      return queryBuilder;
    };

    mockDB = {
      select: vi.fn((fields?: Record<string, unknown>) => makeQueryBuilder(Boolean(fields?.count))),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    };

    (drizzle as any).mockReturnValue(mockDB);
    mocks.requireOwnedProject.mockResolvedValue({ id: 'proj-1', userId: 'user-1' });
    mocks.encrypt.mockResolvedValue({ ciphertext: 'enc-value', iv: 'enc-iv' });

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/projects/:projectId/agent-profiles/:profileId/runtime', profileRuntimeRoutes);
  });

  it('lists profile env vars with secret values masked', async () => {
    limitResponses.push([{ id: 'prof-1', projectId: 'proj-1', userId: 'user-1' }]);
    orderByResponses.push(
      [
        {
          envKey: 'API_TOKEN',
          storedValue: 'encrypted-token',
          valueIv: 'iv',
          isSecret: true,
          createdAt: '2026-05-16T00:00:00.000Z',
          updatedAt: '2026-05-16T00:00:00.000Z',
        },
      ],
      []
    );

    const res = await app.request('/api/projects/proj-1/agent-profiles/prof-1/runtime/env-vars', {
      method: 'GET',
    }, {
      DATABASE: {} as any,
      ENCRYPTION_KEY: 'test-key',
    } as Env);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.envVars).toEqual([
      expect.objectContaining({
        key: 'API_TOKEN',
        value: null,
        isSecret: true,
        hasValue: true,
      }),
    ]);
  });

  it('creates encrypted secret profile env vars', async () => {
    limitResponses.push(
      [{ id: 'prof-1', projectId: 'proj-1', userId: 'user-1' }],
      []
    );
    whereResponses.push([{ count: 0 }]);
    orderByResponses.push(
      [
        {
          envKey: 'API_TOKEN',
          storedValue: 'enc-value',
          valueIv: 'enc-iv',
          isSecret: true,
          createdAt: '2026-05-16T00:00:00.000Z',
          updatedAt: '2026-05-16T00:00:00.000Z',
        },
      ],
      []
    );

    const res = await app.request('/api/projects/proj-1/agent-profiles/prof-1/runtime/env-vars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'API_TOKEN', value: 'plain-secret', isSecret: true }),
    }, {
      DATABASE: {} as any,
      ENCRYPTION_KEY: 'test-key',
    } as Env);

    expect(res.status).toBe(200);
    expect(mocks.encrypt).toHaveBeenCalledWith('plain-secret', 'test-key');
    expect(mockDB.insert).toHaveBeenCalled();
    expect(mockDB.values).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'prof-1',
      userId: 'user-1',
      envKey: 'API_TOKEN',
      storedValue: 'enc-value',
      valueIv: 'enc-iv',
      isSecret: true,
    }));
  });

  it('rejects profile runtime access when the profile is outside the project', async () => {
    limitResponses.push([]);

    const res = await app.request('/api/projects/proj-1/agent-profiles/other-prof/runtime/env-vars', {
      method: 'GET',
    }, {
      DATABASE: {} as any,
      ENCRYPTION_KEY: 'test-key',
    } as Env);

    expect(res.status).toBe(404);
  });

  it('deletes profile env vars after validating the key', async () => {
    limitResponses.push([{ id: 'prof-1', projectId: 'proj-1', userId: 'user-1' }]);
    orderByResponses.push([], []);

    const res = await app.request('/api/projects/proj-1/agent-profiles/prof-1/runtime/env-vars/API_TOKEN', {
      method: 'DELETE',
    }, {
      DATABASE: {} as any,
      ENCRYPTION_KEY: 'test-key',
    } as Env);

    expect(res.status).toBe(200);
    expect(mockDB.delete).toHaveBeenCalled();
  });
});
