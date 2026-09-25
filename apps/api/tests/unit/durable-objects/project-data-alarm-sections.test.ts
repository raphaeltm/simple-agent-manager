/**
 * Alarm section gating and per-section measurement (`alarm-sections.ts`).
 *
 * The scheduler's one load-bearing property is that a section runs no later than the alarm would
 * have fired for it before gating existed. Most ProjectData schedule functions clamp overdue work
 * into the future relative to the moment they are computed, so the tests below drive the scheduler
 * the way production does: a recalculation on every RPC, then a tick.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PROJECT_DATA_ALARM_FAILED_SECTION_RETRY_MS,
  PROJECT_DATA_ALARM_SECTIONS,
  type ProjectDataAlarmSection,
  type ProjectDataAlarmSectionTimes,
} from '../../../src/durable-objects/project-data/alarm-schedule';
import {
  createRowMeteredSqlStorage,
  DEFAULT_PROJECT_DATA_ALARM_DUE_TOLERANCE_MS,
  DEFAULT_PROJECT_DATA_ALARM_FULL_RUN_INTERVAL_MS,
  type ProjectDataAlarmGatingConfig,
  ProjectDataAlarmSectionScheduler,
  ProjectDataAlarmTick,
  resolveProjectDataAlarmGatingConfig,
} from '../../../src/durable-objects/project-data/alarm-sections';

const T0 = 1_790_000_000_000;
const CONFIG: ProjectDataAlarmGatingConfig = resolveProjectDataAlarmGatingConfig({});

function times(
  overrides: Partial<ProjectDataAlarmSectionTimes> = {}
): ProjectDataAlarmSectionTimes {
  const all = Object.fromEntries(
    PROJECT_DATA_ALARM_SECTIONS.map((s) => [s, null])
  ) as ProjectDataAlarmSectionTimes;
  return { ...all, ...overrides };
}

/** A scheduler that has already had its first (full-run) tick, as a long-lived isolate has. */
function warmScheduler(now = T0): ProjectDataAlarmSectionScheduler {
  const scheduler = new ProjectDataAlarmSectionScheduler();
  expect(scheduler.planTick(CONFIG, now).mode).toBe('full');
  return scheduler;
}

function dueSections(
  scheduler: ProjectDataAlarmSectionScheduler,
  now: number
): ProjectDataAlarmSection[] {
  const plan = scheduler.planTick(CONFIG, now);
  expect(plan.mode).toBe('gated');
  return PROJECT_DATA_ALARM_SECTIONS.filter((section) => plan.isDue(section));
}

function silentMeter() {
  return { begin: vi.fn(), end: vi.fn(() => ({ rowsRead: 0, rowsWritten: 0 })) };
}

function logged(spy: ReturnType<typeof vi.spyOn>, event: string): Record<string, unknown>[] {
  return spy.mock.calls
    .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
    .filter((entry) => entry.event === event);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveProjectDataAlarmGatingConfig', () => {
  it('defaults to gated with the documented windows', () => {
    expect(resolveProjectDataAlarmGatingConfig({})).toEqual({
      enabled: true,
      fullRunIntervalMs: DEFAULT_PROJECT_DATA_ALARM_FULL_RUN_INTERVAL_MS,
      dueToleranceMs: DEFAULT_PROJECT_DATA_ALARM_DUE_TOLERANCE_MS,
      slowSectionMs: 1_000,
    });
  });

  it('only the literal false disables gating', () => {
    expect(
      resolveProjectDataAlarmGatingConfig({ PROJECT_DATA_ALARM_SECTION_GATING_ENABLED: ' FALSE ' })
        .enabled
    ).toBe(false);
    expect(
      resolveProjectDataAlarmGatingConfig({ PROJECT_DATA_ALARM_SECTION_GATING_ENABLED: 'no' })
        .enabled
    ).toBe(true);
  });
});

describe('ProjectDataAlarmSectionScheduler', () => {
  it('runs every section on the first tick of an instance', () => {
    const scheduler = new ProjectDataAlarmSectionScheduler();
    const plan = scheduler.planTick(CONFIG, T0);
    expect(plan).toMatchObject({ mode: 'full', fullRunReason: 'first_tick' });
    expect(PROJECT_DATA_ALARM_SECTIONS.every((section) => plan.isDue(section))).toBe(true);
  });

  it('runs only the sections whose remembered due time has arrived', () => {
    const scheduler = warmScheduler();
    scheduler.observe(
      times({ mailbox_delivery_sweep: T0 + 1_000, storage_safety: T0 + 600_000 }),
      new Map(),
      T0
    );

    expect(dueSections(scheduler, T0 + 1_000)).toEqual(['mailbox_delivery_sweep']);
    // Liveness control: the same scheduler does run storage safety once its own time arrives.
    expect(dueSections(scheduler, T0 + 600_000)).toContain('storage_safety');
  });

  it('never lets a later recalculation push a clamped section past its remembered time', () => {
    // Heartbeat, reconciliation, probes and prompt delivery all return max(raw, now + minDelay) for
    // overdue work. Recomputed on every RPC, that value keeps moving; the alarm must still fire at
    // the first computed time instead of chasing it forever.
    const scheduler = warmScheduler();
    const minDelay = 180_000;
    scheduler.observe(times({ runtime_heartbeat_timeouts: T0 + minDelay }), new Map(), T0);
    for (let rpc = 1; rpc <= 20; rpc++) {
      const now = T0 + rpc * 10_000;
      scheduler.observe(times({ runtime_heartbeat_timeouts: now + minDelay }), new Map(), now);
    }

    expect(scheduler.nextDueAt()).toBe(T0 + minDelay);
    expect(dueSections(scheduler, T0 + minDelay)).toEqual(['runtime_heartbeat_timeouts']);
  });

  it('pulls a section earlier when fresh work becomes due sooner', () => {
    const scheduler = warmScheduler();
    scheduler.observe(times({ task_waits: T0 + 60_000 }), new Map(), T0);
    scheduler.observe(times({ task_waits: 0 }), new Map(), T0 + 1);

    expect(dueSections(scheduler, T0 + 2)).toEqual(['task_waits']);
  });

  it('replaces the remembered time only for sections that ran', () => {
    const scheduler = warmScheduler();
    scheduler.observe(times({ attention_expiry: T0, task_reconciliation: T0 }), new Map(), T0);
    scheduler.observe(
      times({ attention_expiry: T0 + 600_000, task_reconciliation: T0 + 600_000 }),
      new Map<ProjectDataAlarmSection, number>([['attention_expiry', T0 + 1]]),
      T0 + 1
    );

    expect(dueSections(scheduler, T0 + 2)).toEqual(['task_reconciliation']);
  });

  it('forgets a section once it ran and has nothing further scheduled', () => {
    const scheduler = warmScheduler();
    scheduler.observe(times({ project_event_retention: T0 }), new Map(), T0);
    scheduler.observe(times(), new Map([['project_event_retention', T0]]), T0);

    expect(scheduler.nextDueAt()).toBeNull();
  });

  it('runs everything again once the full-run interval has elapsed', () => {
    const scheduler = warmScheduler();
    const later = T0 + CONFIG.fullRunIntervalMs;
    const plan = scheduler.planTick(CONFIG, later);
    expect(plan).toMatchObject({ mode: 'full', fullRunReason: 'full_run_interval' });
    // Control: just inside the interval the tick is gated.
    expect(scheduler.planTick(CONFIG, later + 1).mode).toBe('gated');
  });

  it('runs everything when gating is disabled or the caller could not refresh the schedule', () => {
    const scheduler = warmScheduler();
    expect(scheduler.planTick({ ...CONFIG, enabled: false }, T0 + 1).fullRunReason).toBe(
      'gating_disabled'
    );
    expect(scheduler.planTick(CONFIG, T0 + 2, 'schedule_unavailable').fullRunReason).toBe(
      'schedule_unavailable'
    );
  });

  it('holds a failed section off for the retry floor even when its due time is in the past', () => {
    const scheduler = warmScheduler();
    scheduler.recordFailure('attention_expiry', T0);
    // The expired marker is still there, so the fresh schedule says "due since epoch".
    scheduler.observe(
      times({ attention_expiry: 5 }),
      new Map<ProjectDataAlarmSection, number>([['attention_expiry', T0]]),
      T0
    );

    expect(scheduler.nextDueAt()).toBe(T0 + PROJECT_DATA_ALARM_FAILED_SECTION_RETRY_MS);
    expect(dueSections(scheduler, T0 + 1_000)).toEqual([]);
    expect(dueSections(scheduler, T0 + PROJECT_DATA_ALARM_FAILED_SECTION_RETRY_MS)).toEqual([
      'attention_expiry',
    ]);
  });

  it('holds a section that keeps failing off by the floor after every failure', () => {
    const scheduler = warmScheduler();
    for (let cycle = 0; cycle < 3; cycle++) {
      const at = T0 + cycle * PROJECT_DATA_ALARM_FAILED_SECTION_RETRY_MS;
      scheduler.recordFailure('attention_expiry', at);
      scheduler.observe(
        times({ attention_expiry: 5 }),
        new Map<ProjectDataAlarmSection, number>([['attention_expiry', at]]),
        at
      );
      expect(scheduler.nextDueAt()).toBe(at + PROJECT_DATA_ALARM_FAILED_SECTION_RETRY_MS);
      expect(dueSections(scheduler, at + 1)).toEqual([]);
    }
  });

  describe('a deadline that arrives while the section is already running', () => {
    const WINDOW = 300_000;

    it('stays due when the run looked before it and the recalculation clamps past it', () => {
      const scheduler = warmScheduler();
      const deadline = T0 + 1_500;
      scheduler.observe(times({ runtime_heartbeat_timeouts: deadline }), new Map(), T0);
      // Within the due tolerance, so the section runs early at T0 and finds nothing stale yet.
      expect(dueSections(scheduler, T0)).toEqual(['runtime_heartbeat_timeouts']);
      const tickEnd = deadline + 1_500;

      // By the time the tick recalculates, the heartbeat is overdue and the schedule clamps it.
      scheduler.observe(
        times({ runtime_heartbeat_timeouts: tickEnd + WINDOW }),
        new Map([['runtime_heartbeat_timeouts', T0]]),
        tickEnd
      );

      expect(scheduler.nextDueAt()).toBe(deadline);
      expect(dueSections(scheduler, tickEnd + 1)).toEqual(['runtime_heartbeat_timeouts']);
    });

    it('yields to the fresh schedule once a run has started after the deadline', () => {
      const scheduler = warmScheduler();
      const deadline = T0 - 10;
      scheduler.observe(times({ runtime_heartbeat_timeouts: deadline }), new Map(), T0 - 20);

      // The run saw the overdue session (e.g. deferred it); re-arming at `now` would hot-loop.
      scheduler.observe(
        times({ runtime_heartbeat_timeouts: T0 + 5 + WINDOW }),
        new Map([['runtime_heartbeat_timeouts', T0]]),
        T0 + 5
      );

      expect(scheduler.nextDueAt()).toBe(T0 + 5 + WINDOW);
    });

    it('takes a later fresh time when the deadline has not arrived yet', () => {
      const scheduler = warmScheduler();
      scheduler.observe(times({ runtime_heartbeat_timeouts: T0 + 1_000 }), new Map(), T0);

      // A heartbeat landed during the tick and legitimately moved the deadline out.
      scheduler.observe(
        times({ runtime_heartbeat_timeouts: T0 + 90_000 }),
        new Map([['runtime_heartbeat_timeouts', T0]]),
        T0 + 100
      );

      expect(scheduler.nextDueAt()).toBe(T0 + 90_000);
    });

    it('forgets it when the section no longer has anything scheduled', () => {
      const scheduler = warmScheduler();
      scheduler.observe(times({ runtime_heartbeat_timeouts: T0 + 1_000 }), new Map(), T0);

      scheduler.observe(times(), new Map([['runtime_heartbeat_timeouts', T0]]), T0 + 2_000);

      expect(scheduler.nextDueAt()).toBeNull();
    });

    it('still holds a failed section off for the retry floor', () => {
      const scheduler = warmScheduler();
      scheduler.observe(times({ runtime_heartbeat_timeouts: T0 + 500 }), new Map(), T0);
      scheduler.recordFailure('runtime_heartbeat_timeouts', T0);

      scheduler.observe(
        times({ runtime_heartbeat_timeouts: T0 + 1_000 + WINDOW }),
        new Map([['runtime_heartbeat_timeouts', T0]]),
        T0 + 1_000
      );

      expect(scheduler.nextDueAt()).toBe(T0 + PROJECT_DATA_ALARM_FAILED_SECTION_RETRY_MS);
    });
  });

  it('cascades a wait or wake into prompt delivery within the same tick', () => {
    const scheduler = warmScheduler();
    scheduler.observe(times({ task_waits: T0 }), new Map(), T0);
    const plan = scheduler.planTick(CONFIG, T0 + 1);
    expect(plan.isDue('prompt_delivery')).toBe(false);

    plan.cascadeFrom('task_waits');

    expect(plan.isDue('prompt_delivery')).toBe(true);
  });
});

describe('ProjectDataAlarmSectionScheduler persistence', () => {
  it('carries gating, due times and failure floors to a fresh instance', () => {
    const scheduler = warmScheduler();
    scheduler.observe(
      times({ task_waits: T0 + 5_000, storage_safety: T0 + 600_000 }),
      new Map(),
      T0
    );
    scheduler.recordFailure('attention_expiry', T0);

    const restored = ProjectDataAlarmSectionScheduler.restore(scheduler.serialize());

    // Not a first tick: the previous instance's full run is remembered.
    expect(dueSections(restored, T0 + 5_000)).toEqual(['task_waits']);
    expect(restored.nextDueAt()).toBe(T0 + 5_000);
    restored.observe(
      times({ attention_expiry: 5 }),
      new Map<ProjectDataAlarmSection, number>([['attention_expiry', T0 + 1]]),
      T0 + 1
    );
    expect(dueSections(restored, T0 + 2)).not.toContain('attention_expiry');
  });

  it('runs everything when there is no persisted memory or it cannot be read', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const persisted of [null, '', 'not json', '{"v":99}', '[1,2]']) {
      const plan = ProjectDataAlarmSectionScheduler.restore(persisted).planTick(CONFIG, T0);
      expect(plan).toMatchObject({ mode: 'full', fullRunReason: 'first_tick' });
    }
  });

  it('ignores entries it does not recognise instead of trusting them', () => {
    const restored = ProjectDataAlarmSectionScheduler.restore(
      JSON.stringify({
        v: 1,
        pending: { task_waits: T0, not_a_section: T0, storage_safety: 'soon' },
        failedUntil: {},
        lastFullRunAt: T0,
      })
    );

    expect(dueSections(restored, T0 + 1)).toEqual(['task_waits']);
  });
});

describe('ProjectDataAlarmTick', () => {
  it('isolates a throwing section and reports failed, skipped, and ran separately', async () => {
    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scheduler = warmScheduler();
    scheduler.observe(
      times({ runtime_heartbeat_timeouts: T0, attention_expiry: T0, prompt_delivery: T0 }),
      new Map(),
      T0
    );
    const tick = new ProjectDataAlarmTick(
      scheduler.planTick(CONFIG, T0 + 1),
      CONFIG,
      silentMeter(),
      scheduler
    );
    const order: string[] = [];
    const onError = vi.fn();

    await tick.run('runtime_heartbeat_timeouts', () => {
      order.push('heartbeat');
    });
    await tick.run(
      'attention_expiry',
      () => {
        order.push('attention');
        throw new Error('marker table locked');
      },
      onError
    );
    await tick.run('storage_safety', () => {
      order.push('storage');
    });
    await tick.run('prompt_delivery', () => {
      order.push('delivery');
    });
    tick.complete('project-1');

    expect(order).toEqual(['heartbeat', 'attention', 'delivery']);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'marker table locked' })
    );
    expect([...tick.consumedSections().keys()]).toEqual([
      'runtime_heartbeat_timeouts',
      'attention_expiry',
      'prompt_delivery',
    ]);
    const [completed] = logged(infoSpy, 'project_data.alarm.completed');
    expect(completed).toMatchObject({
      projectId: 'project-1',
      mode: 'gated',
      ranSections: ['runtime_heartbeat_timeouts', 'prompt_delivery'],
      failedSections: ['attention_expiry'],
    });
    expect(completed?.skippedSections).toContain('storage_safety');
    expect(logged(errorSpy, 'project_data.alarm.attention_expiry_failed')).toHaveLength(1);
  });

  it('keeps running when the failure handler itself throws', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const scheduler = new ProjectDataAlarmSectionScheduler();
    const tick = new ProjectDataAlarmTick(
      scheduler.planTick(CONFIG, T0),
      CONFIG,
      silentMeter(),
      scheduler
    );
    const later = vi.fn();

    await tick.run(
      'project_event_retention',
      () => {
        throw new Error('retention failed');
      },
      () => {
        throw new Error('checkpoint failed too');
      }
    );
    await tick.run('prompt_delivery', later);

    expect(later).toHaveBeenCalledTimes(1);
  });

  it('warns once per section at or above the slow-section threshold', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(T0);
    const scheduler = new ProjectDataAlarmSectionScheduler();
    const tick = new ProjectDataAlarmTick(
      scheduler.planTick(CONFIG, T0),
      CONFIG,
      silentMeter(),
      scheduler
    );

    await tick.run('storage_safety', () => {
      clock.mockReturnValue(T0 + 1_500);
    });
    await tick.run('mailbox_delivery_sweep', () => {});
    tick.complete('project-1');

    const slow = logged(warnSpy, 'project_data.alarm.section_slow');
    expect(slow).toHaveLength(1);
    expect(slow[0]).toMatchObject({ section: 'storage_safety', durationMs: 1_500 });
  });
});

describe('createRowMeteredSqlStorage', () => {
  function fakeSql(rowsRead: number, rowsWritten: number) {
    return {
      exec: vi.fn(() => ({ rowsRead, rowsWritten, toArray: () => [] })),
      databaseSize: 4096,
    } as unknown as SqlStorage;
  }

  it('counts rows only for cursors opened while a meter is active', () => {
    const { sql, meter } = createRowMeteredSqlStorage(fakeSql(7, 2));
    sql.exec('SELECT 1');
    meter.begin();
    sql.exec('SELECT 2');
    sql.exec('UPDATE t SET x = 1');
    const counted = meter.end();
    sql.exec('SELECT 3');

    expect(counted).toEqual({ rowsRead: 14, rowsWritten: 4 });
    expect(meter.end()).toEqual({ rowsRead: 0, rowsWritten: 0 });
    expect(sql.databaseSize).toBe(4096);
  });
});
