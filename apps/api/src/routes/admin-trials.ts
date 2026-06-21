/**
 * Admin trial configuration routes.
 *
 * GET   /api/admin/trials/config — read the current trial kill-switch state
 * PATCH /api/admin/trials/config — enable or disable new trial creation
 */
import { Hono } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  isTrialsEnabled,
  resolveTrialKillSwitchCacheMs,
  resolveTrialsEnabledKvKey,
  setTrialsEnabled,
} from '../services/trial/kill-switch';

const adminTrialsRoutes = new Hono<{ Bindings: Env }>();

adminTrialsRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

adminTrialsRoutes.get('/config', async (c) => {
  return c.json({
    enabled: await isTrialsEnabled(c.env),
    kvKey: resolveTrialsEnabledKvKey(c.env),
    cacheTtlMs: resolveTrialKillSwitchCacheMs(c.env),
  });
});

adminTrialsRoutes.patch('/config', async (c) => {
  const body = await c.req.json<{ enabled?: unknown }>();

  if (typeof body.enabled !== 'boolean') {
    throw errors.badRequest('enabled must be a boolean');
  }

  const config = await setTrialsEnabled(c.env, body.enabled);

  log.info('admin.trials.config_updated', {
    enabled: config.enabled,
    kvKey: config.kvKey,
  });

  return c.json(config);
});

export { adminTrialsRoutes };
