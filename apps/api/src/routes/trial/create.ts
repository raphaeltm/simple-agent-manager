import { Hono } from 'hono';

import type { Env } from '../../env';

const createRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/trial/create — create a new anonymous trial.
 *
 * Wave-0 stub. Wave-1 will: validate the repoUrl via Valibot, check the kill
 * switch + monthly cap, allocate a TrialCounter slot, issue fingerprint +
 * claim cookies, and stream SSE progress on the companion endpoint.
 */
createRoutes.post('/create', (c) =>
  c.json({ error: 'not_implemented', wave: 'wave-1' }, 501)
);

export { createRoutes };
