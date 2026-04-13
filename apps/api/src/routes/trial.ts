import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireApproved, requireAuth } from '../middleware/auth';
import { getTrialStatus } from '../services/platform-trial';

const trialRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/trial-status — Check platform trial availability for the current user.
 *
 * Returns whether the user can use platform-provided infrastructure and AI
 * without bringing their own credentials.
 */
trialRoutes.get('/trial-status', requireAuth(), requireApproved(), async (c) => {
  const user = c.get('user' as never) as { id: string };
  const db = drizzle(c.env.DATABASE, { schema });
  const status = await getTrialStatus(db, user.id, c.env);
  return c.json(status);
});

export { trialRoutes };
