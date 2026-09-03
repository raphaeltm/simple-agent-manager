import { Hono } from 'hono';
import { vi } from 'vitest';

import type { Env } from '../../../../src/env';
import { handleAppError } from '../../../../src/middleware/app-error-handler';

vi.mock('../../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireSuperadmin: () =>
    vi.fn(
      (
        c: {
          req: { header: (name: string) => string | undefined };
          json: (body: unknown, status: 403) => Response;
        },
        next: () => Promise<void>
      ) =>
        c.req.header('x-test-role') === 'superadmin'
          ? next()
          : c.json({ error: 'FORBIDDEN', message: 'Superadmin access required' }, 403)
    ),
}));

const { requireAuth, requireApproved, requireSuperadmin } =
  await import('../../../../src/middleware/auth');
const { adminProjectDataStorageRoutes } =
  await import('../../../../src/routes/admin/project-data-storage');

export function createAdminProjectDataStorageApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.use(
    '/api/admin/project-data/storage/*',
    requireAuth(),
    requireApproved(),
    requireSuperadmin()
  );
  app.route('/api/admin/project-data/storage', adminProjectDataStorageRoutes);
  return app;
}
