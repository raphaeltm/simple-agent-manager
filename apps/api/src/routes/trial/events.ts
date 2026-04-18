import { Hono } from 'hono';

import type { Env } from '../../env';

const eventsRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/trial/:trialId/events — Server-Sent Events stream for a trial.
 *
 * Wave-0 stub. Wave-1 will stream TrialEvent unions
 * (trial.started, trial.progress, trial.knowledge, trial.idea, trial.ready,
 * trial.error) sourced from the ProjectData DO of the trial's project.
 */
eventsRoutes.get('/:trialId/events', (c) =>
  c.json({ error: 'not_implemented', wave: 'wave-1' }, 501)
);

export { eventsRoutes };
