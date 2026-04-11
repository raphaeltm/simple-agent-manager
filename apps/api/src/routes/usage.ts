import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../index';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { getUserUsageSummary } from '../services/compute-usage';

const usageRoutes = new Hono<{ Bindings: Env }>();

/** GET /api/usage/compute — current user's compute usage summary. */
usageRoutes.get('/compute', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  const { period, activeSessions } = await getUserUsageSummary(db, userId);

  return c.json({
    currentPeriod: period,
    activeSessions,
  });
});

export { usageRoutes };
