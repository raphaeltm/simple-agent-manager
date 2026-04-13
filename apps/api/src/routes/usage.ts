import type { UserQuotaStatusResponse } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { checkQuotaForUser, userHasOwnCloudCredentials } from '../services/compute-quotas';
import { getCurrentPeriodBounds, getUserUsageSummary } from '../services/compute-usage';

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

/** GET /api/usage/quota — current user's quota status. */
usageRoutes.get('/quota', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  const [quotaCheck, byocExempt] = await Promise.all([
    checkQuotaForUser(db, userId),
    userHasOwnCloudCredentials(db, userId),
  ]);

  const { start, end } = getCurrentPeriodBounds();

  const response: UserQuotaStatusResponse = {
    monthlyVcpuHoursLimit: quotaCheck.limit,
    source: quotaCheck.source,
    currentUsage: quotaCheck.used,
    remaining: quotaCheck.remaining,
    periodStart: start,
    periodEnd: end,
    byocExempt,
  };

  return c.json(response);
});

export { usageRoutes };
