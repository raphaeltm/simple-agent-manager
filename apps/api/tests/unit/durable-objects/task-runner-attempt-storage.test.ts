import { afterEach, describe, expect, it, vi } from 'vitest';

import { taskRunnerAttemptContext } from '../../../src/durable-objects/task-runner/attempt-storage';
import type { TaskRunnerState } from '../../../src/durable-objects/task-runner/types';
import { SessionRecoveryAuthorityRevokedError } from '../../../src/services/session-recovery-authority';

afterEach(() => {
  vi.restoreAllMocks();
});

function fixture(attemptId: string | null) {
  let state = {
    taskId: 'task-1',
    projectId: 'project-1',
    config: { recoveryAttemptId: attemptId, resumeSnapshotChatSessionId: 'chat-1' },
    completed: false,
  } as TaskRunnerState;
  const setAlarm = vi.fn();
  const transaction = {
    get: async () => structuredClone(state),
    put: async (_key: string, value: TaskRunnerState) => {
      state = structuredClone(value);
    },
    setAlarm,
  };
  const ctx = {
    storage: {
      transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(transaction),
    },
  } as unknown as DurableObjectState;
  const claimRow = {
    recovery_task_id: 'task-1',
    recovery_attempt_id: 'wake-new',
    recovery_status: 'waking',
    capture_generation: 'gen-3',
    sleep_status: 'sleeping',
  };
  const prepare = vi.fn((_query: string) => ({
    bind: () => ({ first: async () => claimRow }),
  }));
  const database = { prepare } as unknown as D1Database;
  return {
    ctx,
    database,
    prepare,
    read: () => state,
    replace: (value: TaskRunnerState) => {
      state = value;
    },
    setAlarm,
  };
}

function authorityRevokedLogs(warn: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return warn.mock.calls
    .map(([line]: unknown[]) => JSON.parse(String(line)) as Record<string, unknown>)
    .filter((entry: Record<string, unknown>) => entry.event === 'session_recovery.authority_revoked');
}

describe('TaskRunner attempt storage', () => {
  it.each([null, 'wake-old'])(
    'rejects late state/alarm writes from attempt %s after reactivation',
    async (oldAttempt) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const f = fixture(oldAttempt);
      const oldState = structuredClone(f.read());
      const ctx = taskRunnerAttemptContext(f.ctx, oldState, f.database);
      f.replace({ ...f.read(), config: { ...f.read().config, recoveryAttemptId: 'wake-new' } });
      oldState.completed = true;
      const putRefusal = await ctx.storage.put('state', oldState).catch((error: unknown) => error);
      const alarmRefusal = await ctx.storage
        .setAlarm(Date.now())
        .catch((error: unknown) => error);
      for (const refusal of [putRefusal, alarmRefusal]) {
        expect(refusal).toBeInstanceOf(SessionRecoveryAuthorityRevokedError);
        expect(refusal).toMatchObject({
          message: 'Session recovery authority was revoked',
          check: 'runner_attempt_superseded',
        });
      }
      expect(f.read()).toMatchObject({
        completed: false,
        config: { recoveryAttemptId: 'wake-new' },
      });
      expect(f.setAlarm).not.toHaveBeenCalled();
      // Each refusal is logged once, with the attempt that superseded it and the claim row.
      expect(authorityRevokedLogs(warn)).toEqual([
        expect.objectContaining({
          check: 'runner_attempt_superseded',
          site: 'task_runner.put_state',
          taskId: 'task-1',
          recoveryAttemptId: oldAttempt,
          persistedRecoveryAttemptId: 'wake-new',
          snapshotFound: true,
          snapshotRecoveryTaskId: 'task-1',
          snapshotRecoveryAttemptId: 'wake-new',
          snapshotRecoveryStatus: 'waking',
          snapshotCaptureGeneration: 'gen-3',
          snapshotSleepStatus: 'sleeping',
        }),
        expect.objectContaining({
          check: 'runner_attempt_superseded',
          site: 'task_runner.set_alarm',
          persistedRecoveryAttemptId: 'wake-new',
        }),
      ]);
    }
  );

  it('persists progress and alarms for the same wake without a diagnostic read', async () => {
    const f = fixture('wake-current');
    const state = structuredClone(f.read());
    const ctx = taskRunnerAttemptContext(f.ctx, state, f.database);
    state.completed = true;
    await ctx.storage.put('state', state);
    await ctx.storage.setAlarm(42);
    expect(f.read().completed).toBe(true);
    expect(f.setAlarm).toHaveBeenCalledWith(42);
    expect(f.prepare).not.toHaveBeenCalled();
  });
});
