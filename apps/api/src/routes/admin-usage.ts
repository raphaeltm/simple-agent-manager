import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../index';
import { requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  getAllUsersUsageSummary,
  getUserDetailedUsage,
} from '../services/compute-usage';

const adminUsageRoutes = new Hono<{ Bindings: Env }>();

adminUsageRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

/** GET /api/admin/usage/compute — all users' usage summary for current period. */
adminUsageRoutes.get('/compute', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const result = await getAllUsersUsageSummary(db);
  return c.json(result);
});

/** GET /api/admin/usage/compute/:userId — specific user's detailed usage. */
adminUsageRoutes.get('/compute/:userId', async (c) => {
  const userId = c.req.param('userId');
  const db = drizzle(c.env.DATABASE, { schema });

  // Verify user exists
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!user) {
    throw errors.notFound('User');
  }

  const recentLimit = parseInt(c.env.COMPUTE_USAGE_RECENT_RECORDS_LIMIT ?? '50', 10);
  const result = await getUserDetailedUsage(db, userId, recentLimit);
  return c.json(result);
});

export { adminUsageRoutes };
