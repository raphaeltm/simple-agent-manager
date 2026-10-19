import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRequestScopedD1 } from '../../../src/lib/d1-session';
import {
  ADMIN_SETTINGS_CACHE_MAX_MS,
  type AdminSettingOverrideRow,
  AdminSettingsCache,
} from '../../../src/services/admin-settings-cache';
import {
  ADMIN_SETTINGS_REGISTRY,
  findAdminSetting,
  publicAdminSettingDefinition,
} from '../../../src/services/admin-settings-registry';
import { CONNECTOR_DEFAULTS } from '../../../src/services/connector-settings';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

function fixture() {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  sqlite.exec(`CREATE TABLE platform_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT
  )`);
  const set = (value: boolean) =>
    sqlite
      .prepare('INSERT OR REPLACE INTO platform_settings VALUES (?, ?, ?, ?)')
      .run('connector.enabled', JSON.stringify(value), '2026-10-11T11:20:00Z', 'admin');
  set(true);
  return { sqlite, database: createSqliteD1(sqlite), set };
}

function rows(enabled: boolean): AdminSettingOverrideRow[] {
  return [
    {
      key: 'connector.enabled',
      value: JSON.stringify(enabled),
      updatedAt: 'now',
      updatedBy: 'admin',
    },
  ];
}

describe('Phase 1 settings registry', () => {
  it('covers bounded Phase 1 controls and reuses Connector defaults', () => {
    expect(new Set(ADMIN_SETTINGS_REGISTRY.map((setting) => setting.name)).size).toBe(26);
    expect(ADMIN_SETTINGS_REGISTRY).toHaveLength(26);
    for (const [key, value] of Object.entries(CONNECTOR_DEFAULTS)) {
      const definition = findAdminSetting(`connector.${key}`)!;
      expect(definition.defaultValue).toEqual(value);
      expect(definition.validate(value)).toBe(true);
    }
    expect(findAdminSetting('trials.enabled')?.defaultValue).toBe(false);
    expect(findAdminSetting('operations.cronSweepsEnabled')?.defaultValue).toBe(true);
    expect(findAdminSetting('operations.doAlarmsEnabled')?.defaultValue).toBe(true);
    expect(findAdminSetting('operations.stalledTaskClassifierEnabled')?.defaultValue).toBe(true);
    expect(findAdminSetting('collaboration.sessionAccessMaxGrants')?.defaultValue).toBe(10);
    expect(findAdminSetting('collaboration.commentMentionsMax')?.defaultValue).toBe(10);
    expect(findAdminSetting('collaboration.commentNotificationWindowSeconds')?.defaultValue).toBe(
      600
    );
    expect(findAdminSetting('feedback.projectId')).toBeUndefined();
    expect(findAdminSetting('integration.github.appPrivateKey')).toBeUndefined();
    expect(findAdminSetting('__proto__')).toBeUndefined();
  });

  it('rejects malformed values without accepting boolean-like strings or unsafe numeric inputs', () => {
    for (const value of ['false', null, 0, [], {}]) {
      expect(findAdminSetting('trials.enabled')?.validate(value)).toBe(false);
    }
    const ttl = findAdminSetting('connector.accessTokenTtlSeconds')!;
    for (const value of [59, 1.5, NaN, Infinity, 2147483648, '3600'])
      expect(ttl.validate(value)).toBe(false);
    expect(ttl.validate(60)).toBe(true);
    const hosts = findAdminSetting('connector.allowedRedirectHosts')!;
    expect(hosts.validate(['loopback', 'chatgpt.com'])).toBe(true);
    expect(hosts.validate(['https://chatgpt.com/path'])).toBe(false);
    expect(hosts.validate(Array(101).fill('chatgpt.com'))).toBe(false);
    const host = findAdminSetting('integration.gitlab.host')!;
    for (const value of [
      'https://user:secret@host.test',
      'https://host.test/path',
      'https://host.test?q=secret',
      'http://remote.test',
    ])
      expect(host.validate(value)).toBe(false);
    expect(host.validate('http://localhost')).toBe(true);
    expect(host.validate('https://gitlab.example')).toBe(true);
  });

  it('publishes secret classification without secret values or credential implementation', () => {
    const secrets = ADMIN_SETTINGS_REGISTRY.filter((setting) => setting.secret);
    expect(secrets).toHaveLength(4);
    expect(new Set(secrets.map((setting) => setting.credential?.provider)).size).toBe(4);
    for (const secret of secrets) {
      expect(secret.defaultValue).toBeNull();
      const metadata = publicAdminSettingDefinition(secret);
      expect(metadata.secret).toBe(true);
      expect(metadata).not.toHaveProperty('credential');
      expect(metadata).not.toHaveProperty('validate');
      expect(metadata).not.toHaveProperty('value');
      expect(secret.validate('short')).toBe(false);
    }
  });
});

describe('D1 settings snapshot cache', () => {
  it.each(['key', 'value', 'updatedAt', 'updatedBy'])(
    'rejects malformed D1 %s fields without exposing row values',
    async (field) => {
      const { database } = fixture();
      const malformed = { ...rows(true)[0], [field]: 42, extra: 'secret-canary' };
      vi.spyOn(database, 'prepare').mockReturnValue({
        all: vi.fn(async () => ({ success: true, results: [malformed] })),
      } as unknown as D1PreparedStatement);
      const cache = new AdminSettingsCache();
      await expect(cache.read(database)).rejects.toThrow('Admin settings are unavailable');
      await cache.read(database).catch((error: Error) => {
        expect(error.message).not.toContain('secret-canary');
      });
    }
  );

  it('accepts nullable audit actors and returns only validated D1 fields', async () => {
    const { database } = fixture();
    vi.spyOn(database, 'prepare').mockReturnValue({
      all: vi.fn(async () => ({
        success: true,
        results: [{ ...rows(false)[0], updatedBy: null, extra: 'secret-canary' }],
      })),
    } as unknown as D1PreparedStatement);
    const result = await new AdminSettingsCache().read(database);
    expect(result).toEqual([{ ...rows(false)[0], updatedBy: null }]);
    expect(JSON.stringify(result)).not.toContain('secret-canary');
  });

  it('observes local invalidation immediately and another instance within the TTL', async () => {
    const { database, set } = fixture();
    let now = 0;
    const local = new AdminSettingsCache(undefined, () => now);
    const other = new AdminSettingsCache(undefined, () => now);
    expect((await local.read(database))[0]?.value).toBe('true');
    await other.read(database);
    set(false);
    local.invalidate(database);
    expect((await local.read(database))[0]?.value).toBe('false');
    expect((await other.read(database))[0]?.value).toBe('true');
    now = ADMIN_SETTINGS_CACHE_MAX_MS;
    expect((await other.read(database))[0]?.value).toBe('false');
  });

  it('does not serve expired permissive snapshots on D1 outage or expose raw D1 errors', async () => {
    const { database } = fixture();
    let now = 0;
    const load = vi
      .fn()
      .mockResolvedValueOnce(rows(true))
      .mockRejectedValue(new Error('secret-canary SQL parameters'));
    const cache = new AdminSettingsCache(undefined, () => now, load);
    await cache.read(database);
    now = ADMIN_SETTINGS_CACHE_MAX_MS;
    await expect(cache.read(database)).rejects.toThrow('Admin settings are unavailable');
    await cache
      .read(database)
      .catch((error: Error) => expect(error.message).not.toContain('secret-canary'));
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('revokes a pre-save read from both cache publication and its waiting callers', async () => {
    const { database } = fixture();
    let release!: (value: AdminSettingOverrideRow[]) => void;
    const pending = new Promise<AdminSettingOverrideRow[]>((resolve) => {
      release = resolve;
    });
    const load = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(rows(false));
    const cache = new AdminSettingsCache(undefined, () => 0, load);
    const first = cache.read(database);
    const joined = cache.read(database);
    expect(load).toHaveBeenCalledTimes(1);
    cache.invalidate(database);
    expect((await cache.read(database))[0]?.value).toBe('false');
    release(rows(true));
    expect((await first)[0]?.value).toBe('false');
    expect((await joined)[0]?.value).toBe('false');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('revokes a cache hit invalidated before its awaiting caller resumes', async () => {
    const { database } = fixture();
    const load = vi.fn().mockResolvedValueOnce(rows(true)).mockResolvedValue(rows(false));
    const cache = new AdminSettingsCache(undefined, () => 0, load);
    await cache.read(database);
    const pending = cache.read(database);
    cache.invalidate(database);
    expect((await pending)[0]?.value).toBe('false');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('rejects a pending read across a test reset and starts the new cache independently', async () => {
    const { database } = fixture();
    let release!: (value: AdminSettingOverrideRow[]) => void;
    const load = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<AdminSettingOverrideRow[]>((resolve) => {
          release = resolve;
        })
      )
      .mockResolvedValue(rows(false));
    const cache = new AdminSettingsCache(undefined, () => 0, load);
    const pending = cache.read(database);
    const rejected = expect(pending).rejects.toThrow('Admin settings are unavailable');
    cache.resetForTest();
    release(rows(true));
    await rejected;
    expect((await cache.read(database))[0]?.value).toBe('false');
  });

  it('does not leak snapshots across bindings or allow callers to mutate cached rows', async () => {
    const a = fixture();
    const b = fixture();
    b.set(false);
    const cache = new AdminSettingsCache();
    const result = await cache.read(a.database);
    result[0]!.value = 'malicious';
    expect((await cache.read(a.database))[0]?.value).toBe('true');
    expect((await cache.read(b.database))[0]?.value).toBe('false');
  });

  it('shares stable binding identity across request-session facades', async () => {
    const { database } = fixture();
    const withSession = vi.fn(() => database);
    const underlying = Object.assign(database, { withSession });
    const load = vi.fn().mockResolvedValue(rows(false));
    const cache = new AdminSettingsCache(undefined, () => 0, load);
    await cache.read(createRequestScopedD1(underlying));
    await cache.read(createRequestScopedD1(underlying));
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(underlying);
    expect(withSession).not.toHaveBeenCalled();
    cache.invalidate(createRequestScopedD1(underlying));
    await cache.read(createRequestScopedD1(underlying));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not republish an older request-session snapshot after invalidation', async () => {
    const { database, set } = fixture();
    const staleSession = {
      prepare: vi.fn(() => ({ all: vi.fn(async () => ({ success: true, results: rows(true) })) })),
      batch: database.batch,
      getBookmark: () => 'before-admin-commit',
    } as unknown as D1DatabaseSession;
    const underlying = Object.assign(database, { withSession: () => staleSession });
    const oldFacade = createRequestScopedD1(underlying);
    // Simulate a request whose previous D1 query pinned it before the settings edit.
    await oldFacade.prepare('SELECT key FROM platform_settings').all();
    set(false);
    const cache = new AdminSettingsCache();
    cache.invalidate(oldFacade);
    expect((await cache.read(oldFacade))[0]?.value).toBe('false');
    expect((await cache.read(createRequestScopedD1(underlying)))[0]?.value).toBe('false');
    expect(staleSession.prepare).toHaveBeenCalledTimes(1);
  });

  it('caps even excessive TTL configuration and can bypass cache for admin truth', async () => {
    const { database, set } = fixture();
    let now = 0;
    const cache = new AdminSettingsCache(Number.MAX_SAFE_INTEGER, () => now);
    await cache.read(database);
    set(false);
    expect((await cache.read(database, true))[0]?.value).toBe('false');
    now = ADMIN_SETTINGS_CACHE_MAX_MS;
    expect((await cache.read(database))[0]?.value).toBe('false');
  });

  it('does not extend freshness when a second caller joins a slow read', async () => {
    const { database } = fixture();
    let now = 0;
    let release!: (value: AdminSettingOverrideRow[]) => void;
    const load = vi.fn(
      () =>
        new Promise<AdminSettingOverrideRow[]>((resolve) => {
          release = resolve;
        })
    );
    const cache = new AdminSettingsCache(undefined, () => now, load);
    const first = cache.read(database);
    now = ADMIN_SETTINGS_CACHE_MAX_MS - 1;
    const second = cache.read(database);
    now = ADMIN_SETTINGS_CACHE_MAX_MS;
    release(rows(true));
    await expect(first).rejects.toThrow('Admin settings are unavailable');
    await expect(second).rejects.toThrow('Admin settings are unavailable');
  });
});
