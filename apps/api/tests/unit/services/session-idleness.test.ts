import { describe, expect, it, vi } from 'vitest';

import {
  classifySessionIdleness,
  loadActiveChildTaskIdlenessSignal,
} from '../../../src/services/session-idleness';

const harnessWorkConfig = { leaseMs: 120_000, maxDurationMs: 30 * 60 * 1000 };

describe('classifySessionIdleness', () => {
  it('keeps a session non-idle while normalized runtime work has a fresh finite lease', () => {
    const now = new Date('2026-08-21T12:00:00.000Z');

    expect(
      classifySessionIdleness({
        taskStatus: 'in_progress',
        state: {
          activity: 'idle',
          activityAt: now.getTime() - 20 * 60 * 1000,
          runtimeWorkState: 'active',
          runtimeWorkUpdatedAt: now.getTime() - 10_000,
          runtimeWorkProgressAt: now.getTime() - 20_000,
        },
        childWork: { outcome: 'ok', activeChildTaskCount: 0 },
        now,
        idleAfterMs: 15 * 60 * 1000,
        harnessWorkConfig,
      })
    ).toMatchObject({
      idle: false,
      conclusive: true,
      reason: 'runtime_work_lease_active',
      retryAt: new Date('2026-08-21T12:01:50.000Z'),
    });
  });

  it('lets stale detached runtime work release after the absolute progress ceiling', () => {
    const now = new Date('2026-08-21T12:00:00.000Z');

    expect(
      classifySessionIdleness({
        taskStatus: 'in_progress',
        state: {
          activity: 'idle',
          activityAt: now.getTime() - 20 * 60 * 1000,
          runtimeWorkState: 'active',
          runtimeWorkUpdatedAt: now.getTime() - 10_000,
          runtimeWorkProgressAt: now.getTime() - 31 * 60 * 1000,
        },
        childWork: { outcome: 'ok', activeChildTaskCount: 0 },
        now,
        idleAfterMs: 15 * 60 * 1000,
        harnessWorkConfig,
      })
    ).toMatchObject({
      idle: true,
      conclusive: true,
      reason: 'idle',
    });
  });

  it('blocks idleness while a child task is still active', () => {
    const now = new Date('2026-08-21T12:00:00.000Z');

    expect(
      classifySessionIdleness({
        taskStatus: 'in_progress',
        state: {
          activity: 'idle',
          activityAt: now.getTime() - 20 * 60 * 1000,
        },
        childWork: { outcome: 'ok', activeChildTaskCount: 1 },
        now,
        idleAfterMs: 15 * 60 * 1000,
        harnessWorkConfig,
      })
    ).toMatchObject({
      idle: false,
      conclusive: true,
      reason: 'child_work_active',
    });
  });

  it('treats inconclusive child-task evidence as not idle', () => {
    const now = new Date('2026-08-21T12:00:00.000Z');

    expect(
      classifySessionIdleness({
        taskStatus: 'in_progress',
        state: {
          activity: 'idle',
          activityAt: now.getTime() - 20 * 60 * 1000,
        },
        childWork: { outcome: 'unknown', errorMessage: 'D1 unavailable' },
        now,
        idleAfterMs: 15 * 60 * 1000,
        harnessWorkConfig,
      })
    ).toMatchObject({
      idle: false,
      conclusive: false,
      reason: 'child_work_unknown',
    });
  });

  it('handles awaiting_followup as idle only after the prompt turn ended and the interval elapsed', () => {
    const now = new Date('2026-08-21T12:00:00.000Z');

    expect(
      classifySessionIdleness({
        taskStatus: 'in_progress',
        taskExecutionStep: 'awaiting_followup',
        state: {
          activity: 'idle',
          activityAt: now.getTime() - 20 * 60 * 1000,
        },
        childWork: { outcome: 'ok', activeChildTaskCount: 0 },
        now,
        idleAfterMs: 15 * 60 * 1000,
        harnessWorkConfig,
      })
    ).toMatchObject({
      idle: true,
      conclusive: true,
      reason: 'idle',
    });
  });

  it('preserves a completed task with a recent final prompting state', () => {
    const now = new Date('2026-08-21T12:00:00.000Z');

    expect(
      classifySessionIdleness({
        taskStatus: 'completed',
        state: {
          activity: 'prompting',
          activityAt: now.getTime() - 30_000,
        },
        childWork: { outcome: 'ok', activeChildTaskCount: 0 },
        now,
        idleAfterMs: 15 * 60 * 1000,
        harnessWorkConfig,
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
    const first = vi.fn(async () => ({ id: 'child-1' }));
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));

    await expect(
      loadActiveChildTaskIdlenessSignal({ prepare } as unknown as D1Database, {
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
    const first = vi.fn(async () => {
      throw new Error('D1 unavailable');
    });
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));

    await expect(
      loadActiveChildTaskIdlenessSignal({ prepare } as unknown as D1Database, {
        projectId: 'project-1',
        parentTaskId: 'task-1',
      })
    ).resolves.toMatchObject({ outcome: 'unknown', errorMessage: 'D1 unavailable' });
  });
});
