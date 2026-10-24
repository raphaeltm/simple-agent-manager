import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { classifyLongRunningTaskStall, classifyReconciliationLoop } from '../../../src/scheduled/stalled-task-classifier';
import {
  invalidateAdminSettings,
  readAdminSettings,
  updateAdminSettings,
} from '../../../src/services/admin-settings';
import {
  getConnectorSettings,
  updateConnectorSettings,
} from '../../../src/services/connector-settings';
import {
  deferAlarmWhenDisabled,
  isOperationalLoopEnabled,
  setOperationalLoopEnabled,
} from '../../../src/services/operational-kill-switch';
import {
  __resetPlatformConfigCacheForTest,
  completeSetupWithConfig,
  resolvePlatformConfig,
  savePlatformIntegrationConfig,
} from '../../../src/services/platform-config-core';
import { isTrialsEnabled, setTrialsEnabled } from '../../../src/services/trial/kill-switch';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';
let sqlite: Database.Database;
let env: Env;
beforeEach(() => {
  ({ sqlite, env } = createAdminSettingsEnv());
  __resetPlatformConfigCacheForTest();
});
afterEach(() => sqlite.close());

describe('Phase 1 existing consumer integration', () => {
  it('the new classifier switch reaches both actual asynchronous entrypoints', async () => {
    await updateAdminSettings(env, {changes:[{name:'operations.stalledTaskClassifierEnabled',value:false}],actorUserId:'admin'});
    expect(await classifyReconciliationLoop(env, [])).toBeNull();
    expect(await classifyLongRunningTaskStall(env, {
      task:{id:'task',project_id:'project',workspace_id:null,chat_session_id:'chat'},
      liveness:{} as never,nowMs:Date.now(),
    })).toBeNull();
  });
  it('preserves defaults and legacy environment/KV values until a D1 override exists', async () => {
    env.CONNECTOR_ENABLED = 'false';
    await env.KV.put('trials:enabled', 'true');
    await env.KV.put('control-loops:cron-enabled', 'disabled');
    expect((await getConnectorSettings(env)).enabled).toBe(false);
    expect(await isTrialsEnabled(env)).toBe(true);
    expect(await isOperationalLoopEnabled(env, 'cron')).toBe(false);
    expect(await isOperationalLoopEnabled(env, 'alarms')).toBe(true);
    await updateAdminSettings(env, {
      changes: [
        { name: 'trials.enabled', value: false },
        { name: 'operations.cronSweepsEnabled', value: true },
      ],
      actorUserId: 'admin',
    });
    expect(await isTrialsEnabled(env)).toBe(false);
    expect(await isOperationalLoopEnabled(env, 'cron')).toBe(true);
  });
  it('legacy writers share revision/audit and reset reveals environment without modifying legacy KV', async () => {
    env.CONNECTOR_WRITE_ENABLED = 'false';
    await updateConnectorSettings(env, { writeEnabled: true }, 'alice');
    await setTrialsEnabled(env, true, Date.now(), 'bob');
    await setOperationalLoopEnabled(env, 'alarms', false, Date.now(), 'carol');
    await updateConnectorSettings(env, { writeEnabled: null }, 'alice');
    const view = await readAdminSettings(env, { fresh: true });
    expect(view.revision).toBe(4);
    expect(view.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'connector.writeEnabled',
          action: 'reset',
          actorUserId: 'alice',
        }),
        expect.objectContaining({ name: 'trials.enabled', actorUserId: 'bob' }),
        expect.objectContaining({ name: 'operations.doAlarmsEnabled', actorUserId: 'carol' }),
      ])
    );
    expect((await getConnectorSettings(env)).writeEnabled).toBe(false);
    expect(await env.KV.get('trials:enabled')).toBeNull();
    const setAlarm = vi.fn();
    expect(
      await deferAlarmWhenDisabled(
        env,
        { setAlarm } as unknown as DurableObjectStorage,
        'test',
        100
      )
    ).toBe(true);
    expect(setAlarm).toHaveBeenCalled();
  });
  it('OAuth admin writes rotate the actual auth reader despite its previous cache and expose no secret in audit', async () => {
    const input = { google: { clientId: 'first-client', clientSecret: 'first-secret' } };
    await savePlatformIntegrationConfig(env, input, 'admin');
    expect((await resolvePlatformConfig(env)).google.clientSecret.value).toBe('first-secret');
    await updateAdminSettings(env, {
      changes: [{ name: 'integration.google.clientSecret', value: 'rotated-secret' }],
      actorUserId: 'admin',
      expectedRevision: 1,
    });
    expect((await resolvePlatformConfig(env)).google.clientSecret).toMatchObject({
      value: 'rotated-secret',
      source: 'runtime',
    });
    expect(JSON.stringify(await readAdminSettings(env, { fresh: true }))).not.toContain(
      'rotated-secret'
    );
    expect(sqlite.prepare('SELECT value FROM platform_settings').all()).not.toEqual(
      expect.arrayContaining([{ value: 'rotated-secret' }])
    );
    expect(
      JSON.stringify(sqlite.prepare('SELECT * FROM admin_settings_audit').all())
    ).not.toContain('secret');
  });
  it('setup completion and OAuth updates share the same atomic audit boundary', async () => {
    await completeSetupWithConfig(
      env,
      { github: { clientId: 'github-client', clientSecret: 'github-secret' } },
      'setup-actor'
    );
    expect(
      sqlite.prepare("SELECT value FROM platform_settings WHERE key='setup.completed'").get()
    ).toEqual({ value: 'true' });
    expect((await readAdminSettings(env)).revision).toBe(1);
    sqlite.exec(
      "CREATE TRIGGER reject_audit BEFORE INSERT ON admin_settings_audit BEGIN SELECT RAISE(ABORT,'test failure'); END;"
    );
    await expect(
      savePlatformIntegrationConfig(env, { github: { clientId: 'replacement' } }, 'admin')
    ).rejects.toThrow();
    expect((await resolvePlatformConfig(env)).github.clientId.value).toBe('github-client');
  });
  it('expired reads fail closed for trial/connector and preserve an observed disabled operations brake', async () => {
    await setOperationalLoopEnabled(env, 'alarms', false);
    expect(await isOperationalLoopEnabled(env, 'alarms')).toBe(false);
    invalidateAdminSettings(env);
    sqlite.close();
    expect(await isOperationalLoopEnabled(env, 'alarms')).toBe(false);
    expect(await isTrialsEnabled(env)).toBe(false);
    expect((await getConnectorSettings(env)).enabled).toBe(false);
  });
});
