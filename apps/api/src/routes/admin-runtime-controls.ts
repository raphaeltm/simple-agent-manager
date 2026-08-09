import { Hono } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  isOperationalLoopEnabled,
  resolveDisabledAlarmRetryMs,
  resolveOperationalKillSwitchCacheMs,
  resolveOperationalLoopKvKey,
  setOperationalLoopEnabled,
} from '../services/operational-kill-switch';

const adminRuntimeControlRoutes = new Hono<{ Bindings: Env }>();

adminRuntimeControlRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

async function readRuntimeControls(env: Env) {
  const [cronSweepsEnabled, doAlarmsEnabled] = await Promise.all([
    isOperationalLoopEnabled(env, 'cron'),
    isOperationalLoopEnabled(env, 'alarms'),
  ]);
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

adminRuntimeControlRoutes.patch('/', async (c) => {
  const body = await c.req.json<{
    cronSweepsEnabled?: unknown;
    doAlarmsEnabled?: unknown;
  }>();
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

  if (typeof body.cronSweepsEnabled === 'boolean') {
    await setOperationalLoopEnabled(c.env, 'cron', body.cronSweepsEnabled);
  }
  if (typeof body.doAlarmsEnabled === 'boolean') {
    await setOperationalLoopEnabled(c.env, 'alarms', body.doAlarmsEnabled);
  }

  log.info('admin.runtime_controls.updated', {
    actorUserId: c.get('auth')?.user.id,
    cronSweepsEnabled: body.cronSweepsEnabled,
    doAlarmsEnabled: body.doAlarmsEnabled,
  });
  return c.json(await readRuntimeControls(c.env));
});

export { adminRuntimeControlRoutes };
