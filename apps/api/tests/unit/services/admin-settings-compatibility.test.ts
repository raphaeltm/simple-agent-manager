import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  invalidateAdminSettings,
  resolveAdminSetting,
  resolveAdminSettingDetails,
} from '../../../src/services/admin-settings';
import { encrypt } from '../../../src/services/encryption';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

let sqlite: Database.Database;
let env: Env;
beforeEach(() => {
  ({ sqlite, env } = createAdminSettingsEnv());
});
afterEach(() => {
  vi.useRealTimers();
  sqlite.close();
});

describe('legacy configuration compatibility', () => {
  it('keeps formerly accepted nonempty OAuth values readable without weakening new-write validation', async () => {
    env.GITHUB_CLIENT_ID = 'abc';
    env.GITHUB_CLIENT_SECRET = 'short';
    expect((await resolveAdminSettingDetails(env, 'integration.github.clientId')).value).toBe(
      'abc'
    );
    expect((await resolveAdminSettingDetails(env, 'integration.github.clientSecret')).value).toBe(
      'short'
    );
    sqlite
      .prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES (?,?,?)')
      .run('integration.google.clientId', 'old', 'now');
    invalidateAdminSettings(env);
    // The previous resolver accepted trimmed nonempty values; read compatibility is independent of write validation.
    expect((await resolveAdminSettingDetails(env, 'integration.google.clientId')).value).toBe(
      'old'
    );
  });

  it('honors zero and shorter configured KV convergence windows', async () => {
    vi.useFakeTimers();
    env.CONTROL_LOOP_KILL_SWITCH_CACHE_MS = '0';
    await env.KV.put('control-loops:alarms-enabled', 'true');
    expect(await resolveAdminSetting(env, 'operations.doAlarmsEnabled')).toBe(true);
    await env.KV.put('control-loops:alarms-enabled', 'false');
    expect(await resolveAdminSetting(env, 'operations.doAlarmsEnabled')).toBe(false);
    env.CONTROL_LOOP_KILL_SWITCH_CACHE_MS = '10';
    await env.KV.put('control-loops:cron-enabled', 'true');
    expect(await resolveAdminSetting(env, 'operations.cronSweepsEnabled')).toBe(true);
    await env.KV.put('control-loops:cron-enabled', 'false');
    vi.advanceTimersByTime(11);
    expect(await resolveAdminSetting(env, 'operations.cronSweepsEnabled')).toBe(false);
  });

  it('honors shorter D1 and encrypted credential TTLs including zero after a longer cached read', async () => {
    vi.useFakeTimers();
    const first = await encrypt('first-secret', env.ENCRYPTION_KEY);
    sqlite
      .prepare(
        `INSERT INTO platform_credentials(id,credential_type,provider,credential_kind,label,encrypted_token,iv,is_enabled,created_by,created_at,updated_at)
      VALUES ('legacy','platform-integration','github','github.clientSecret','OAuth',?,?,1,'legacy-admin','now','now')`
      )
      .run(first.ciphertext, first.iv);
    sqlite
      .prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES (?,?,?)')
      .run('integration.github.clientId', 'client-one', 'now');
    expect((await resolveAdminSettingDetails(env, 'integration.github.clientSecret')).value).toBe(
      'first-secret'
    );
    expect((await resolveAdminSettingDetails(env, 'integration.github.clientId')).value).toBe(
      'client-one'
    );
    const second = await encrypt('second-secret', env.ENCRYPTION_KEY);
    sqlite
      .prepare("UPDATE platform_credentials SET encrypted_token=?,iv=? WHERE id='legacy'")
      .run(second.ciphertext, second.iv);
    sqlite
      .prepare(
        "UPDATE platform_settings SET value='client-two' WHERE key='integration.github.clientId'"
      )
      .run();
    env.PLATFORM_CONFIG_CACHE_MS = '10';
    vi.advanceTimersByTime(11);
    expect((await resolveAdminSettingDetails(env, 'integration.github.clientSecret')).value).toBe(
      'second-secret'
    );
    expect((await resolveAdminSettingDetails(env, 'integration.github.clientId')).value).toBe(
      'client-two'
    );
    env.PLATFORM_CONFIG_CACHE_MS = '0';
    sqlite
      .prepare(
        "UPDATE platform_settings SET value='client-three' WHERE key='integration.github.clientId'"
      )
      .run();
    expect((await resolveAdminSettingDetails(env, 'integration.github.clientId')).value).toBe(
      'client-three'
    );
  });
});
