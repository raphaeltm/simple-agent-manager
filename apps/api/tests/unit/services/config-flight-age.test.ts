import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminSettingsCache } from '../../../src/services/admin-settings-cache';
import {
  __resetAdminSettingsCacheForTest,
  credentialRows,
  resolveAdminSettingDetails,
} from '../../../src/services/admin-settings-resolution';
import { withDeadline } from '../../../src/services/fetch-timeout';
import {
  __resetPlatformConfigCacheForTest,
  resolveLoginOAuthConfig,
  resolvePlatformConfig,
} from '../../../src/services/platform-config';
import { createEnv } from '../../helpers/platform-config-counting-fixture';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function stallOneRead(database: D1Database, matches: (sql: string) => boolean) {
  const started = deferred<void>();
  const gate = deferred<void>();
  let armed = true;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        const value = Reflect.get(target, key);
        if ((key === 'all' || key === 'first') && typeof value === 'function') {
          return async (...args: unknown[]) => {
            const result = await value.apply(target, args);
            if (armed && matches(sql)) {
              armed = false;
              started.resolve();
              await gate.promise;
            }
            return result;
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return {
    database: new Proxy(database, {
      get(target, key) {
        if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
    started: started.promise,
    finish: (outcome: string) =>
      outcome === 'resolve' ? gate.resolve() : gate.reject(new Error('old load failed')),
  };
}
let clock: number;
beforeEach(() => {
  clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  __resetAdminSettingsCacheForTest();
  __resetPlatformConfigCacheForTest();
});
afterEach(() => vi.restoreAllMocks());
const oldRows = [{ key: 'example', value: 'old', updatedAt: 'then', updatedBy: null }];
const newRows = [{ ...oldRows[0]!, value: 'new' }];

describe('abandoned cache owner recovery without its timer running', () => {
  it.each(['resolve', 'reject'])(
    'replaces aged admin rows; late owner %s cannot alter replacement',
    async (outcome) => {
      const old = deferred<typeof oldRows>();
      const load = vi
        .fn()
        .mockImplementationOnce(() => old.promise)
        .mockResolvedValue(newRows);
      const cache = new AdminSettingsCache(60_000, () => clock, load);
      const database = {} as D1Database;
      const owner = cache.read(database).then(
        (value) => value,
        () => null
      );
      const joined = cache.read(database).then(
        (value) => value,
        () => null
      );
      clock += 5_001; // Wall clock advances; no timer callbacks run on behalf of the old owner.
      try {
        expect(await withDeadline(() => cache.read(database), 1_000)).toEqual(newRows);
      } finally {
        if (outcome === 'resolve') old.resolve(oldRows);
        else old.reject(new Error('old load failed'));
        const late = await owner;
        if (late) expect(late).toEqual(newRows);
        const lateJoin = await joined;
        if (lateJoin) expect(lateJoin).toEqual(newRows);
      }
      clock += 5_001;
      expect(await cache.read(database)).toEqual(newRows);
      expect(load).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['resolve', 'reject'])(
    'replaces aged ciphertext read; late owner %s cannot alter replacement',
    async (outcome) => {
      const { env, counter } = createEnv();
      await env.DATABASE.prepare(
        `INSERT INTO platform_credentials
      (id,credential_type,provider,credential_kind,label,encrypted_token,iv,is_enabled,created_by,created_at,updated_at)
      VALUES ('c','platform-integration','github','github.clientSecret','test','old','iv',1,'admin','then','then')`
      ).run();
      const raw = env.DATABASE;
      const stalled = stallOneRead(raw, (sql) => sql.startsWith('SELECT provider,credential_kind'));
      env.DATABASE = stalled.database;
      const owner = credentialRows(env).then(
        (value) => value,
        () => null
      );
      await stalled.started;
      const joined = credentialRows(env).then(
        (value) => value,
        () => null
      );
      await raw.prepare("UPDATE platform_credentials SET encrypted_token='new'").run();
      clock += 5_001;
      try {
        expect((await withDeadline(() => credentialRows(env), 1_000))[0]?.ciphertext).toBe('new');
      } finally {
        stalled.finish(outcome);
        const late = await owner;
        if (late) expect(late[0]?.ciphertext).toBe('new');
        const lateJoin = await joined;
        if (lateJoin) expect(lateJoin[0]?.ciphertext).toBe('new');
      }
      const reads = counter.platformConfigReads().length;
      clock += 5_001;
      expect((await credentialRows(env))[0]?.ciphertext).toBe('new');
      expect(counter.platformConfigReads()).toHaveLength(reads);
    }
  );

  it.each(['resolve', 'reject'])(
    'replaces aged KV read; late owner %s cannot alter replacement',
    async (outcome) => {
      const old = deferred<string | null>();
      const started = deferred<void>();
      const get = vi
        .fn()
        .mockImplementationOnce(() => {
          started.resolve();
          return old.promise;
        })
        .mockResolvedValue('false');
      const { env } = createEnv({ KV: { get } as unknown as KVNamespace });
      const read = () => resolveAdminSettingDetails(env, 'trials.enabled');
      const owner = read().then(
        (value) => value,
        () => null
      );
      await started.promise;
      const joined = read().then(
        (value) => value,
        () => null
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      clock += 5_001;
      try {
        expect((await withDeadline(read, 1_000)).value).toBe(false);
      } finally {
        if (outcome === 'resolve') old.resolve('true');
        else old.reject(new Error('old load failed'));
        const late = await owner;
        if (late) expect(late.value).toBe(false);
        const lateJoin = await joined;
        if (lateJoin) expect(lateJoin.value).toBe(false);
      }
      clock += 5_001;
      expect((await read()).value).toBe(false);
      expect(get).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['resolve', 'reject'])(
    'replaces aged legacy config; late owner %s cannot alter replacement',
    async (outcome) => {
      const { env, counter } = createEnv();
      await env.DATABASE.prepare(
        "INSERT INTO platform_settings(key,value,updated_at) VALUES ('integration.github.appId','old','then')"
      ).run();
      const raw = env.DATABASE;
      const stalled = stallOneRead(raw, (sql) => sql.startsWith('SELECT value, updated_at'));
      env.DATABASE = stalled.database;
      await resolveLoginOAuthConfig(env);
      const owner = resolvePlatformConfig(env).then(
        (value) => value,
        () => null
      );
      await stalled.started;
      const joined = resolvePlatformConfig(env).then(
        (value) => value,
        () => null
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      await raw
        .prepare("UPDATE platform_settings SET value='new' WHERE key='integration.github.appId'")
        .run();
      clock += 5_001;
      try {
        expect(
          (await withDeadline(() => resolvePlatformConfig(env), 1_000)).github.appId.value
        ).toBe('new');
      } finally {
        stalled.finish(outcome);
        const late = await owner;
        if (late) expect(late.github.appId.value).toBe('new');
        const lateJoin = await joined;
        if (lateJoin) expect(lateJoin.github.appId.value).toBe('new');
      }
      const reads = counter.platformConfigReads().length;
      clock += 5_001;
      expect((await resolvePlatformConfig(env)).github.appId.value).toBe('new');
      expect(counter.platformConfigReads()).toHaveLength(reads);
    }
  );
});
