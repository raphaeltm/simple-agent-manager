/**
 * The real `ProjectData.alarm()` in the workerd runtime: which sections a tick runs, and the
 * per-section completion log that attributes the object's maintenance cost (idea
 * `01M27M86R544BQX86VZANZGSQ2`). Scheduler edge cases live in the unit suite; these prove the
 * production handler is wired to it.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  computeProjectDataAlarmSectionTimes,
  PROJECT_DATA_ALARM_FAILED_SECTION_RETRY_MS,
  PROJECT_DATA_ALARM_SECTIONS,
} from '../../src/durable-objects/project-data/alarm-schedule';
import { PROJECT_DATA_ALARM_SCHEDULE_META_KEY } from '../../src/durable-objects/project-data/alarm-sections';
import type { Env } from '../../src/durable-objects/project-data/types';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

type Completion = {
  mode: 'full' | 'gated';
  fullRunReason: string | null;
  projectId: string | null;
  ranSections: string[];
  skippedSections: string[];
  failedSections: string[];
  sections: Array<{ section: string; status: string; rowsRead: number }>;
};

function completions(spy: ReturnType<typeof vi.spyOn>, projectId: string): Completion[] {
  return spy.mock.calls
    .map((call) => {
      try {
        return JSON.parse(String(call[0])) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(
      (entry): entry is Record<string, unknown> =>
        entry?.event === 'project_data.alarm.completed' && entry.projectId === projectId
    ) as unknown as Completion[];
}

function stubFor(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectDataTestDouble>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Stores the project id with no automatic alarm left armed, so the test's own `alarm()` calls are
 * the only ticks, and lets the clock move past the schedule that setup computed. (A section that
 * starts in the same millisecond as its own due time is deliberately kept due for one more run —
 * see `ProjectDataAlarmSectionScheduler.observe` — which an assertion must not trip over.)
 */
async function prepareManualTicks(
  instance: ProjectDataTestDouble,
  state: DurableObjectState,
  projectId: string
): Promise<void> {
  await instance.ensureProjectId(projectId);
  await state.storage.deleteAlarm();
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('ProjectData alarm sections', () => {
  it('runs every section on its first tick, then only the sections that are due', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const projectId = `alarm-sections-${crypto.randomUUID()}`;
    const stub = stubFor(projectId);

    await runInDurableObject(stub, async (instance, state) => {
      await prepareManualTicks(instance, state, projectId);
      await instance.alarm();
      await instance.alarm();
    });

    const ticks = completions(logSpy, projectId);
    const first = ticks[0];
    expect(first).toMatchObject({ mode: 'full', fullRunReason: 'first_tick' });
    expect(first?.ranSections).toEqual([...PROJECT_DATA_ALARM_SECTIONS]);
    // The metered SqlStorage is the object's own: storage safety's reads are attributed to it.
    expect(first?.sections.find((s) => s.section === 'storage_safety')?.rowsRead).toBeGreaterThan(
      0
    );

    // Storage was just measured, so a follow-up tick in the same instance must not repeat it.
    const last = ticks.at(-1);
    expect(ticks).toHaveLength(2);
    expect(last).toMatchObject({ mode: 'gated', fullRunReason: null, failedSections: [] });
    expect(last?.skippedSections).toContain('storage_safety');
    expect(last?.ranSections).not.toContain('storage_safety');
  });

  it('runs every section on every tick when gating is switched off', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const projectId = `alarm-sections-off-${crypto.randomUUID()}`;
    const stub = stubFor(projectId);
    await stub.ensureProjectId(projectId);

    await runInDurableObject(stub, async (instance) => {
      const instanceEnv = (instance as unknown as { env: Record<string, string | undefined> }).env;
      instanceEnv.PROJECT_DATA_ALARM_SECTION_GATING_ENABLED = 'false';
      try {
        await instance.alarm();
        await instance.alarm();
      } finally {
        delete instanceEnv.PROJECT_DATA_ALARM_SECTION_GATING_ENABLED;
      }
    });

    const last = completions(logSpy, projectId).at(-1);
    expect(last).toMatchObject({ mode: 'full', fullRunReason: 'gating_disabled' });
    expect(last?.ranSections).toContain('storage_safety');
  });

  it('runs everything when the schedule cannot be computed at the start of a tick', async () => {
    const logSpy = vi.spyOn(console, 'log');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const projectId = `alarm-sections-unscheduled-${crypto.randomUUID()}`;
    const stub = stubFor(projectId);
    await stub.ensureProjectId(projectId);

    const outcome = await runInDurableObject(stub, async (instance, state) => {
      await instance.alarm();
      // Only the ticks below run while the stored id is broken.
      await state.storage.deleteAlarm();
      // Every section's schedule reads the stored project id first; a value that is not text
      // makes the whole computation throw. (The instance keeps its cached id for the sections.)
      state.storage.sql.exec(`UPDATE do_meta SET value = X'00' WHERE key = 'projectId'`);
      try {
        await instance.alarm();
        return 'resolved';
      } catch {
        // The closing recalculation fails the same way; the platform retries the alarm.
        return 'rejected';
      } finally {
        state.storage.sql.exec(`UPDATE do_meta SET value = ? WHERE key = 'projectId'`, projectId);
      }
    });

    expect(outcome).toBe('rejected');
    const last = completions(logSpy, projectId).at(-1);
    expect(last).toMatchObject({ mode: 'full', fullRunReason: 'schedule_unavailable' });
    expect([...(last?.ranSections ?? []), ...(last?.failedSections ?? [])].sort()).toEqual(
      [...PROJECT_DATA_ALARM_SECTIONS].sort()
    );
  });

  it("isolates one section's broken schedule and run from every other section", async () => {
    const logSpy = vi.spyOn(console, 'log');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const projectId = `alarm-sections-isolated-${crypto.randomUUID()}`;
    const stub = stubFor(projectId);
    await stub.ensureProjectId(projectId);

    const result = await runInDurableObject(stub, async (instance, state) => {
      const instanceEnv = (instance as unknown as { env: Env & Record<string, string | undefined> })
        .env;
      const now = Date.now();
      await state.storage.deleteAlarm();
      const before = computeProjectDataAlarmSectionTimes(state.storage.sql, instanceEnv, now);
      state.storage.sql.exec(
        'ALTER TABLE task_wait_subscriptions RENAME TO task_wait_subscriptions_hidden'
      );
      instanceEnv.PROJECT_DATA_ALARM_SECTION_GATING_ENABLED = 'false';
      try {
        const broken = computeProjectDataAlarmSectionTimes(state.storage.sql, instanceEnv, now);
        await instance.alarm();
        return { before, broken, now };
      } finally {
        delete instanceEnv.PROJECT_DATA_ALARM_SECTION_GATING_ENABLED;
        state.storage.sql.exec(
          'ALTER TABLE task_wait_subscriptions_hidden RENAME TO task_wait_subscriptions'
        );
      }
    });

    // The broken section is retried after the floor; every other schedule is untouched (a few
    // read the live clock rather than `now`, so allow the milliseconds between the two reads).
    expect(result.broken.task_waits).toBe(result.now + PROJECT_DATA_ALARM_FAILED_SECTION_RETRY_MS);
    for (const section of PROJECT_DATA_ALARM_SECTIONS) {
      if (section === 'task_waits') continue;
      const [before, broken] = [result.before[section], result.broken[section]];
      if (before === null) expect(broken).toBeNull();
      else expect(Math.abs((broken ?? Number.NaN) - before)).toBeLessThan(1_000);
    }
    // Its run fails alone: the sections after it still ran in the same tick.
    const last = completions(logSpy, projectId).at(-1);
    expect(last?.failedSections).toEqual(['task_waits']);
    expect(last?.ranSections).toEqual(
      PROJECT_DATA_ALARM_SECTIONS.filter((section) => section !== 'task_waits')
    );
  });

  it('a wait that comes due runs prompt delivery in the same gated tick', async () => {
    const logSpy = vi.spyOn(console, 'log');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const projectId = `alarm-sections-cascade-${crypto.randomUUID()}`;
    const stub = stubFor(projectId);

    const promptDeliveryScheduled = await runInDurableObject(stub, async (instance, state) => {
      await prepareManualTicks(instance, state, projectId);
      await instance.alarm();
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO task_wait_subscriptions
           (id, parent_task_id, parent_session_id, wait_condition, state, child_count,
            wake_deadline, next_reconcile_at, wake_delivery_id, created_at, updated_at)
         VALUES (?, 'parent-task', 'parent-session', 'all', 'active', 1, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        now + 24 * 60 * 60 * 1000,
        now + 50,
        crypto.randomUUID(),
        now,
        now
      );
      // A write recalculates the alarm; the tick below stands in for the alarm it armed.
      await (instance as unknown as { recalculateAlarm(): Promise<void> }).recalculateAlarm();
      await state.storage.deleteAlarm();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const instanceEnv = (instance as unknown as { env: Env }).env;
      const scheduled = computeProjectDataAlarmSectionTimes(
        state.storage.sql,
        instanceEnv
      ).prompt_delivery;
      await instance.alarm();
      return scheduled;
    });

    const waitTick = completions(logSpy, projectId).find(
      (tick) =>
        tick.mode === 'gated' &&
        [...tick.ranSections, ...tick.failedSections].includes('task_waits')
    );
    // Prompt delivery had nothing of its own scheduled; it ran because the wait section did.
    expect(promptDeliveryScheduled).toBeNull();
    expect(waitTick?.ranSections).toContain('prompt_delivery');
    // Liveness of the gate itself: a section with nothing scheduled was skipped in that tick.
    expect(waitTick?.skippedSections).toContain('attention_expiry');
  });

  describe('when the object is evicted between ticks', () => {
    /** Resets the object; the next request constructs a fresh instance from its storage. */
    async function evict(stub: DurableObjectStub<ProjectDataTestDouble>): Promise<void> {
      await runInDurableObject(stub, (_instance, state) => {
        state.abort('test eviction');
      }).catch(() => {});
    }

    async function tickBeforeAndAfterEviction(keepPersistedMemory: boolean) {
      const logSpy = vi.spyOn(console, 'log');
      const projectId = `alarm-sections-evicted-${crypto.randomUUID()}`;
      const stub = stubFor(projectId);
      const persisted = await runInDurableObject(stub, async (instance, state) => {
        await prepareManualTicks(instance, state, projectId);
        await instance.alarm();
        await state.storage.deleteAlarm();
        const row = state.storage.sql
          .exec('SELECT value FROM do_meta WHERE key = ?', PROJECT_DATA_ALARM_SCHEDULE_META_KEY)
          .toArray()[0];
        if (!keepPersistedMemory) {
          state.storage.sql.exec(
            'DELETE FROM do_meta WHERE key = ?',
            PROJECT_DATA_ALARM_SCHEDULE_META_KEY
          );
        }
        return row?.value;
      });
      await evict(stub);
      // An aborted object's stub stays broken; a new one reaches the fresh instance.
      await runInDurableObject(stubFor(projectId), async (instance) => {
        await instance.alarm();
      });
      return { persisted, ticks: completions(logSpy, projectId) };
    }

    it('keeps gating: the fresh instance restores the persisted schedule', async () => {
      const { persisted, ticks } = await tickBeforeAndAfterEviction(true);

      expect(typeof persisted).toBe('string');
      expect(ticks.map((tick) => tick.fullRunReason)).toEqual(['first_tick', null]);
      expect(ticks[1]).toMatchObject({ mode: 'gated' });
      expect(ticks[1]?.skippedSections).toContain('attention_expiry');
    });

    it('runs everything after eviction when nothing was persisted (control)', async () => {
      const { ticks } = await tickBeforeAndAfterEviction(false);

      expect(ticks.map((tick) => tick.fullRunReason)).toEqual(['first_tick', 'first_tick']);
    });
  });
});
