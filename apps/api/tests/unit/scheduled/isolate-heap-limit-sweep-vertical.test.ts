/**
 * A celld isolate stuck over its V8 heap limit, seen from the real `scheduled()` handler.
 *
 * On the self-host box (2026-11-21) every KV read from the cron isolate threw celld's refusal for
 * 33 hours, so `deployment_release_retention` and `gcp_price_table` failed on every tick and the
 * failed-sweep notifications (which read KV too) never went out. These tests drive the real
 * handler, the real sweep isolator and the real two sweeps, with a KV that throws celld's exact
 * error (js/harness.js, celld 0.6.3) while the isolate is "condemned".
 *
 * The line format asserted here is what deploy/selfhost/celld/start.sh restarts celld on.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  ISOLATE_HEAP_LIMIT_EVENT,
  resetIsolateHeapLimitStateForTest,
} from '../../../src/scheduled/isolate-heap-limit';
import { persistError } from '../../../src/services/observability';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

/** celld 0.6.3 js/harness.js SqlCursor.toArray, verbatim. */
const CELLD_REFUSAL =
  'the isolate is over its V8 heap limit, so it stopped materializing a result set (see CELLD_V8_HEAP_LIMIT_MB)';
/** The sweeps that read KV first on every tick, as on the box. */
const KV_SWEEPS = new Set(['deployment_release_retention', 'gcp_price_table']);

vi.mock('../../../src/services/operational-kill-switch', () => ({
  isOperationalLoopEnabled: vi.fn(async () => true),
}));
vi.mock('../../../src/scheduled/platform-feedback-hourly', () => ({
  isHourlyPlatformMaintenanceCron: vi.fn(() => false),
  scheduleHourlyPlatformMaintenance: vi.fn(() => false),
}));
vi.mock('../../../src/scheduled/sweep-isolation', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/scheduled/sweep-isolation')>();
  return {
    createSweepIsolator: vi.fn((env: Parameters<typeof real.createSweepIsolator>[0]) => {
      const isolator = real.createSweepIsolator(env);
      return {
        ...isolator,
        // Only the two KV-reading sweeps run; every other sweep reports "no data this tick".
        isolate: (name: string, fn: () => Promise<unknown>) =>
          KV_SWEEPS.has(name) ? isolator.isolate(name, fn) : Promise.resolve(undefined),
      };
    }),
  };
});
vi.mock('../../../src/services/observability', () => ({ persistError: vi.fn() }));

const { scheduled } = await import('../../../src/scheduled/handler');

const controller = { cron: '*/5 * * * *' } as ScheduledController;
const context = { waitUntil: vi.fn() } as unknown as ExecutionContext;

describe('scheduled handler: isolate stuck over its V8 heap limit', () => {
  let sqlite: Database.Database;
  let env: Env;
  let condemned: boolean;
  let lines: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    resetIsolateHeapLimitStateForTest();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    const kv = createMemoryKv();
    condemned = true;
    const refuse = (method: (...args: never[]) => unknown) =>
      (async (...args: never[]) => {
        if (condemned) throw new Error(CELLD_REFUSAL);
        return method(...args);
      }) as never;
    env = {
      DATABASE: createSqliteD1(sqlite),
      OBSERVABILITY_DATABASE: {},
      KV: { ...kv, get: refuse(kv.get.bind(kv)), put: refuse(kv.put.bind(kv)) },
    } as unknown as Env;
    lines = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
    }
  });

  afterEach(() => {
    vi.mocked(persistError).mockReset();
    vi.restoreAllMocks();
    sqlite.close();
  });

  const events = (name: string) =>
    lines
      .filter((line) => line.includes(`"event":"${name}"`))
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  it('counts consecutive failing ticks in a line start.sh can match, and records them without KV', async () => {
    await scheduled(controller, env, context);
    await scheduled(controller, env, context);

    // Liveness: both real sweeps ran and failed with celld's refusal.
    const failed = events('cron.sweep_failed').map((event) => event.sweep);
    expect(failed).toEqual([
      'deployment_release_retention',
      'gcp_price_table',
      'deployment_release_retention',
      'gcp_price_table',
    ]);
    const heap = events(ISOLATE_HEAP_LIMIT_EVENT);
    expect(heap.map((event) => event.consecutiveTicks)).toEqual([1, 2]);
    expect(heap[1]).toMatchObject({ level: 'error', sweepCount: 2 });
    // The exact substrings start.sh matches (no spaces, flat number).
    const raw = lines.filter((line) => line.includes(ISOLATE_HEAP_LIMIT_EVENT));
    expect(raw[1]).toContain('"event":"cron.isolate_heap_limit"');
    expect(raw[1]).toContain('"consecutiveTicks":2');
    // Durable record in observability D1, the store that still answers.
    expect(vi.mocked(persistError)).toHaveBeenCalledWith(
      env.OBSERVABILITY_DATABASE,
      expect.objectContaining({
        context: expect.objectContaining({
          recoveryType: 'isolate_heap_limit',
          consecutiveTicks: 2,
        }),
      }),
      env
    );
    expect(events('cron.completed').map((event) => event.isolateHeapLimitTicks)).toEqual([1, 2]);
  });

  it('resets on the first clean tick, so a later spike starts again at one', async () => {
    await scheduled(controller, env, context);
    await scheduled(controller, env, context);
    condemned = false;
    await scheduled(controller, env, context);
    condemned = true;
    await scheduled(controller, env, context);

    expect(events(ISOLATE_HEAP_LIMIT_EVENT).map((event) => event.consecutiveTicks)).toEqual([
      1, 2, 1,
    ]);
    // Liveness: all four ticks ran both sweeps; only the three refused ticks failed them.
    expect(events('cron.sweep_failed')).toHaveLength(6);
    // The clean tick really ran the sweeps (they wrote their KV markers) and reported zero.
    expect(events('cron.completed').map((event) => event.isolateHeapLimitTicks)).toEqual([
      1, 2, 0, 1,
    ]);
  });

  it('counts only the refused sweeps on a tick that also has an unrelated failure', async () => {
    const kv = env.KV;
    env = {
      ...env,
      KV: {
        ...kv,
        get: async (key: string, ...rest: never[]) => {
          if (key.includes('gcp')) throw new Error('KV GET failed: 503 Service Unavailable');
          return (kv.get as (...args: unknown[]) => unknown)(key, ...rest);
        },
      },
    } as unknown as Env;

    await scheduled(controller, env, context);

    expect(events('cron.sweep_failed')).toHaveLength(2);
    expect(events(ISOLATE_HEAP_LIMIT_EVENT)).toMatchObject([
      { consecutiveTicks: 1, sweepCount: 1, sweeps: ['deployment_release_retention'] },
    ]);
  });

  it('keeps counting when recording the failure itself fails', async () => {
    vi.mocked(persistError).mockImplementation(async (_db, error) => {
      if (
        (error.context as { recoveryType?: string } | undefined)?.recoveryType ===
        'isolate_heap_limit'
      ) {
        throw new Error('observability D1 unavailable');
      }
    });

    await scheduled(controller, env, context);
    await scheduled(controller, env, context);

    expect(events(ISOLATE_HEAP_LIMIT_EVENT).map((event) => event.consecutiveTicks)).toEqual([1, 2]);
    expect(events('cron.isolate_heap_limit_persist_failed')).toHaveLength(2);
    expect(events('cron.completed').map((event) => event.isolateHeapLimitTicks)).toEqual([1, 2]);
  });

  it('ignores sweep failures that are not the heap refusal', async () => {
    env = {
      ...env,
      KV: {
        ...env.KV,
        get: async () => {
          throw new Error('KV GET failed: 503 Service Unavailable');
        },
      },
    } as unknown as Env;

    await scheduled(controller, env, context);
    await scheduled(controller, env, context);

    expect(events('cron.sweep_failed')).toHaveLength(4);
    expect(events(ISOLATE_HEAP_LIMIT_EVENT)).toHaveLength(0);
    expect(events('cron.completed').map((event) => event.isolateHeapLimitTicks)).toEqual([0, 0]);
  });
});
