import { Hono } from 'hono';

import type { Env } from '../../env';

const claimRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/trial/claim — claim an anonymous trial after GitHub OAuth.
 *
 * Wave-0 stub. Wave-1 will verify the sam_trial_claim cookie via HMAC, look
 * up the trial's project, re-parent `projects.user_id` from
 * TRIAL_ANONYMOUS_USER_ID to the authenticated user, and clear the cookie.
 */
claimRoutes.post('/claim', (c) =>
  c.json({ error: 'not_implemented', wave: 'wave-1' }, 501)
);

export { claimRoutes };
