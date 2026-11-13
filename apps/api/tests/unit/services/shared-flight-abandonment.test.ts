/**
 * Abandonment branches of every per-isolate in-flight cache (task F1, review V1 of #2706).
 *
 * On the self-hosted celld runtime a request's async ops (D1 call, KV read, DO RPC, its deadline
 * timer) are dropped when that request's client disconnects, so a flight it started never
 * settles (src/lib/shared-flight.ts). Each case below models that exactly: the starter's read
 * never resolves, and `vi.clearAllTimers()` drops the starter's own deadline timer, as celld does.
 * Then several requests join the dead flight. They must
 *   - keep waiting until the flight's deadline plus the join grace (a slow live read is never
 *     duplicated early), then
 *   - share ONE replacement read between them (no storm), and answer.
 *
 * Each case runs in both join modes (task R7): Cloudflare, where the flight's settlement resumes
 * a joiner, and celld, where a joiner resumes on its own timer (lib/shared-flight.ts). On celld the
 * waiters of the replacement read wake on their own poll timer, so each case advances by one poll
 * interval past the bound before it reads the answers.
 *
 * Proven discriminating (F1): removing the abandonment retry in `credentialRows` / `legacyKv` /
 * `resolveLegacyPlatformConfig` turns the matching case red; registering nothing on abandonment
 * in `ensureOncePerIsolate` turns the ensure case red (three extra ensures instead of one).
 */
import {
  DEFAULT_PROJECT_DATA_ENSURE_JOIN_WAIT_MS,
  ensureOncePerIsolate,
  resetProjectDataEnsureMemo,
} from '@simple-agent-manager/project-data/internal/client/project-data-ensure-memo';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  __setSharedFlightResumeOnOwnTimerForTest,
  DEFAULT_SHARED_FLIGHT_JOIN_GRACE_MS,
  SHARED_FLIGHT_POLL_MS,
} from '../../../src/lib/shared-flight';
import { resolveAdminSetting } from '../../../src/services/admin-settings';
import {
  __resetAdminSettingsCacheForTest,
  credentialRows,
} from '../../../src/services/admin-settings-resolution';
import { DEFAULT_CONFIG_READ_TIMEOUT_MS } from '../../../src/services/config-read-deadline';
import {
  __resetPlatformConfigCacheForTest,
  resolvePlatformConfig,
} from '../../../src/services/platform-config';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';
import { createEnv } from '../../helpers/platform-config-counting-fixture';

const never = <T>() => new Promise<T>(() => undefined);
/** How long a joiner waits on a flight whose deadline is `DEFAULT_CONFIG_READ_TIMEOUT_MS` away. */
const JOIN_BOUND_MS = DEFAULT_CONFIG_READ_TIMEOUT_MS + DEFAULT_SHARED_FLIGHT_JOIN_GRACE_MS;

let open: Database.Database[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  __resetAdminSettingsCacheForTest();
  __resetPlatformConfigCacheForTest();
  resetProjectDataEnsureMemo();
});
afterEach(() => {
  vi.useRealTimers();
  __setSharedFlightResumeOnOwnTimerForTest(false);
  for (const sqlite of open) sqlite.close();
  open = [];
});

/** Track settlement of each promise without awaiting it. */
function watch<T>(promises: Promise<T>[]) {
  const settled = promises.map(() => false);
  promises.forEach((p, i) => {
    void p.then(
      () => (settled[i] = true),
      () => (settled[i] = true)
    );
  });
  return settled;
}

/**
 * Advance fake time one poll interval at a time until `done()`. On celld a request waits even on
 * its own settings flight through the join poll, so its next read starts a poll interval later.
 */
async function advanceUntil(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await vi.advanceTimersByTimeAsync(SHARED_FLIGHT_POLL_MS);
  expect(done()).toBe(true);
}

/** Await a call that may wait on join-poll timers, advancing fake time until it settles. */
async function untilSettled<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true)
  );
  await vi.advanceTimersByTimeAsync(0);
  await advanceUntil(() => done);
  return promise;
}

/**
 * Start a flight, wait until its read is in flight, then drop every timer the way celld drops a
 * cancelled request's ops (its deadline timer included).
 */
async function startAndDrop(start: () => Promise<unknown>, inFlight: () => boolean): Promise<void> {
  void start().catch(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  await advanceUntil(inFlight);
  vi.clearAllTimers();
}

describe.each([
  { runtime: 'Cloudflare', ownTimer: false },
  { runtime: 'celld', ownTimer: true },
])('$runtime joins', ({ ownTimer }) => {
  beforeEach(() => __setSharedFlightResumeOnOwnTimerForTest(ownTimer));

  describe('credentialRows: joiners of a dropped credential read', () => {
    it('wait out its deadline, then share one replacement read', async () => {
      const { sqlite, env } = createAdminSettingsEnv();
      open.push(sqlite);
      let reads = 0;
      const realPrepare = env.DATABASE.prepare.bind(env.DATABASE);
      env.DATABASE.prepare = ((sql: string) => {
        const statement = realPrepare(sql);
        if (!sql.includes('credential_kind AS kind')) return statement;
        return {
          bind: (...args: unknown[]) => {
            const bound = statement.bind(...args);
            return {
              all: () => {
                reads += 1;
                return reads === 1 ? never() : bound.all();
              },
            };
          },
        };
      }) as typeof env.DATABASE.prepare;

      await startAndDrop(
        () => credentialRows(env),
        () => reads >= 1
      );
      expect(reads).toBe(1);

      const joiners = [credentialRows(env), credentialRows(env), credentialRows(env)];
      const settled = watch(joiners);
      await vi.advanceTimersByTimeAsync(JOIN_BOUND_MS - 1);
      expect(settled).toEqual([false, false, false]);
      expect(reads).toBe(1);

      await vi.advanceTimersByTimeAsync(1 + SHARED_FLIGHT_POLL_MS);
      // Liveness: every joiner answers with the real (empty) result.
      await expect(Promise.all(joiners)).resolves.toEqual([[], [], []]);
      expect(reads).toBe(2);
    });
  });

  describe('legacyKv: joiners of a dropped kill-switch KV read', () => {
    it('wait out its deadline, then share one replacement read', async () => {
      const { sqlite, env } = createAdminSettingsEnv();
      open.push(sqlite);
      await env.KV.put('control-loops:cron-enabled', 'false');
      let reads = 0;
      const realGet = env.KV.get.bind(env.KV);
      env.KV.get = ((key: string, options?: unknown) => {
        if (key !== 'control-loops:cron-enabled') return realGet(key, options as never);
        reads += 1;
        return reads === 1 ? never() : realGet(key, options as never);
      }) as typeof env.KV.get;

      await startAndDrop(
        () => resolveAdminSetting(env, 'operations.cronSweepsEnabled'),
        () => reads >= 1
      );
      expect(reads).toBe(1);

      const joiners = [
        resolveAdminSetting(env, 'operations.cronSweepsEnabled'),
        resolveAdminSetting(env, 'operations.cronSweepsEnabled'),
        resolveAdminSetting(env, 'operations.cronSweepsEnabled'),
      ];
      const settled = watch(joiners);
      await vi.advanceTimersByTimeAsync(JOIN_BOUND_MS - 1);
      expect(settled).toEqual([false, false, false]);

      await vi.advanceTimersByTimeAsync(1 + SHARED_FLIGHT_POLL_MS);
      // The KV kill switch still wins: the joiners read the real value, not a default.
      await expect(Promise.all(joiners)).resolves.toEqual([false, false, false]);
      expect(reads).toBe(2);
    });
  });

  describe('platform config: joiners of a dropped legacy-config read', () => {
    it('wait out its deadline, then share one replacement read', async () => {
      const { env, counter } = createEnv();
      // Warm the admin-settings caches so only the legacy platform-config read is in flight below.
      await untilSettled(resolvePlatformConfig(env));
      __resetPlatformConfigCacheForTest();
      counter.reset();
      await untilSettled(resolvePlatformConfig(env));
      const legacyReads = () =>
        counter.executed.filter((sql) => /WHERE key = \?|AS encryptedToken/.test(sql)).length;
      const perRead = legacyReads();
      expect(perRead).toBeGreaterThan(0);
      __resetPlatformConfigCacheForTest();
      counter.reset();

      const gate = counter.stall();
      await startAndDrop(
        () => resolvePlatformConfig(env),
        () => legacyReads() >= perRead
      );
      gate.disarm(); // the dropped read stays stuck; new reads run
      expect(legacyReads()).toBe(perRead);

      const joiners = [resolvePlatformConfig(env), resolvePlatformConfig(env)];
      const settled = watch(joiners);
      await vi.advanceTimersByTimeAsync(JOIN_BOUND_MS - 1);
      expect(settled).toEqual([false, false]);
      expect(legacyReads()).toBe(perRead);

      await vi.advanceTimersByTimeAsync(1 + SHARED_FLIGHT_POLL_MS);
      const [a, b] = await Promise.all(joiners);
      expect(a.github.appSlug.value).toBe('env-app-slug');
      expect(b).toStrictEqual(a);
      expect(legacyReads()).toBe(2 * perRead);
      // The replacement was published: the next caller is served from the cache.
      counter.reset();
      await untilSettled(resolvePlatformConfig(env));
      expect(legacyReads()).toBe(0);
    });
  });

  describe('ensureOncePerIsolate: waiters on a dropped ensure', () => {
    it('send the slow Durable Object one extra ensure, not one per waiter', async () => {
      let calls = 0;
      const ensure = () => {
        calls += 1;
        return calls === 1 ? never<void>() : Promise.resolve();
      };
      const memoEnv = {} as Env;

      void ensureOncePerIsolate(memoEnv, 'do-1', ensure);
      await vi.advanceTimersByTimeAsync(0);
      const waiters = [1, 2, 3].map(() => ensureOncePerIsolate(memoEnv, 'do-1', ensure));
      const settled = watch(waiters);
      await vi.advanceTimersByTimeAsync(
        DEFAULT_PROJECT_DATA_ENSURE_JOIN_WAIT_MS + DEFAULT_SHARED_FLIGHT_JOIN_GRACE_MS - 1
      );
      expect(settled).toEqual([false, false, false]);
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(1 + SHARED_FLIGHT_POLL_MS);
      await Promise.all(waiters);
      expect(calls).toBe(2);
      // Remembered: a later caller pays nothing.
      await ensureOncePerIsolate(memoEnv, 'do-1', ensure);
      expect(calls).toBe(2);
    });
  });
});
