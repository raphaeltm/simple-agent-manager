/**
 * Activity event routes — scoped under /api/projects/:projectId/activity
 *
 * Provides a reverse-chronological feed of workspace lifecycle events,
 * session events, and task status changes for a given project.
 *
 * See: specs/018-project-first-architecture/tasks.md (T034)
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../index';
import { getUserId, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import * as schema from '../db/schema';
import { requireOwnedProject } from '../middleware/project-auth';
import * as projectDataService from '../services/project-data';

const activityRoutes = new Hono<{ Bindings: Env }>();

activityRoutes.use('/*', requireAuth());

function requireRouteParam(
  c: { req: { param: (name: string) => string | undefined } },
  name: string
): string {
  const value = c.req.param(name);
  if (!value) {
    throw errors.badRequest(`${name} is required`);
  }
  return value;
}

/**
 * GET / — List activity events for a project
 *
 * Query params:
 *   - eventType: filter by event type (e.g. 'workspace.created', 'session.started', 'task.completed')
 *   - before: cursor for pagination (timestamp in ms)
 *   - limit: max events to return (default 50, max 100)
 */
activityRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  const eventType = c.req.query('eventType')?.trim() || null;
  const beforeParam = c.req.query('before')?.trim();
  const limitParam = c.req.query('limit')?.trim();

  const before = beforeParam ? Number.parseInt(beforeParam, 10) : null;
  if (beforeParam && (!Number.isFinite(before) || before === null)) {
    throw errors.badRequest('before must be a valid timestamp (ms)');
  }

  const requestedLimit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  const limit = Math.min(Math.max(requestedLimit, 1), 100);

  const result = await projectDataService.listActivityEvents(
    c.env,
    projectId,
    eventType,
    limit,
    before
  );

  return c.json(result);
});

export { activityRoutes };
