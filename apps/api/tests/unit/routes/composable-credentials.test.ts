import { inspect } from 'node:util';

import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { ccRoutes } from '../../../src/routes/composable-credentials';

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => unknown) => next()),
  getUserId: () => 'test-user-id',
}));

interface MockDB {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
}

function makeMockDB(): MockDB {
  const db: Partial<MockDB> = {};
  db.select = vi.fn().mockReturnValue(db);
  db.from = vi.fn().mockReturnValue(db);
  db.where = vi.fn().mockReturnValue(db);
  db.limit = vi.fn().mockReturnValue(db);
  db.update = vi.fn().mockReturnValue(db);
  db.set = vi.fn().mockReturnValue(db);
  db.delete = vi.fn().mockReturnValue(db);
  db.returning = vi.fn().mockResolvedValue([{ id: 'updated' }]);
  return db as MockDB;
}

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/cc', ccRoutes);
  return app;
}

describe('composable credentials routes', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockDB: MockDB;
  const env = { DATABASE: {} as D1Database, ENCRYPTION_KEY: 'test-key' } as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    app = makeApp();
    mockDB = makeMockDB();
    (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockDB);
  });

  it('updates a configuration by decoded ID and verifies replacement credential ownership', async () => {
    mockDB.limit
      .mockResolvedValueOnce([{ id: 'cred-1' }])
      .mockResolvedValueOnce([{ consumerKind: 'agent', consumerTarget: 'openai-codex' }]);
    const rawId = 'cfg/user+auth=with/slash';

    const res = await app.request(
      `/api/cc/configurations/${encodeURIComponent(rawId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Updated Codex config',
          credentialId: 'cred-1',
          settings: { model: 'gpt-5' },
          isActive: false,
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    expect(mockDB.set).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Updated Codex config',
        credentialId: 'cred-1',
        settingsJson: JSON.stringify({ model: 'gpt-5' }),
        isActive: false,
      })
    );
    const whereCalls = inspect(mockDB.where.mock.calls, { depth: 8 });
    expect(whereCalls).toContain(rawId);
    expect(whereCalls).toContain('test-user-id');
  });

  it('deletes configurations using the decoded ID scoped to the current owner', async () => {
    const rawId = 'cfg/delete+equals=/id';

    const res = await app.request(
      `/api/cc/configurations/${encodeURIComponent(rawId)}`,
      { method: 'DELETE' },
      env
    );

    expect(res.status).toBe(200);
    expect(mockDB.delete).toHaveBeenCalled();
    const whereCalls = inspect(mockDB.where.mock.calls, { depth: 8 });
    expect(whereCalls).toContain(rawId);
    expect(whereCalls).toContain('test-user-id');
  });
});
