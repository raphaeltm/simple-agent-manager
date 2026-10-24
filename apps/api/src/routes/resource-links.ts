import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { requireProjectAccess } from '../middleware/project-auth';
import { getFileContext, getIdeaContext, getSessionContext } from '../operations/link-core';

export const resourceLinkRoutes = new Hono<{ Bindings: Env }>();

resourceLinkRoutes.get('/ideas/:ideaId/links', requireAuth(), requireApproved(), async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  await requireProjectAccess(drizzle(c.env.DATABASE, { schema }), projectId, getUserId(c));
  return c.json(await getIdeaContext(c.env, projectId, requireRouteParam(c, 'ideaId')));
});
resourceLinkRoutes.get(
  '/sessions/:sessionId/links',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const projectId = requireRouteParam(c, 'projectId');
    await requireProjectAccess(drizzle(c.env.DATABASE, { schema }), projectId, getUserId(c));
    return c.json(await getSessionContext(c.env, projectId, requireRouteParam(c, 'sessionId')));
  }
);
resourceLinkRoutes.get('/library/:fileId/links', requireAuth(), requireApproved(), async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  await requireProjectAccess(drizzle(c.env.DATABASE, { schema }), projectId, getUserId(c));
  return c.json(await getFileContext(c.env, projectId, requireRouteParam(c, 'fileId')));
});
