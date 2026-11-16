/**
 * Admin "Health & cost" (Insights slices H and CF), superadmin only:
 * - GET /api/admin/health-cost?range=7d|30d|month: a thin adapter over the shared
 *   `installationHealth` operation, which owns the superadmin check, the queries and their limits
 *   (policy 5cb362e8).
 * - POST /api/admin/health-cost/cloudflare/refresh: runs the daily Cloudflare cost snapshot now,
 *   the "Refresh now" button on the Cloudflare card (policy 2b97aefc: admin actions are buttons).
 * Per-route middleware so nothing leaks to other routers mounted under /api/admin
 * (`.claude/rules/06-api-patterns.md`).
 */
import { installationHealth, toOperationHttpError } from '@simple-agent-manager/operations';
import { Hono } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { getUserId, requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { webOperationContext } from '../operation-ports';
import { runCloudflareCostSnapshot } from '../services/cloudflare-cost-snapshot';

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

adminHealthCostRoutes.post(
  '/cloudflare/refresh',
  requireAuth(),
  requireApproved(),
  requireSuperadmin(),
  async (c) => {
    const userId = getUserId(c);
    log.info('admin.cloudflare_cost_refresh_requested', { userId });
    // Cloudflare failures come back as a recorded status; the card shows them. Only a settings or
    // D1 failure underneath throws, and the app error handler answers that as a 500.
    return c.json(await runCloudflareCostSnapshot(c.env));
  }
);
