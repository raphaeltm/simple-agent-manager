import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  runHourlyPlatformMaintenance,
  scheduleHourlyPlatformMaintenance,
} from '../../../src/scheduled/platform-feedback-hourly';

describe('scheduled platform feedback triage wiring', () => {
  it('invokes the shared core with the cron trigger and isolates hourly job failures', async () => {
    const env = {} as Env;
    const monthlyCost = vi.fn().mockRejectedValue(new Error('gateway unavailable'));
    const feedbackTriage = vi.fn().mockResolvedValue({
      enabled: true,
      trigger: 'cron',
      groupsFound: 1,
      ideasCreated: 1,
      ideasUpdated: 0,
      groupsSkipped: 0,
      groupsFailed: 0,
      failureReasons: [],
    });

    const result = await runHourlyPlatformMaintenance(env, { monthlyCost, feedbackTriage });

    expect(monthlyCost).toHaveBeenCalledWith(env);
    expect(feedbackTriage).toHaveBeenCalledWith(env, 'cron');
    expect(result.monthlyCost.status).toBe('rejected');
    expect(result.feedbackTriage.status).toBe('fulfilled');
  });

  it('matches only the hourly cron and registers its work with waitUntil', async () => {
    const env = {} as Env;
    const pending: Promise<unknown>[] = [];
    const monthlyCost = vi
      .fn()
      .mockResolvedValue({ enabled: true, usersUpdated: 0, totalEntries: 0, errors: 0 });
    const feedbackTriage = vi.fn().mockResolvedValue({
      enabled: true,
      trigger: 'cron',
      groupsFound: 0,
      ideasCreated: 0,
      ideasUpdated: 0,
      groupsSkipped: 0,
      groupsFailed: 0,
      failureReasons: [],
    });
    const waitUntil = (promise: Promise<unknown>) => pending.push(promise);

    expect(
      scheduleHourlyPlatformMaintenance('*/5 * * * *', env, waitUntil, {
        monthlyCost,
        feedbackTriage,
      })
    ).toBe(false);
    expect(pending).toHaveLength(0);
    expect(
      scheduleHourlyPlatformMaintenance('30 * * * *', env, waitUntil, {
        monthlyCost,
        feedbackTriage,
      })
    ).toBe(true);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(feedbackTriage).toHaveBeenCalledWith(env, 'cron');
  });
});
