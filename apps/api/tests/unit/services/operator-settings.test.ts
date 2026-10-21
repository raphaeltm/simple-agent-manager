import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { invalidateAdminSettings, readAdminSettings } from '../../../src/services/admin-settings';
import { findAdminSetting } from '../../../src/services/admin-settings-registry';
import { getOperatorSettings } from '../../../src/services/operator-settings';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

let sqlite: Database.Database;
let env: Env;
beforeEach(() => {
  ({ sqlite, env } = createAdminSettingsEnv());
});
afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
});

function set(key: string, value: unknown) {
  sqlite
    .prepare(
      'INSERT OR REPLACE INTO platform_settings(key,value,updated_at,updated_by) VALUES(?,?,?,NULL)'
    )
    .run(key, JSON.stringify(value), '2026-10-20T00:00:00.000Z');
}

describe('typed SAM operator runtime settings', () => {
  it('resolves safe typed defaults without creating user opt-in', async () => {
    expect(await getOperatorSettings(env)).toEqual({
      disabled: false,
      watchLifetimeMs: 86_400_000,
      eventPageSize: 25,
      workRefreshMs: 30_000,
      watchRetryLimit: 3,
    });
    expect(sqlite.prepare('SELECT * FROM platform_settings').all()).toEqual([]);
  });

  it('resolves validated stored controls and exposes the same effective admin values', async () => {
    set('operations.samOperatorDisabled', true);
    set('operations.samOperatorWatchLifetimeMs', 120_000);
    set('operations.samOperatorEventPageSize', 10);
    set('operations.samOperatorWorkRefreshMs', 5_000);
    set('operations.samOperatorWatchRetryLimit', 4);
    expect(await getOperatorSettings(env)).toEqual({
      disabled: true,
      watchLifetimeMs: 120_000,
      eventPageSize: 10,
      workRefreshMs: 5_000,
      watchRetryLimit: 4,
    });
    const view = await readAdminSettings(env);
    expect(
      view.settings.find((setting) => setting.name === 'operations.samOperatorDisabled')
    ).toMatchObject({ value: true, source: 'database' });
  });

  it('keeps the new operator controls exclusively in the typed registry', () => {
    for (const name of [
      'operations.samOperatorDisabled',
      'operations.samOperatorWatchLifetimeMs',
      'operations.samOperatorEventPageSize',
      'operations.samOperatorWorkRefreshMs',
      'operations.samOperatorWatchRetryLimit',
    ]) {
      expect(findAdminSetting(name)?.legacyEnvironment).toBeUndefined();
    }
  });

  it('observes kill-switch edits immediately on a long-lived binding without cache invalidation', async () => {
    expect((await getOperatorSettings(env)).disabled).toBe(false);
    set('operations.samOperatorDisabled', true);
    expect((await getOperatorSettings(env)).disabled).toBe(true);
    set('operations.samOperatorDisabled', false);
    expect((await getOperatorSettings(env)).disabled).toBe(false);
  });

  it('refreshes tuning values through the existing admin settings invalidation boundary', async () => {
    await getOperatorSettings(env);
    set('operations.samOperatorWorkRefreshMs', 12_000);
    invalidateAdminSettings(env);
    expect((await getOperatorSettings(env)).workRefreshMs).toBe(12_000);
  });

  it('fails disabled when the settings store is unavailable, even after a stored false was read', async () => {
    set('operations.samOperatorDisabled', false);
    await getOperatorSettings(env);
    vi.spyOn(env.DATABASE, 'prepare').mockImplementation(() => {
      throw new Error('D1 outage');
    });
    expect((await getOperatorSettings(env)).disabled).toBe(true);
  });

  it('keeps every operator setting nonsecret and rejects malformed or unsafe values', async () => {
    const disabled = findAdminSetting('operations.samOperatorDisabled')!;
    expect(disabled.secret).toBe(false);
    expect(disabled.validate('true')).toBe(false);
    for (const name of [
      'operations.samOperatorWatchLifetimeMs',
      'operations.samOperatorEventPageSize',
      'operations.samOperatorWorkRefreshMs',
      'operations.samOperatorWatchRetryLimit',
    ]) {
      const definition = findAdminSetting(name)!;
      expect(definition.secret).toBe(false);
      expect(definition.validate(definition.defaultValue)).toBe(true);
      for (const value of [0, -1, 1.5, Infinity, '50', Number.MAX_SAFE_INTEGER]) {
        expect(definition.validate(value)).toBe(false);
      }
    }
    expect(findAdminSetting('operations.samOperatorEventPageSize')!.validate(26)).toBe(false);
    expect(findAdminSetting('operations.samOperatorWatchRetryLimit')!.validate(26)).toBe(false);
    set('operations.samOperatorEventPageSize', 'not-a-number');
    set('operations.samOperatorWorkRefreshMs', -1);
    expect(await getOperatorSettings(env)).toMatchObject({
      eventPageSize: 25,
      workRefreshMs: 30_000,
      watchRetryLimit: 3,
    });
  });
});
