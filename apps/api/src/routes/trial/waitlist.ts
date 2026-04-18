import { Hono } from 'hono';

import type { Env } from '../../env';

const waitlistRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/trial/waitlist — queue for notification when the monthly cap resets.
 *
 * Wave-0 stub. Wave-1 will validate the email via Valibot and insert into
 * `trial_waitlist` (upserting on the unique (email, reset_date) index).
 */
waitlistRoutes.post('/waitlist', (c) =>
  c.json({ error: 'not_implemented', wave: 'wave-1' }, 501)
);

export { waitlistRoutes };
