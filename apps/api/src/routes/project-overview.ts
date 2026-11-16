/**
 * GET /api/projects/:projectId/overview — the Project Overview page's one aggregated read
 * (Inbox slice F1). A thin adapter over the shared `projectOverviewGet` operation, which owns
 * the membership check, the queries and their limits (policy 5cb362e8).
 */
import { projectOverviewGet, toOperationHttpError } from '@simple-agent-manager/operations';
import { Hono } from 'hono';

import type { Env } from '../env';
import { parsePositiveInt, requireRouteParam } from '../lib/route-helpers';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { webOperationContext } from '../operation-ports';

export const projectOverviewRoutes = new Hono<{ Bindings: Env }>();

projectOverviewRoutes.get('/', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const runningLimit = parsePositiveInt(c.req.query('runningLimit'), 0) || undefined;
  const recentLimit = parsePositiveInt(c.req.query('recentLimit'), 0) || undefined;
  try {
    const result = await projectOverviewGet(webOperationContext(c, userId), {
      projectId,
      runningLimit,
      recentLimit,
    });
    return c.json(result);
  } catch (error) {
    throw toOperationHttpError(error);
  }
});
