import { Hono } from 'hono';

import type { Env } from '../../env';

const statusRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/trial/status — public availability info (no auth required).
 *
 * Wave-0 stub. Wave-1 will return TrialStatusResponse: kill-switch state,
 * remaining monthly slots (read from TrialCounter DO), and next reset date.
 */
statusRoutes.get('/status', (c) =>
  c.json({ error: 'not_implemented', wave: 'wave-1' }, 501)
);

export { statusRoutes };
