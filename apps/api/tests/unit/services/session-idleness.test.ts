import { describe, expect, it, vi } from 'vitest';

import {
  classifySessionIdleness,
  loadActiveChildTaskIdlenessSignal,
} from '../../../src/services/session-idleness';

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
    childWork: { outcome: 'ok', activeChildTaskCount: 0 },
    now: NOW,
    idleAfterMs: IDLE_AFTER_MS,
    harnessWorkConfig,
    ...overrides,
  });
}

function mockChildTaskDb(firstResult: () => Promise<{ id: string } | null>) {
  const first = vi.fn(firstResult);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  return { bind, db: { prepare } as unknown as D1Database, prepare };
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

  it('blocks idleness while a child task is still active', () => {
    expect(classify({ childWork: { outcome: 'ok', activeChildTaskCount: 1 } })).toMatchObject({
      idle: false,
      conclusive: true,
      reason: 'child_work_active',
    });
  });

  it('blocks idleness while a durable child-work wait is still active', () => {
    expect(
      classify({ childWork: { outcome: 'ok', activeChildTaskCount: 0, activeWaitCount: 1 } })
    ).toMatchObject({
      idle: false,
      conclusive: true,
      reason: 'child_work_active',
    });
  });

  it('treats inconclusive child-task evidence as not idle', () => {
    expect(
      classify({ childWork: { outcome: 'unknown', errorMessage: 'D1 unavailable' } })
    ).toMatchObject({
      idle: false,
      conclusive: false,
      reason: 'child_work_unknown',
    });
  });

  it('handles awaiting_followup as idle only after the prompt turn ended and the interval elapsed', () => {
    expect(classify({ taskExecutionStep: 'awaiting_followup' })).toMatchObject({
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
});

describe('loadActiveChildTaskIdlenessSignal', () => {
  it('detects an active child task without depending on a test harness', async () => {
    const { bind, db, prepare } = mockChildTaskDb(async () => ({ id: 'child-1' }));

    await expect(
      loadActiveChildTaskIdlenessSignal(db, {
        projectId: 'project-1',
        parentTaskId: 'task-1',
      })
    ).resolves.toEqual({ outcome: 'ok', activeChildTaskCount: 1 });

    expect(prepare.mock.calls[0]?.[0]).toContain('parent_task_id');
    expect(bind.mock.calls[0]).toEqual([
      'project-1',
      'task-1',
      'ready',
      'queued',
      'delegated',
      'in_progress',
      'awaiting_followup',
    ]);
  });

  it('returns unknown instead of claiming idle when the child-task query fails', async () => {
    const { db } = mockChildTaskDb(async () => {
      throw new Error('D1 unavailable');
    });

    await expect(
      loadActiveChildTaskIdlenessSignal(db, {
        projectId: 'project-1',
        parentTaskId: 'task-1',
      })
    ).resolves.toMatchObject({ outcome: 'unknown', errorMessage: 'D1 unavailable' });
  });
});
