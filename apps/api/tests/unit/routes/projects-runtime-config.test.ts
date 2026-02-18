import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../../../src/index';
import { projectsRoutes } from '../../../src/routes/projects';

const mocks = vi.hoisted(() => ({
  requireOwnedProject: vi.fn(),
  encrypt: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  getUserId: () => 'user-1',
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireOwnedProject: mocks.requireOwnedProject,
}));
vi.mock('../../../src/services/encryption', () => ({
  encrypt: mocks.encrypt,
}));

describe('projects runtime config routes', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockDB: any;
  let limitResponses: any[];
  let orderByResponses: any[];

  beforeEach(() => {
    vi.clearAllMocks();
    limitResponses = [];
    orderByResponses = [];

    const queryBuilder = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn(() => Promise.resolve(limitResponses.shift() ?? [])),
      orderBy: vi.fn(() => Promise.resolve(orderByResponses.shift() ?? [])),
    };

    mockDB = {
      select: vi.fn().mockReturnValue(queryBuilder),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    };

    (drizzle as any).mockReturnValue(mockDB);

    mocks.requireOwnedProject.mockResolvedValue({
      id: 'proj-1',
      userId: 'user-1',
      installationId: 'inst-1',
      repository: 'acme/repo',
      defaultBranch: 'main',
    });
    mocks.encrypt.mockResolvedValue({ ciphertext: 'enc-value', iv: 'enc-iv' });

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/projects', projectsRoutes);
  });

  it('GET /api/projects/:id/runtime-config masks secret values', async () => {
    orderByResponses.push(
      [
        {
          envKey: 'API_TOKEN',
          storedValue: 'encrypted-token',
          valueIv: 'iv',
          isSecret: true,
          createdAt: '2026-02-18T00:00:00.000Z',
          updatedAt: '2026-02-18T00:00:00.000Z',
        },
      ],
      [
        {
          filePath: '.env.local',
          storedContent: 'FOO=bar',
          contentIv: null,
          isSecret: false,
          createdAt: '2026-02-18T00:00:00.000Z',
          updatedAt: '2026-02-18T00:00:00.000Z',
        },
      ]
    );

    const res = await app.request('/api/projects/proj-1/runtime-config', { method: 'GET' }, {
      DATABASE: {} as any,
      ENCRYPTION_KEY: 'test-key',
    } as Env);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.envVars[0]).toMatchObject({
      key: 'API_TOKEN',
      isSecret: true,
      hasValue: true,
      value: null,
    });
    expect(body.files[0]).toMatchObject({
      path: '.env.local',
      isSecret: false,
      hasValue: true,
      content: 'FOO=bar',
    });
  });

  it('POST /api/projects/:id/runtime/env-vars encrypts secret values before update', async () => {
    limitResponses.push([{ id: 'env-1' }]);
    orderByResponses.push(
      [
        {
          envKey: 'API_TOKEN',
          storedValue: 'enc-value',
          valueIv: 'enc-iv',
          isSecret: true,
          createdAt: '2026-02-18T00:00:00.000Z',
          updatedAt: '2026-02-18T00:00:00.000Z',
        },
      ],
      []
    );

    const res = await app.request('/api/projects/proj-1/runtime/env-vars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'API_TOKEN',
        value: 'plain-secret',
        isSecret: true,
      }),
    }, {
      DATABASE: {} as any,
      ENCRYPTION_KEY: 'test-key',
    } as Env);

    expect(res.status).toBe(200);
    expect(mocks.encrypt).toHaveBeenCalledWith('plain-secret', 'test-key');
    expect(mockDB.update).toHaveBeenCalled();
    expect(mockDB.set).toHaveBeenCalledWith(
      expect.objectContaining({
        storedValue: 'enc-value',
        valueIv: 'enc-iv',
        isSecret: true,
      })
    );
  });
});
