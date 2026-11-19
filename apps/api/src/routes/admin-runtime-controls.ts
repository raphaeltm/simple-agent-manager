import { Hono } from 'hono';
import * as v from 'valibot';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireActiveSettingsSuperadmin } from '../middleware/settings-admin';
import { jsonValidator } from '../schemas';
import { readAdminSettings, updateAdminSettings } from '../services/admin-settings';
import {
  resolveDisabledAlarmRetryMs,
  resolveOperationalKillSwitchCacheMs,
  resolveOperationalLoopKvKey,
} from '../services/operational-kill-switch';

// Both fields are validated loosely (v.unknown()) — the handler below
// performs its own boolean-type checks with specific error messages.
const UpdateRuntimeControlsSchema = v.object({
  cronSweepsEnabled: v.optional(v.unknown()),
  doAlarmsEnabled: v.optional(v.unknown()),
});

const adminRuntimeControlRoutes = new Hono<{ Bindings: Env }>();

adminRuntimeControlRoutes.use(
  '/*',
  requireAuth(),
  requireApproved(),
  requireSuperadmin(),
  requireActiveSettingsSuperadmin()
);

async function readRuntimeControls(env: Env) {
  const view = await readAdminSettings(env, { fresh: true });
  const cronSweepsEnabled = view.settings.find(
    (setting) => setting.name === 'operations.cronSweepsEnabled'
  )?.value;
  const doAlarmsEnabled = view.settings.find(
    (setting) => setting.name === 'operations.doAlarmsEnabled'
  )?.value;
  return {
    cronSweepsEnabled,
    doAlarmsEnabled,
    cronSweepsKvKey: resolveOperationalLoopKvKey(env, 'cron'),
    doAlarmsKvKey: resolveOperationalLoopKvKey(env, 'alarms'),
    cacheTtlMs: resolveOperationalKillSwitchCacheMs(env),
    disabledAlarmRetryMs: resolveDisabledAlarmRetryMs(env),
    semantics: 'fail-open' as const,
  };
}

adminRuntimeControlRoutes.get('/', async (c) => c.json(await readRuntimeControls(c.env)));

adminRuntimeControlRoutes.patch('/', jsonValidator(UpdateRuntimeControlsSchema), async (c) => {
  const body = c.req.valid('json');
  const cronPresent = body.cronSweepsEnabled !== undefined;
  const alarmsPresent = body.doAlarmsEnabled !== undefined;
  if (!cronPresent && !alarmsPresent) {
    throw errors.badRequest('Provide cronSweepsEnabled and/or doAlarmsEnabled');
  }
  if (cronPresent && typeof body.cronSweepsEnabled !== 'boolean') {
    throw errors.badRequest('cronSweepsEnabled must be a boolean');
  }
  if (alarmsPresent && typeof body.doAlarmsEnabled !== 'boolean') {
    throw errors.badRequest('doAlarmsEnabled must be a boolean');
  }

  await updateAdminSettings(c.env, {
    changes: [
      ...(typeof body.cronSweepsEnabled === 'boolean'
        ? [{ name: 'operations.cronSweepsEnabled' as const, value: body.cronSweepsEnabled }]
        : []),
      ...(typeof body.doAlarmsEnabled === 'boolean'
        ? [{ name: 'operations.doAlarmsEnabled' as const, value: body.doAlarmsEnabled }]
        : []),
    ],
    actorUserId: c.get('auth').user.id,
  });

  log.info('admin.runtime_controls.updated', {
    actorUserId: c.get('auth')?.user.id,
    cronSweepsEnabled: body.cronSweepsEnabled,
    doAlarmsEnabled: body.doAlarmsEnabled,
  });
  return c.json(await readRuntimeControls(c.env));
});

export { adminRuntimeControlRoutes };
