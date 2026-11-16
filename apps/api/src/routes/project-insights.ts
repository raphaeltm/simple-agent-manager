/**
 * The project Insights page's reads, each a thin adapter over its shared operation, which owns the
 * membership check, the queries and their limits (policy 5cb362e8):
 * - GET /api/projects/:projectId/insights/flow?range=7d|30d|90d — Flow (slice F, `projectFlow`),
 *   read by the Insights page and the Project Overview's "This week" pane;
 * - GET /api/projects/:projectId/insights/accounts?range=7d|30d|90d — Accounts (slice A,
 *   `projectAccounts`). Private to the viewer (their own account names and limit windows), so
 *   never cached by a shared cache.
 */
import {
  projectAccounts,
  projectFlow,
  toOperationHttpError,
} from '@simple-agent-manager/operations';
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

projectInsightsRoutes.get('/accounts', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  c.header('Cache-Control', 'private, no-store');
  try {
    const result = await projectAccounts(webOperationContext(c, userId), {
      projectId,
      range: c.req.query('range'),
    });
    return c.json(result);
  } catch (error) {
    throw toOperationHttpError(error);
  }
});
