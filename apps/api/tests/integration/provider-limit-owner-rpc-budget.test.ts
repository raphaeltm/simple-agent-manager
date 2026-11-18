/** A stalled ProjectData read must not pin the real recovery sweep or resume late. */
import '../helpers/provider-limit-owner-resume-harness';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recoverStuckTasks } from '../../src/scheduled/stuck-tasks';
import * as projectData from '../../src/services/project-data';
import { boundary, createOwnerResumeHarness } from '../helpers/provider-limit-owner-resume-harness';

describe('owner recovery ProjectData RPC budget', () => {
  let harness: Awaited<ReturnType<typeof createOwnerResumeHarness>>;

  beforeEach(async () => {
    vi.resetAllMocks();
    boundary.userId = 'user-1';
    boundary.selected.mockResolvedValue('cc_credentials:account-1');
    harness = await createOwnerResumeHarness({ PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS: '10' });
    const prepare = harness.env.DATABASE.prepare.bind(harness.env.DATABASE);
    const interruption = vi.spyOn(harness.env.DATABASE, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.includes("admission_state='provider_limit_recovery_pending'")) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...args: unknown[]) => {
        const bound = bind(...args);
        const run = bound.run.bind(bound);
        bound.run = async () => {
          await run();
          throw new Error('interrupted after owner release');
        };
        return bound;
      };
      return statement;
    });
    try {
      expect((await harness.resume()).status).toBe(500);
    } finally {
      interruption.mockRestore();
    }
    expect(harness.task().admission_state).toBe('provider_limit_recovery_pending');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    harness.close();
  });

  it('returns from the sweep on a stalled authority read and ignores its late result', async () => {
    const getAccess = projectData.getSessionAccess;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const access = vi.spyOn(projectData, 'getSessionAccess').mockImplementation(async (...args) => {
      const result = await getAccess(...args);
      await gate;
      return result;
    });
    const task = harness.task();
    const claim = harness.claim();
    vi.useFakeTimers();
    let returned = false;
    const sweep = recoverStuckTasks(harness.env).then(() => {
      returned = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(access).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10);
    expect(returned).toBe(true);
    await sweep;
    expect(harness.task()).toEqual(task);
    expect(harness.claim()).toEqual(claim);
    expect(boundary.nudge).not.toHaveBeenCalled();
    expect(boundary.start).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.task()).toEqual(task);
    expect(harness.claim()).toEqual(claim);
    expect(boundary.nudge).not.toHaveBeenCalled();
    expect(boundary.start).not.toHaveBeenCalled();
  });

  it('returns after committing revocation even when attention sync stalls', async () => {
    harness.d1.exec("UPDATE tasks SET agent_configuration_id='changed-after-consent'");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sync = projectData.syncProviderLimitAttention;
    const attention = vi
      .spyOn(projectData, 'syncProviderLimitAttention')
      .mockImplementation(async (...args) => {
        await gate;
        return sync(...args);
      });
    const claim = harness.claim();
    vi.useFakeTimers();
    let returned = false;
    const sweep = recoverStuckTasks(harness.env).then(() => {
      returned = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(attention).toHaveBeenCalledOnce();
    expect(harness.task().admission_state).toBe('provider_limit_blocked');
    const blocked = harness.task();
    await vi.advanceTimersByTimeAsync(10);
    expect(returned).toBe(true);
    await sweep;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.task()).toEqual(blocked);
    expect(harness.claim()).toEqual(claim);
    expect(boundary.nudge).not.toHaveBeenCalled();
    expect(boundary.start).not.toHaveBeenCalled();
  });
});
