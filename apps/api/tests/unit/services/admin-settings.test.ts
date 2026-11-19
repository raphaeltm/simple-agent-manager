import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  commitAdminSettingsStatements,
  invalidateAdminSettings,
  readAdminSettings,
  resolveAdminSetting,
  updateAdminSettings,
  validateAdminSettingsChanges,
} from '../../../src/services/admin-settings';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';
let sqlite: Database.Database, env: Env;
beforeEach(() => {
  ({ sqlite, env } = createAdminSettingsEnv());
});
afterEach(() => {
  vi.useRealTimers();
  sqlite.close();
});
describe('admin settings mutation and outage safety', () => {
  it('validates provider reset tolerance bounds and invalidates cached values after changes', async () => {
    const name = 'operations.providerLimitResetWindowToleranceMs' as const;
    expect(await resolveAdminSetting(env, name)).toBe(60_000);
    for (const value of [0, 1000, 300_000]) {
      await updateAdminSettings(env, { actorUserId: 'admin', changes: [{ name, value }] });
      expect(await resolveAdminSetting(env, name)).toBe(value);
    }
    for (const value of [-1, 300_001, 1.5, '1000']) {
      await expect(
        updateAdminSettings(env, { actorUserId: 'admin', changes: [{ name, value }] })
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    await updateAdminSettings(env, { actorUserId: 'admin', changes: [{ name, value: null }] });
    expect(await resolveAdminSetting(env, name)).toBe(60_000);
  });

  it('legacy atomic guard rolls back arbitrary statements when prior validation is stale', async () => {
    const changes = [
      { name: 'integration.github.clientId' as const, value: 'client-one' },
      { name: 'integration.github.clientSecret' as const, value: 'secret-one' },
    ];
    const revision = await validateAdminSettingsChanges(env, changes);
    await updateAdminSettings(env, {
      changes: [{ name: 'operations.stalledTaskClassifierEnabled', value: false }],
      actorUserId: 'other',
    });
    await expect(
      commitAdminSettingsStatements(env, {
        expectedRevision: revision,
        actorUserId: 'stale',
        changes: [{ name: 'integration.github.clientId', action: 'set' }],
        statements: [
          env.DATABASE.prepare(
            "INSERT INTO platform_settings(key,value) VALUES ('integration.github.clientId','orphaned-client')"
          ),
        ],
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      sqlite
        .prepare("SELECT key FROM platform_settings WHERE key='integration.github.clientId'")
        .get()
    ).toBeUndefined();
    expect((await readAdminSettings(env, { fresh: true })).history).toHaveLength(1);
  });
  it('pair validation uses fresh data after another instance resets a cached counterpart', async () => {
    await updateAdminSettings(env, {
      actorUserId: 'admin',
      changes: [
        { name: 'integration.google.clientId', value: 'client-old' },
        { name: 'integration.google.clientSecret', value: 'secret-old' },
      ],
    });
    expect(await resolveAdminSetting(env, 'integration.google.clientSecret')).toBe('secret-old');
    // Another isolate has already atomically reset the pair; this isolate has old caches.
    sqlite.exec(
      "DELETE FROM platform_credentials; DELETE FROM platform_settings WHERE key LIKE 'integration.%'; UPDATE admin_settings_revision SET revision=revision+1;"
    );
    await expect(
      updateAdminSettings(env, {
        actorUserId: 'admin',
        expectedRevision: 2,
        changes: [{ name: 'integration.google.clientId', value: 'client-new' }],
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(
      sqlite
        .prepare("SELECT key FROM platform_settings WHERE key='integration.google.clientId'")
        .get()
    ).toBeUndefined();
  });
  it('preserves legacy environment pair on resetting DB overrides and rejects orphan reset', async () => {
    env.GITHUB_CLIENT_ID = 'env-client';
    env.GITHUB_CLIENT_SECRET = 'env-secret';
    await updateAdminSettings(env, {
      actorUserId: 'admin',
      changes: [{ name: 'integration.github.clientId', value: 'stored-client' }],
    });
    await updateAdminSettings(env, {
      actorUserId: 'admin',
      changes: [{ name: 'integration.github.clientId', value: null }],
    });
    expect(await resolveAdminSetting(env, 'integration.github.clientId')).toBe('env-client');
    delete env.GITHUB_CLIENT_SECRET;
    await expect(
      updateAdminSettings(env, {
        actorUserId: 'admin',
        changes: [{ name: 'integration.github.clientSecret', value: null }],
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
  it('never serves permissive cached security values after expiry and keeps observed disabled operations off', async () => {
    vi.useFakeTimers();
    await updateAdminSettings(env, {
      actorUserId: 'admin',
      changes: [
        { name: 'operations.cronSweepsEnabled', value: false },
        { name: 'connector.enabled', value: true },
      ],
    });
    expect(await resolveAdminSetting(env, 'operations.cronSweepsEnabled')).toBe(false);
    expect(await resolveAdminSetting(env, 'connector.enabled')).toBe(true);
    const prepare = env.DATABASE.prepare;
    env.DATABASE.prepare = () => {
      throw new Error('private-values');
    };
    vi.advanceTimersByTime(60_001);
    expect(await resolveAdminSetting(env, 'operations.cronSweepsEnabled')).toBe(false);
    expect(await resolveAdminSetting(env, 'connector.enabled')).toBe(false);
    await expect(readAdminSettings(env, { fresh: true })).rejects.toThrow(
      'Admin settings are unavailable'
    );
    env.DATABASE.prepare = prepare;
    invalidateAdminSettings(env);
  });
  it('bounds secret reads and KV read amplification while environment fallback is resolved per call', async () => {
    const prepare = vi.spyOn(env.DATABASE, 'prepare'),
      get = vi.spyOn(env.KV, 'get');
    env.GITHUB_CLIENT_SECRET = 'first-secret';
    expect(await resolveAdminSetting(env, 'integration.github.clientSecret')).toBe('first-secret');
    env.GITHUB_CLIENT_SECRET = 'changed-secret';
    expect(await resolveAdminSetting(env, 'integration.github.clientSecret')).toBe(
      'changed-secret'
    );
    await resolveAdminSetting(env, 'operations.cronSweepsEnabled');
    await resolveAdminSetting(env, 'operations.cronSweepsEnabled');
    expect(
      prepare.mock.calls.filter(([sql]) => sql.includes('FROM platform_credentials'))
    ).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
