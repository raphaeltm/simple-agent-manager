import { Hono } from 'hono';

import type { Env } from '../env';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { listUserCredentialLimits } from '../services/credential-limit-events/read';

/**
 * GET /api/credentials/limits — the signed-in user's personal credentials and
 * the latest provider usage windows SAM observed for them, across projects.
 *
 * Used by Settings → Credentials to show "5h 72%, resets 16:40" per credential.
 * Mounted before `credentialsRoutes` like `resolutionStatusRoute`.
 */
const credentialLimitsRoute = new Hono<{ Bindings: Env }>();

credentialLimitsRoute.get('/limits', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  return c.json(await listUserCredentialLimits(c.env, { userId }));
});

export { credentialLimitsRoute };
