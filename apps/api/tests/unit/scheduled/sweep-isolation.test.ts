/**
 * Regression tests for per-sweep error isolation in the scheduled cron handler.
 *
 * THE INCIDENT THIS PREVENTS
 *
 * The 5-minute cron ran its sweeps as a flat sequence of bare `await`s. On
 * 2026-08-05T20:25Z `runNodeCleanupSweep` started throwing in production and the
 * handler unwound, silently skipping all eight sweeps that followed it. Thirteen
 * hours later node reaping was still dead, 21 active USER cron triggers had not
 * fired (earliest next_fire_at was five hours overdue), and the shared Hetzner
 * account had filled up until staging deploys 403'd.
 *
 * Nothing alerted, because the only symptom was an ABSENCE of downstream effects.
 *
 * These tests pin the two properties that matter: a failing sweep cannot suppress
 * a later one, and the failure is recorded loudly enough to see.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { createSweepIsolator } from '../../../src/scheduled/sweep-isolation';

const persistError = vi.fn().mockResolvedValue(undefined);
const logError = vi.fn();

vi.mock('../../../src/services/observability', () => ({
  persistError: (...args: unknown[]) => persistError(...args),
}));
vi.mock('../../../src/lib/logger', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => logError(...args),
    debug: vi.fn(),
  },
}));

function makeEnv(): Env {
  return { OBSERVABILITY_DATABASE: {} } as unknown as Env;
}

beforeEach(() => {
  persistError.mockClear();
  persistError.mockResolvedValue(undefined);
  logError.mockClear();
});

describe('createSweepIsolator', () => {
  it('a throwing sweep does not prevent later sweeps from running', async () => {
    const order: string[] = [];
    const sweeps = createSweepIsolator(makeEnv());

    // Mirrors the production ordering: the sweep that failed sat in the middle,
    // with the user-facing cron-trigger sweep downstream of it.
    const first = await sweeps.isolate('diagnosis_reconcile', async () => {
      order.push('diagnosis_reconcile');
      return { restarted: 1 };
    });
    const failing = await sweeps.isolate('node_cleanup', async () => {
      order.push('node_cleanup');
      throw new Error('D1_ERROR: too many subrequests');
    });
    const downstream = await sweeps.isolate('cron_triggers', async () => {
      order.push('cron_triggers');
      return { fired: 3 };
    });
    const last = await sweeps.isolate('trial_expire', async () => {
      order.push('trial_expire');
      return { expired: 2 };
    });

    // Every sweep ran, in order — this is the whole point.
    expect(order).toEqual(['diagnosis_reconcile', 'node_cleanup', 'cron_triggers', 'trial_expire']);

    expect(first).toEqual({ restarted: 1 });
    expect(downstream).toEqual({ fired: 3 });
    expect(last).toEqual({ expired: 2 });

    // The failed sweep yields undefined, NOT a zero-valued result: a sweep that
    // crashed must be distinguishable in logs from one that ran and found nothing.
    expect(failing).toBeUndefined();
  });

  it('records each failure by name so the outage is visible', async () => {
    const sweeps = createSweepIsolator(makeEnv());

    await sweeps.isolate('node_cleanup', async () => {
      throw new Error('boom');
    });
    await sweeps.isolate('cron_triggers', async () => ({ fired: 0 }));
    await sweeps.isolate('trial_expire', async () => {
      throw new Error('kaboom');
    });

    expect(sweeps.failedSweeps()).toEqual(['node_cleanup', 'trial_expire']);
    expect(sweeps.failures()).toEqual([
      { sweep: 'node_cleanup', error: 'boom' },
      { sweep: 'trial_expire', error: 'kaboom' },
    ]);

    expect(logError).toHaveBeenCalledWith(
      'cron.sweep_failed',
      expect.objectContaining({ sweep: 'node_cleanup', error: 'boom' })
    );

    // Durable record — the 2026-08-05 outage was invisible precisely because
    // nothing was written anywhere when the sweep died.
    expect(persistError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        level: 'error',
        message: expect.stringContaining('node_cleanup'),
        context: expect.objectContaining({ recoveryType: 'cron_sweep_failure' }),
      }),
      expect.anything()
    );
  });

  it('reports no failures when every sweep succeeds', async () => {
    const sweeps = createSweepIsolator(makeEnv());

    await sweeps.isolate('a', async () => 1);
    await sweeps.isolate('b', async () => 2);

    expect(sweeps.failedSweeps()).toEqual([]);
    expect(persistError).not.toHaveBeenCalled();
  });

  it('a failure while RECORDING a failure still does not abort the cron', async () => {
    // If observability D1 is also unhealthy, the isolator must swallow that too —
    // otherwise the error handler reintroduces exactly the bug it exists to fix.
    persistError.mockRejectedValue(new Error('observability D1 unavailable'));
    const sweeps = createSweepIsolator(makeEnv());

    await expect(
      sweeps.isolate('node_cleanup', async () => {
        throw new Error('primary failure');
      })
    ).resolves.toBeUndefined();

    const after = await sweeps.isolate('cron_triggers', async () => ({ fired: 1 }));
    expect(after).toEqual({ fired: 1 });
    expect(sweeps.failedSweeps()).toEqual(['node_cleanup']);
  });

  it('captures non-Error throws without losing the sweep name', async () => {
    const sweeps = createSweepIsolator(makeEnv());

    await sweeps.isolate('node_cleanup', async () => {
      throw 'string failure';
    });

    expect(sweeps.failures()).toEqual([{ sweep: 'node_cleanup', error: 'string failure' }]);
  });

  it('a throwing retention step cannot suppress the later snapshot and artifact steps', async () => {
    const order: string[] = [];
    const sweeps = createSweepIsolator(makeEnv());

    const releaseRetention = await sweeps.isolate('deployment_release_retention', async () => {
      order.push('deployment_release_retention');
      throw new Error('D1 release retention failure');
    });
    const snapshotPurge = await sweeps.isolate('session_snapshot_purge', async () => {
      order.push('session_snapshot_purge');
      return { deletedSnapshots: 2 };
    });
    const composeCleanup = await sweeps.isolate('compose_artifact_cleanup', async () => {
      order.push('compose_artifact_cleanup');
      return { deletedObjects: 3 };
    });

    expect(order).toEqual([
      'deployment_release_retention',
      'session_snapshot_purge',
      'compose_artifact_cleanup',
    ]);
    expect(releaseRetention).toBeUndefined();
    expect(snapshotPurge).toEqual({ deletedSnapshots: 2 });
    expect(composeCleanup).toEqual({ deletedObjects: 3 });
    expect(sweeps.failedSweeps()).toEqual(['deployment_release_retention']);
  });
});
