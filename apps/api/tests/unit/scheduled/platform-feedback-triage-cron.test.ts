import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { runHourlyPlatformMaintenance } from '../../../src/scheduled/platform-feedback-hourly';

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
    });

    const result = await runHourlyPlatformMaintenance(env, { monthlyCost, feedbackTriage });

    expect(monthlyCost).toHaveBeenCalledWith(env);
    expect(feedbackTriage).toHaveBeenCalledWith(env, 'cron');
    expect(result.monthlyCost.status).toBe('rejected');
    expect(result.feedbackTriage.status).toBe('fulfilled');
  });

  it('keeps the hourly scheduled branch wired to the maintenance helper', () => {
    const source = readFileSync(new URL('../../../src/index.ts', import.meta.url), 'utf8');
    expect(source).toContain("const isMonthlyCostAggregation = controller.cron === '30 * * * *'");
    expect(source).toContain('const hourly = await runHourlyPlatformMaintenance(env)');
  });
});
