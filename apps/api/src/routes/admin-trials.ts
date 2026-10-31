/**
 * Admin trial configuration routes.
 *
 * GET   /api/admin/trials/config — read the current trial kill-switch state
 * PATCH /api/admin/trials/config — enable or disable new trial creation
 */
import { Hono } from 'hono';
import * as v from 'valibot';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireActiveSettingsSuperadmin } from '../middleware/settings-admin';
import { jsonValidator } from '../schemas';
import { resolveAdminSettingDetailsMany } from '../services/admin-settings';
import {
  resolveTrialKillSwitchCacheMs,
  resolveTrialsEnabledKvKey,
  setTrialsEnabled,
} from '../services/trial/kill-switch';

// Validated loosely (v.unknown()) — the handler below performs its own
// boolean-type check with a specific error message.
const UpdateTrialsConfigSchema = v.object({
  enabled: v.optional(v.unknown()),
});

const adminTrialsRoutes = new Hono<{ Bindings: Env }>();

adminTrialsRoutes.use(
  '/*',
  requireAuth(),
  requireApproved(),
  requireSuperadmin(),
  requireActiveSettingsSuperadmin()
);

adminTrialsRoutes.get('/config', async (c) => {
  const [enabled] = await resolveAdminSettingDetailsMany(c.env, ['trials.enabled'], {
    fresh: true,
  });
  return c.json({
    enabled: enabled?.value,
    kvKey: resolveTrialsEnabledKvKey(c.env),
    cacheTtlMs: resolveTrialKillSwitchCacheMs(c.env),
  });
});

adminTrialsRoutes.patch('/config', jsonValidator(UpdateTrialsConfigSchema), async (c) => {
  const body = c.req.valid('json');

  if (typeof body.enabled !== 'boolean') {
    throw errors.badRequest('enabled must be a boolean');
  }

  const config = await setTrialsEnabled(c.env, body.enabled, Date.now(), c.get('auth').user.id);

  log.info('admin.trials.config_updated', {
    enabled: config.enabled,
    kvKey: config.kvKey,
  });

  return c.json(config);
});

export { adminTrialsRoutes };
