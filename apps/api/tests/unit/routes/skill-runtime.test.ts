import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { skillRuntimeRoutes } from '../../../src/routes/skill-runtime';
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

describe('skill runtime routes', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockDB: any;
  let limitResponses: any[];
  let whereResponses: any[];
  let orderByResponses: any[];
  const runtimeBindings = {
    DATABASE: {} as any,
    ENCRYPTION_KEY: 'test-key',
  } as Env;

  const skillRow = { id: 'skill-1', projectId: 'proj-1', userId: 'user-1' };

  const envVarRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
    envKey: 'API_TOKEN',
    storedValue: 'enc-value',
    valueIv: 'enc-iv',
    isSecret: true,
    createdAt: '2026-05-31T00:00:00.000Z',
    updatedAt: '2026-05-31T00:00:00.000Z',
    ...overrides,
  });

  const requestRuntime = (path: string, init: RequestInit) =>
    app.request(`/api/projects/proj-1/skills/skill-1/runtime${path}`, init, runtimeBindings);

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
      '/api/projects/:projectId/skills/:skillId/runtime',
      skillRuntimeRoutes
    );
  });

  it('lists skill env vars with secret values masked', async () => {
    limitResponses.push([skillRow]);
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

  it('creates encrypted secret skill env vars', async () => {
    limitResponses.push([skillRow], []);
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
      skillId: 'skill-1',
      userId: 'user-1',
      envKey: 'API_TOKEN',
      storedValue: 'enc-value',
      valueIv: 'enc-iv',
      isSecret: true,
    }));
  });

  it('rejects skill runtime access when the skill is outside the project', async () => {
    limitResponses.push([]);

    const res = await app.request('/api/projects/proj-1/skills/other-skill/runtime/env-vars', {
      method: 'GET',
    }, runtimeBindings);

    expect(res.status).toBe(404);
  });

  it('deletes skill env vars after validating the key', async () => {
    limitResponses.push([skillRow]);
    orderByResponses.push([], []);

    const res = await requestRuntime('/env-vars/API_TOKEN', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(mockDB.delete).toHaveBeenCalled();
  });
});
