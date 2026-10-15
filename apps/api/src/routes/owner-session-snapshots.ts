import { Hono } from 'hono';

import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getAuth, requireApproved, requireAuth } from '../middleware/auth';
import { AppError, errors } from '../middleware/error';
import {
  exportOwnerSessionSnapshot,
  retainedSnapshotNotFound,
} from '../services/owner-session-snapshot-export';

/** Separate browser owner path. Workspace callback routes retain their original JWT contract. */
const ownerSessionSnapshotRoutes = new Hono<{ Bindings: Env }>();
ownerSessionSnapshotRoutes.use('/:sessionId/retained-snapshot/*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  await next();
});
ownerSessionSnapshotRoutes.use('/:sessionId/retained-snapshot/*', requireAuth(), requireApproved());
// Object store/DO errors can contain keys or private metadata. Never reflect or log them.
ownerSessionSnapshotRoutes.onError((error, c) => {
  const safe =
    error instanceof AppError ? error : errors.internal('Retained snapshot download unavailable');
  return c.json(safe.toJSON(), safe.statusCode as 404, {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
});
ownerSessionSnapshotRoutes.get('/:sessionId/retained-snapshot/:artifact', async (c) => {
  const artifact = c.req.param('artifact');
  if ((artifact !== 'manifest' && artifact !== 'wip') || new URL(c.req.url).search !== '')
    throw retainedSnapshotNotFound();
  const auth = getAuth(c);
  if (auth.user.status !== 'active') throw errors.forbidden('Account approval required');
  const response = await exportOwnerSessionSnapshot(c.env, {
    projectId: requireRouteParam(c, 'projectId'),
    sessionId: requireRouteParam(c, 'sessionId'),
    userId: auth.user.id,
    artifact,
  });
  if (c.req.method === 'HEAD') {
    void response.body?.cancel().catch(() => undefined);
    return new Response(null, response);
  }
  return response;
});
export { ownerSessionSnapshotRoutes };
