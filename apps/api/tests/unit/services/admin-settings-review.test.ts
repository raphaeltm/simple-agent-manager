import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { withRequestScopedD1Bindings } from '../../../src/lib/d1-session';
import {
  invalidateAdminSettings,
  readAdminSettings,
  resolveAdminSetting,
  updateAdminSettings,
} from '../../../src/services/admin-settings';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';
import { createSchemaTables } from '../../helpers/sqlite-d1';

let sqlite: Database.Database;
let env: Env;
beforeEach(() => {
  ({ sqlite, env } = createAdminSettingsEnv({ CONTROL_LOOP_KILL_SWITCH_CACHE_MS: '0' }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sqlite.close();
});

describe('independent admin settings review regressions', () => {
  it('fresh admin reads use primary revisions/history along with primary values despite an old request facade', async () => {
    const stale = createAdminSettingsEnv();
    try {
      const raw = env.DATABASE;
      raw.withSession = () => ({
        prepare: stale.env.DATABASE.prepare.bind(stale.env.DATABASE),
        batch: stale.env.DATABASE.batch.bind(stale.env.DATABASE),
        getBookmark: () => null,
      });
      const requestEnv = withRequestScopedD1Bindings(env);
      await requestEnv.DATABASE.prepare('SELECT revision FROM admin_settings_revision').first();
      await updateAdminSettings(env, {
        actorUserId: 'admin',
        expectedRevision: 0,
        changes: [{ name: 'trials.enabled', value: true }],
      });
      const view = await readAdminSettings(requestEnv, { fresh: true });
      expect(view.revision).toBe(1);
      expect(view.history).toEqual([
        expect.objectContaining({ revision: 1, name: 'trials.enabled' }),
      ]);
      expect(view.settings.find((x) => x.name === 'trials.enabled')?.value).toBe(true);
    } finally {
      stale.sqlite.close();
    }
  });
  it.each(['operations.cronSweepsEnabled', 'operations.doAlarmsEnabled'] as const)(
    'preserves emergency KV disable over D1 enable and supports explicit re-enable: %s',
    async (name) => {
      const key =
        name === 'operations.cronSweepsEnabled'
          ? 'control-loops:cron-enabled'
          : 'control-loops:alarms-enabled';
      await updateAdminSettings(env, { actorUserId: 'admin', changes: [{ name, value: true }] });
      await env.KV.put(key, 'false');
      invalidateAdminSettings(env);
      expect(await resolveAdminSetting(env, name)).toBe(false);
      expect(
        (await readAdminSettings(env, { fresh: true })).settings.find((x) => x.name === name)
      ).toMatchObject({ value: false, source: 'kv' });
      await updateAdminSettings(env, { actorUserId: 'admin', changes: [{ name, value: true }] });
      expect(await resolveAdminSetting(env, name)).toBe(true);
    }
  );
  it('a delayed older enable cannot defeat a newer authoritative disable', async () => {
    const key = 'control-loops:cron-enabled';
    await env.KV.put(key, 'false');
    const original = env.KV.put.bind(env.KV);
    let started!: () => void, release!: () => void;
    const atBridge = new Promise<void>((r) => {
      started = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.spyOn(env.KV, 'put').mockImplementation(async (k, v, opts) => {
      if (k === key && v === 'true') {
        started();
        await gate;
      }
      return original(k, v, opts);
    });
    const enable = updateAdminSettings(env, {
      actorUserId: 'old',
      changes: [{ name: 'operations.cronSweepsEnabled', value: true }],
    });
    await atBridge;
    await updateAdminSettings(env, {
      actorUserId: 'new',
      changes: [{ name: 'operations.cronSweepsEnabled', value: false }],
    });
    release();
    await enable;
    expect(await resolveAdminSetting(env, 'operations.cronSweepsEnabled')).toBe(false);
  });
  it('reports uncertain re-enable when a KV write applies then fails without leaking diagnostics', async () => {
    const original = env.KV.put.bind(env.KV);
    vi.spyOn(env.KV, 'put').mockImplementation(async (k, v, o) => {
      await original(k, v, o);
      throw new Error('private-diagnostic');
    });
    await expect(
      updateAdminSettings(env, {
        actorUserId: 'admin',
        changes: [{ name: 'operations.cronSweepsEnabled', value: true }],
      })
    ).rejects.toMatchObject({ statusCode: 503, error: 'SETTINGS_PROPAGATION_UNCERTAIN' });
    expect((await readAdminSettings(env, { fresh: true })).revision).toBe(1);
    expect(await resolveAdminSetting(env, 'operations.cronSweepsEnabled')).toBe(true);
  });
  it('keeps an observed emergency disable through KV outage after cache expiry', async () => {
    vi.useFakeTimers();
    env.CONTROL_LOOP_KILL_SWITCH_CACHE_MS = '10';
    await updateAdminSettings(env, {
      actorUserId: 'admin',
      changes: [{ name: 'operations.cronSweepsEnabled', value: true }],
    });
    await env.KV.put('control-loops:cron-enabled', 'false');
    invalidateAdminSettings(env);
    expect(await resolveAdminSetting(env, 'operations.cronSweepsEnabled')).toBe(false);
    vi.advanceTimersByTime(11);
    vi.spyOn(env.KV, 'get').mockRejectedValue(new Error('unavailable'));
    expect(await resolveAdminSetting(env, 'operations.cronSweepsEnabled')).toBe(false);
    vi.useRealTimers();
  });
  it('does not require KV availability to preserve an authoritative D1 disable', async () => {
    await updateAdminSettings(env, {
      actorUserId: 'admin',
      changes: [{ name: 'operations.doAlarmsEnabled', value: false }],
    });
    const get = vi.spyOn(env.KV, 'get').mockRejectedValue(new Error('unavailable'));
    expect(await resolveAdminSetting(env, 'operations.doAlarmsEnabled')).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it('additive migration preserves existing overrides and encrypted credential bytes on upgrade', () => {
    const old = new Database(':memory:');
    try {
      createSchemaTables(old, [schema.platformSettings, schema.platformCredentials]);
      old
        .prepare(
          "INSERT INTO platform_settings(key,value,updated_by) VALUES ('integration.github.clientId','existing-client','old-admin')"
        )
        .run();
      old
        .prepare(
          "INSERT INTO platform_credentials(id,credential_type,provider,credential_kind,label,encrypted_token,iv,is_enabled,created_by) VALUES ('old','platform-integration','github','github.clientSecret','Existing','existing-ciphertext','existing-iv',1,'old-admin')"
        )
        .run();
      const before = {
        settings: old.prepare('SELECT * FROM platform_settings').all(),
        credentials: old.prepare('SELECT * FROM platform_credentials').all(),
      };
      old.exec(
        readFileSync(
          new URL('../../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
          'utf8'
        )
      );
      expect(old.prepare('SELECT * FROM platform_settings').all()).toEqual(before.settings);
      expect(old.prepare('SELECT * FROM platform_credentials').all()).toEqual(before.credentials);
      expect(old.prepare('SELECT revision FROM admin_settings_revision').get()).toEqual({
        revision: 0,
      });
      expect(old.prepare('SELECT * FROM admin_settings_audit').all()).toEqual([]);
    } finally {
      old.close();
    }
  });
  it('returns an atomic view when a writer commits immediately after the read batch', async () => {
    sqlite.exec(
      "INSERT INTO platform_settings(key,value,updated_at,updated_by) VALUES ('connector.enabled','false','2026-10-29','writer')"
    );
    const batch = env.DATABASE.batch.bind(env.DATABASE);
    vi.spyOn(env.DATABASE, 'batch').mockImplementation(async (statements) => {
      const snapshot = await batch(statements);
      sqlite.exec(`
        UPDATE platform_settings SET value='true' WHERE key='connector.enabled';
        UPDATE admin_settings_revision SET revision=revision+1;
        INSERT INTO admin_settings_audit(id,name,action,actor_user_id,created_at,revision) VALUES ('concurrent','connector.enabled','set','writer','2026-10-30',1);
      `);
      return snapshot;
    });
    const view = await readAdminSettings(env, { fresh: true });
    expect(view.revision).toBe(0);
    expect(view.history).toEqual([]);
    expect(view.settings.find((setting) => setting.name === 'connector.enabled')?.value).toBe(
      false
    );
    expect(sqlite.prepare('SELECT revision FROM admin_settings_revision').get()).toEqual({
      revision: 1,
    });
  });
  it('a stale enable never clears an emergency brake', async () => {
    await updateAdminSettings(env, {
      actorUserId: 'admin',
      changes: [{ name: 'trials.enabled', value: false }],
    });
    await env.KV.put('control-loops:cron-enabled', 'false');
    const put = vi.spyOn(env.KV, 'put');
    await expect(
      updateAdminSettings(env, {
        actorUserId: 'stale',
        expectedRevision: 0,
        changes: [{ name: 'operations.cronSweepsEnabled', value: true }],
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(put).not.toHaveBeenCalled();
    expect(await env.KV.get('control-loops:cron-enabled')).toBe('false');
  });
});
