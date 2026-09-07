import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId } from '../middleware/auth';
import { AppError, errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import * as projectData from '../services/project-data';
import { rethrowScheduleError, scheduleRequestBody } from './project-schedules';

/** Human project policies: deliberately absent from agent MCP mutation tools. */
export const projectStandingWatchRoutes = new Hono<{ Bindings: Env }>();
projectStandingWatchRoutes.onError((error, c) => {
  try { rethrowScheduleError(error); } catch (mapped) {
    if (mapped instanceof AppError) return c.json(mapped.toJSON(), mapped.statusCode as 400);
    throw mapped;
  }
});
projectStandingWatchRoutes.use('*', async (c, next) => {
  await requireProjectCapability(
    drizzle(c.env.DATABASE, { schema }),
    requireRouteParam(c, 'projectId'),
    getUserId(c),
    c.req.method === 'GET' ? 'task:read' : 'task:write'
  );
  try {
    await next();
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'ProjectStandingWatchNotFoundError' ||
        error.message.startsWith('ProjectStandingWatchNotFoundError:'))
    )
      throw errors.notFound('Standing watch');
    rethrowScheduleError(error);
  }
});
projectStandingWatchRoutes.get('/', async (c) =>
  c.json(
    await projectData.listProjectStandingWatches(c.env, requireRouteParam(c, 'projectId'), {
      userId: getUserId(c),
      cursor: c.req.query('cursor'),
      sessionId: c.req.query('sessionId'),
      limit: c.req.query('limit') === undefined ? undefined : Number(c.req.query('limit')),
    })
  )
);
projectStandingWatchRoutes.get('/:id', async (c) => {
  const watch = await projectData.getProjectStandingWatch(
    c.env,
    requireRouteParam(c, 'projectId'),
    { userId: getUserId(c), id: requireRouteParam(c, 'id') }
  );
  if (!watch) throw errors.notFound('Standing watch');
  return c.json({ watch });
});
projectStandingWatchRoutes.post('/', async (c) =>
  c.json(
    await projectData.createProjectStandingWatch(c.env, requireRouteParam(c, 'projectId'), {
      userId: getUserId(c),
      request: await scheduleRequestBody(c.req.raw, c.env),
    }),
    201
  )
);
for (const operation of ['update', 'pause', 'revoke'] as const) {
  projectStandingWatchRoutes.post(`/:id/${operation}`, async (c) =>
    c.json(
      await projectData.mutateProjectStandingWatch(c.env, requireRouteParam(c, 'projectId'), {
        userId: getUserId(c),
        id: requireRouteParam(c, 'id'),
        operation,
        request: await scheduleRequestBody(c.req.raw, c.env),
      })
    )
  );
}
