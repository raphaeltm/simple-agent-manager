/**
 * GET /api/admin/health-cost?range=7d|30d|month — Admin "Health & cost" (Insights slice H).
 * A thin adapter over the shared `installationHealth` operation, which owns the superadmin check,
 * the queries and their limits (policy 5cb362e8). Per-route middleware so nothing leaks to other
 * routers mounted under /api/admin (`.claude/rules/06-api-patterns.md`).
 */
import { installationHealth, toOperationHttpError } from '@simple-agent-manager/operations';
import { Hono } from 'hono';

import type { Env } from '../env';
import { getUserId, requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { webOperationContext } from '../operation-ports';

export const adminHealthCostRoutes = new Hono<{ Bindings: Env }>();

adminHealthCostRoutes.get('/', requireAuth(), requireApproved(), requireSuperadmin(), async (c) => {
  const userId = getUserId(c);
  try {
    return c.json(
      await installationHealth(webOperationContext(c, userId), { range: c.req.query('range') })
    );
  } catch (error) {
    throw toOperationHttpError(error);
  }
});
