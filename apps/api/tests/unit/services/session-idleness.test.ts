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
});
