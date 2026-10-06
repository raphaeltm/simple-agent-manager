/**
 * Activity event routes — scoped under /api/projects/:projectId/activity
 *
 * Provides a reverse-chronological feed of workspace lifecycle events,
 * session events, and task status changes for a given project.
 *
 * See: specs/018-project-first-architecture/tasks.md (T034)
 */
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId, requireApproved,requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectAccess } from '../middleware/project-auth';
import * as projectDataService from '../services/project-data';

const activityRoutes = new Hono<{ Bindings: Env }>();

activityRoutes.use('/*', requireAuth(), requireApproved());

/**
 * GET / — List activity events for a project
 *
 * Query params:
 *   - eventType: filter by event type (e.g. 'workspace.created', 'session.started', 'task.completed')
 *   - sessionId: filter by chat session ID
 *   - before: cursor for pagination (timestamp in ms)
 *   - limit: max events to return (default 50, max 100)
 */
activityRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectAccess(db, projectId, userId);

  const eventType = c.req.query('eventType')?.trim() || null;
  const rawSessionId = c.req.query('sessionId')?.trim() || null;
  const SESSION_ID_RE = /^[\w-]{1,64}$/;
  if (rawSessionId !== null && !SESSION_ID_RE.test(rawSessionId)) {
    throw errors.badRequest('sessionId must be a valid identifier');
  }
  const sessionId = rawSessionId;
  const beforeParam = c.req.query('before')?.trim();
  const limitParam = c.req.query('limit')?.trim();

  const before = beforeParam ? Number.parseInt(beforeParam, 10) : null;
  if (beforeParam && (!Number.isFinite(before) || before === null)) {
    throw errors.badRequest('before must be a valid timestamp (ms)');
  }

  const requestedLimit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (limitParam && !Number.isFinite(requestedLimit)) {
    throw errors.badRequest('limit must be a valid integer');
  }
  const limit = Math.min(Math.max(requestedLimit, 1), 100);

  const result = await projectDataService.listActivityEvents(
    c.env,
    projectId,
    eventType,
    limit,
    before,
    sessionId
  );

  return c.json(result);
});

export { activityRoutes };
