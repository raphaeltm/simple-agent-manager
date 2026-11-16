/**
 * GET /api/projects/:projectId/insights/flow?range=7d|30d|90d — Insights · Flow (slice F). A thin
 * adapter over the shared `projectFlow` operation, which owns the membership check, the queries
 * and their limits (policy 5cb362e8). The Insights page and the Project Overview's "This week"
 * pane both read it.
 */
import { projectFlow, toOperationHttpError } from '@simple-agent-manager/operations';
import { Hono } from 'hono';

import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { webOperationContext } from '../operation-ports';

export const projectInsightsRoutes = new Hono<{ Bindings: Env }>();

projectInsightsRoutes.get('/flow', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  try {
    const result = await projectFlow(webOperationContext(c, userId), {
      projectId,
      range: c.req.query('range'),
    });
    return c.json(result);
  } catch (error) {
    throw toOperationHttpError(error);
  }
});
