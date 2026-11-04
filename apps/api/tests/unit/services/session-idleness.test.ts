import { describe, expect, it } from 'vitest';

import { classifySessionIdleness } from '../../../src/services/session-idleness';

const harnessWorkConfig = { leaseMs: 120_000, maxDurationMs: 30 * 60 * 1000 };
const NOW = new Date('2026-08-21T12:00:00.000Z');
const IDLE_AFTER_MS = 15 * 60 * 1000;
const OLD_IDLE_ACTIVITY_AT = NOW.getTime() - 20 * 60 * 1000;

type ClassifyInput = Parameters<typeof classifySessionIdleness>[0];

function idleState(overrides: NonNullable<ClassifyInput['state']> = {}) {
  return {
    activity: 'idle',
    activityAt: OLD_IDLE_ACTIVITY_AT,
    ...overrides,
  };
}

function classify(overrides: Partial<ClassifyInput> = {}) {
  return classifySessionIdleness({
    taskStatus: 'in_progress',
    state: idleState(),
    now: NOW,
    idleAfterMs: IDLE_AFTER_MS,
    harnessWorkConfig,
    policy: 'idle-interval-elapsed',
    ...overrides,
  });
}

describe('classifySessionIdleness', () => {
  it.each(['prompt-turn-ended', 'idle-interval-elapsed'] as const)(
    'protects the final response of an old prompt after recent completion under %s',
    (policy) => {
      const input = {
        policy,
        taskStatus: 'completed',
        taskCompletedAt: new Date(NOW.getTime() - 1_000).toISOString(),
        state: idleState({ activity: 'prompting', activityAt: OLD_IDLE_ACTIVITY_AT }),
      };
      expect(classify(input)).toMatchObject({
        idle: false,
        conclusive: true,
        reason: 'prompt_turn_active',
        retryAt: new Date(NOW.getTime() - 1_000 + IDLE_AFTER_MS),
      });
      expect(classify({ ...input, now: new Date(NOW.getTime() + IDLE_AFTER_MS) })).toMatchObject({
        idle: true,
        reason: 'completed_prompt_stale',
      });
      // The confirmed end of a prompt releases the safety gate immediately.
      expect(classify({ ...input, policy: 'prompt-turn-ended', state: idleState() })).toMatchObject(
        { idle: true }
      );
    }
  );

  it('keeps a session non-idle while normalized runtime work has a fresh finite lease', () => {
    expect(
      classify({
        state: idleState({
          runtimeWorkState: 'active',
          runtimeWorkUpdatedAt: NOW.getTime() - 10_000,
          runtimeWorkProgressAt: NOW.getTime() - 20_000,
        }),
      })
    ).toMatchObject({
      idle: false,
      conclusive: true,
      reason: 'runtime_work_lease_active',
      retryAt: new Date('2026-08-21T12:01:50.000Z'),
    });
  });

  it('lets stale detached runtime work release after the absolute progress ceiling', () => {
    expect(
      classify({
        state: idleState({
          runtimeWorkState: 'active',
          runtimeWorkUpdatedAt: NOW.getTime() - 10_000,
          runtimeWorkProgressAt: NOW.getTime() - 31 * 60 * 1000,
        }),
      })
    ).toMatchObject({
      idle: true,
      conclusive: true,
      reason: 'idle',
    });
  });

  it('treats an unknown session state as inconclusive rather than idle', () => {
    expect(classify({ state: null })).toMatchObject({
      idle: false,
      conclusive: false,
      reason: 'prompt_turn_unknown',
      activity: null,
    });
  });

  it('blocks sleep while the prompt turn is still running', () => {
    expect(
      classify({ state: idleState({ activity: 'prompting', activityAt: NOW.getTime() - 1_000 }) })
    ).toMatchObject({
      idle: false,
      conclusive: true,
      reason: 'prompt_turn_active',
    });
  });

  it('defers an idle session until the configured idle interval has elapsed', () => {
    expect(classify({ state: idleState({ activityAt: NOW.getTime() - 60_000 }) })).toMatchObject({
      idle: false,
      conclusive: true,
      reason: 'idle_interval_pending',
      retryAt: new Date('2026-08-21T12:14:00.000Z'),
    });
  });

  it('defers automatic sleep, without a retry hint, when the idle age is unknown', () => {
    expect(classify({ state: { activity: 'idle', activityAt: null } })).toMatchObject({
      idle: false,
      conclusive: true,
      reason: 'idle_interval_pending',
      activity: 'idle',
      retryAt: undefined,
    });
  });

  // The idle interval is an automatic-sleep SCHEDULING policy, not a safety
  // property. Teardown gates and the user-initiated `POST /workspaces/:id/sleep`
  // path ask only whether the prompt turn ended, so they must not be blocked for
  // up to SESSION_SLEEP_AFTER_MS after the agent hands control back.
  describe('policy: prompt-turn-ended', () => {
    it('is idle as soon as the prompt turn ends, ignoring the idle interval', () => {
      expect(
        classify({
          policy: 'prompt-turn-ended',
          state: idleState({ activityAt: NOW.getTime() - 1_000 }),
        })
      ).toMatchObject({ idle: true, conclusive: true, reason: 'idle' });
    });

    it('is idle even when the idle age is unknown', () => {
      expect(
        classify({ policy: 'prompt-turn-ended', state: { activity: 'idle', activityAt: null } })
      ).toMatchObject({ idle: true, conclusive: true, reason: 'idle' });
    });

    it('still blocks on a live prompt turn', () => {
      expect(
        classify({
          policy: 'prompt-turn-ended',
          state: idleState({ activity: 'prompting', activityAt: NOW.getTime() - 1_000 }),
        })
      ).toMatchObject({ idle: false, conclusive: true, reason: 'prompt_turn_active' });
    });

    it('still blocks on a fresh runtime-work lease', () => {
      expect(
        classify({
          policy: 'prompt-turn-ended',
          state: idleState({
            runtimeWorkState: 'active',
            runtimeWorkUpdatedAt: NOW.getTime() - 10_000,
            runtimeWorkProgressAt: NOW.getTime() - 20_000,
          }),
        })
      ).toMatchObject({ idle: false, conclusive: true, reason: 'runtime_work_lease_active' });
    });

    it('still refuses to guess when the session state is missing entirely', () => {
      expect(classify({ policy: 'prompt-turn-ended', state: null })).toMatchObject({
        idle: false,
        conclusive: false,
        reason: 'prompt_turn_unknown',
      });
    });
  });

  it('sleeps an orchestrator whose prompt turn ended while its children are still running', () => {
    // Raphaël, 2026-08-24: a parent blocked on `wait_for_subtasks` must sleep and
    // be woken durably by the ProjectData parent-wake delivery path, not be kept
    // awake because it has children. Nothing about child lineage is an input to
    // this predicate — this test pins that.
    expect(classify({ taskStatus: 'awaiting_followup' })).toMatchObject({
      idle: true,
      conclusive: true,
      reason: 'idle',
    });
  });

  it('preserves a completed task with a recent final prompting state', () => {
    expect(
      classify({
        taskStatus: 'completed',
        state: {
          activity: 'prompting',
          activityAt: NOW.getTime() - 30_000,
        },
      })
    ).toMatchObject({
      idle: false,
      conclusive: true,
      reason: 'prompt_turn_active',
      retryAt: new Date('2026-08-21T12:14:30.000Z'),
    });
  });

  it('releases a completed task whose final prompting state is stale', () => {
    expect(
      classify({
        taskStatus: 'completed',
        state: { activity: 'prompting', activityAt: OLD_IDLE_ACTIVITY_AT },
      })
    ).toMatchObject({
      idle: true,
      conclusive: true,
      reason: 'completed_prompt_stale',
    });
  });

  describe('the completed-task drain follows the work clock, not re-reports', () => {
    const completedAt = new Date(NOW.getTime() - 20 * 60 * 1000).toISOString();

    it('releases a completed task whose hung turn keeps re-reporting (production 2026-11-03)', () => {
      // `activityAt` is 30 s old because the VM re-reports every minute; no work since
      // the turn started 25 min ago.
      expect(
        classify({
          taskStatus: 'completed',
          taskCompletedAt: completedAt,
          state: {
            activity: 'prompting',
            activityAt: NOW.getTime() - 30_000,
            promptStartedAt: NOW.getTime() - 25 * 60 * 1000,
            workAt: NOW.getTime() - 25 * 60 * 1000,
          },
        })
      ).toMatchObject({ idle: true, conclusive: true, reason: 'completed_prompt_stale' });
    });

    it('keeps draining while the agent still persists work after complete_task (control)', () => {
      expect(
        classify({
          taskStatus: 'completed',
          taskCompletedAt: completedAt,
          state: {
            activity: 'prompting',
            activityAt: NOW.getTime() - 30_000,
            promptStartedAt: NOW.getTime() - 25 * 60 * 1000,
            workAt: NOW.getTime() - 2 * 60 * 1000,
          },
        })
      ).toMatchObject({
        idle: false,
        reason: 'prompt_turn_active',
        retryAt: new Date(NOW.getTime() - 2 * 60 * 1000 + IDLE_AFTER_MS),
      });
    });

    it('keeps draining while harness work progresses (control)', () => {
      expect(
        classify({
          taskStatus: 'completed',
          taskCompletedAt: completedAt,
          state: {
            activity: 'prompting',
            activityAt: NOW.getTime() - 30_000,
            workAt: NOW.getTime() - 25 * 60 * 1000,
            runtimeWorkState: 'inactive',
            runtimeWorkProgressAt: NOW.getTime() - 60_000,
          },
        })
      ).toMatchObject({ idle: false, reason: 'prompt_turn_active' });
    });

    it('falls back to the turn start for rows written before the work clock existed', () => {
      expect(
        classify({
          taskStatus: 'completed',
          taskCompletedAt: completedAt,
          state: {
            activity: 'prompting',
            activityAt: NOW.getTime() - 30_000,
            promptStartedAt: NOW.getTime() - 25 * 60 * 1000,
            workAt: null,
          },
        })
      ).toMatchObject({ idle: true, reason: 'completed_prompt_stale' });
    });
  });

  it('sleeps a completed task immediately once it reports idle', () => {
    expect(
      classify({
        taskStatus: 'completed',
        state: { activity: 'idle', activityAt: NOW.getTime() - 1_000 },
      })
    ).toMatchObject({
      idle: true,
      conclusive: true,
      reason: 'idle',
    });
  });

  describe('failed tasks are kept by sleep, like completed ones', () => {
    it('sleeps a failed task immediately once its prompt turn has ended', () => {
      // The sleep is the failed task's work-preservation snapshot
      // (failed-task-preservation.ts); it must not wait out the idle interval.
      expect(
        classify({
          taskStatus: 'failed',
          state: { activity: 'idle', activityAt: NOW.getTime() - 1_000 },
        })
      ).toMatchObject({ idle: true, conclusive: true, reason: 'idle' });
    });

    it.each(['completed', 'failed'] as const)(
      'keeps a %s task draining while its agent still reports a turn',
      (taskStatus) => {
        // The drain follows activity for BOTH statuses: a failed agent still working
        // after the failure must not be slept mid-turn, because
        // `sleepWorkspaceSession` aborts on every activity change and would spend the
        // failed task's retry budget. A HUNG failed prompt is bounded elsewhere (the
        // check-in watchdog and the preservation maximum wait).
        const working = { activity: 'prompting', activityAt: NOW.getTime() - 60_000 };
        const longAgo = new Date(NOW.getTime() - IDLE_AFTER_MS - 1).toISOString();

        expect(classify({ taskStatus, taskCompletedAt: longAgo, state: working })).toMatchObject({
          idle: false,
          conclusive: true,
          reason: 'prompt_turn_active',
          retryAt: new Date(NOW.getTime() - 60_000 + IDLE_AFTER_MS),
        });
        expect(
          classify({
            taskStatus,
            taskCompletedAt: longAgo,
            state: { activity: 'prompting', activityAt: OLD_IDLE_ACTIVITY_AT },
          })
        ).toMatchObject({ idle: true, conclusive: true, reason: 'completed_prompt_stale' });
      }
    );

    it('does not widen to cancelled tasks, whose runtime is torn down directly', () => {
      // Control (rule 67): cancelled is not sleep-preserved. An idle one still
      // waits out the automatic interval; a prompting one is never released.
      expect(
        classify({
          taskStatus: 'cancelled',
          state: { activity: 'idle', activityAt: NOW.getTime() - 1_000 },
        })
      ).toMatchObject({ idle: false, reason: 'idle_interval_pending' });
      expect(
        classify({
          taskStatus: 'cancelled',
          taskCompletedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
          state: { activity: 'prompting', activityAt: OLD_IDLE_ACTIVITY_AT },
        })
      ).toMatchObject({ idle: false, reason: 'prompt_turn_active' });
    });
  });
  // Production 2026-11-04 (idea 01M6K6QTEE7T9KNYB7317D7Y8E): a conversation's turn hung for
  // 9h54m. The VM kept re-reporting `prompting`, so only the work clock can tell it is stale.
  describe('a hung turn on a running task is bounded by the work clock', () => {
    const STALE_TURN_MS = 30 * 60 * 1000;
    const hung = (workAgoMs: number, extra: NonNullable<ClassifyInput['state']> = {}) =>
      idleState({
        activity: 'prompting',
        // A same-turn re-report a minute ago: last-report clocks are fresh.
        activityAt: NOW.getTime() - 60_000,
        promptStartedAt: NOW.getTime() - 10 * 60 * 60 * 1000,
        workAt: NOW.getTime() - workAgoMs,
        ...extra,
      });

    it.each(['prompt-turn-ended', 'idle-interval-elapsed'] as const)(
      'releases a turn with no work for longer than the bound under %s',
      (policy) => {
        expect(
          classify({ policy, staleTurnMs: STALE_TURN_MS, state: hung(STALE_TURN_MS + 1_000) })
        ).toMatchObject({ idle: true, conclusive: true, reason: 'prompt_turn_stale' });
      }
    );

    it('keeps a turn that did real work inside the bound (control)', () => {
      expect(
        classify({ staleTurnMs: STALE_TURN_MS, state: hung(STALE_TURN_MS - 60_000) })
      ).toMatchObject({ idle: false, reason: 'prompt_turn_active' });
    });

    it('keeps a silent turn whose harness work still holds a fresh lease (control)', () => {
      const state = hung(STALE_TURN_MS * 2, {
        runtimeWorkState: 'active',
        runtimeWorkCount: 1,
        runtimeWorkUpdatedAt: NOW.getTime() - 30_000,
        runtimeWorkProgressAt: NOW.getTime() - 60_000,
      });
      expect(classify({ staleTurnMs: STALE_TURN_MS, state })).toMatchObject({
        idle: false,
        reason: 'runtime_work_lease_active',
      });
    });

    it('waits out the longer idle interval under the scheduling policy', () => {
      const short = 5 * 60 * 1000;
      const state = hung(short + 60_000);
      expect(classify({ policy: 'prompt-turn-ended', staleTurnMs: short, state })).toMatchObject({
        idle: true,
      });
      expect(classify({ policy: 'idle-interval-elapsed', staleTurnMs: short, state })).toMatchObject(
        { idle: false, reason: 'prompt_turn_active' }
      );
    });

    it.each([undefined, null, 0])('stays unbounded when the bound is %s', (staleTurnMs) => {
      expect(classify({ staleTurnMs, state: hung(STALE_TURN_MS * 20) })).toMatchObject({
        idle: false,
        reason: 'prompt_turn_active',
      });
    });

    it('refuses to guess when the state carries no work evidence at all', () => {
      const state = { activity: 'prompting' };
      expect(classify({ staleTurnMs: STALE_TURN_MS, state })).toMatchObject({
        idle: false,
        reason: 'prompt_turn_active',
      });
    });
  });
});
