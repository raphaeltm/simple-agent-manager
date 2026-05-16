import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { profileRuntimeRoutes } from '../../../src/routes/profile-runtime';
import { createRouteTestApp } from './route-test-app';

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
  const runtimeBindings = {
    DATABASE: {} as any,
    ENCRYPTION_KEY: 'test-key',
  } as Env;

  const profileRow = { id: 'prof-1', projectId: 'proj-1', userId: 'user-1' };

  const envVarRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
    envKey: 'API_TOKEN',
    storedValue: 'enc-value',
    valueIv: 'enc-iv',
    isSecret: true,
    createdAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:00.000Z',
    ...overrides,
  });

  const requestRuntime = (path: string, init: RequestInit) =>
    app.request(`/api/projects/proj-1/agent-profiles/prof-1/runtime${path}`, init, runtimeBindings);

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

    app = createRouteTestApp(
      '/api/projects/:projectId/agent-profiles/:profileId/runtime',
      profileRuntimeRoutes
    );
  });

  it('lists profile env vars with secret values masked', async () => {
    limitResponses.push([profileRow]);
    orderByResponses.push([envVarRow({ storedValue: 'encrypted-token', valueIv: 'iv' })], []);

    const res = await requestRuntime('/env-vars', { method: 'GET' });

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
      [profileRow],
      []
    );
    whereResponses.push([{ count: 0 }]);
    orderByResponses.push([envVarRow()], []);

    const res = await requestRuntime('/env-vars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'API_TOKEN', value: 'plain-secret', isSecret: true }),
    });

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
    }, runtimeBindings);

    expect(res.status).toBe(404);
  });

  it('deletes profile env vars after validating the key', async () => {
    limitResponses.push([profileRow]);
    orderByResponses.push([], []);

    const res = await requestRuntime('/env-vars/API_TOKEN', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(mockDB.delete).toHaveBeenCalled();
  });
});
