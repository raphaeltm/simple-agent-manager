import { Hono } from 'hono';
import { vi } from 'vitest';

import type { Env } from '../../../src/env';
import { credentialsRoutes } from '../../../src/routes/credentials';

export function createCredentialsTestApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });

  app.route('/api/credentials', credentialsRoutes);
  return app;
}

export function makeCredentialDbMock() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
  };
}
