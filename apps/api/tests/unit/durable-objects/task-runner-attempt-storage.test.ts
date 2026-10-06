import { describe, expect, it, vi } from 'vitest';

import { taskRunnerAttemptContext } from '../../../src/durable-objects/task-runner/attempt-storage';
import type { TaskRunnerState } from '../../../src/durable-objects/task-runner/types';

function fixture(attemptId: string | null) {
  let state = { config: { recoveryAttemptId: attemptId }, completed: false } as TaskRunnerState;
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
      transaction: async (callback: (tx: unknown) => Promise<void>) => callback(transaction),
    },
  } as unknown as DurableObjectState;
  return {
    ctx,
    read: () => state,
    replace: (value: TaskRunnerState) => {
      state = value;
    },
    setAlarm,
  };
}

describe('TaskRunner attempt storage', () => {
  it.each([null, 'wake-old'])(
    'rejects late state/alarm writes from attempt %s after reactivation',
    async (oldAttempt) => {
      const f = fixture(oldAttempt);
      const oldState = structuredClone(f.read());
      const ctx = taskRunnerAttemptContext(f.ctx, oldState);
      f.replace({ ...f.read(), config: { ...f.read().config, recoveryAttemptId: 'wake-new' } });
      oldState.completed = true;
      await expect(ctx.storage.put('state', oldState)).rejects.toThrow(
        'Session recovery authority was revoked'
      );
      await expect(ctx.storage.setAlarm(Date.now())).rejects.toThrow(
        'Session recovery authority was revoked'
      );
      expect(f.read()).toMatchObject({
        completed: false,
        config: { recoveryAttemptId: 'wake-new' },
      });
      expect(f.setAlarm).not.toHaveBeenCalled();
    }
  );

  it('persists progress and alarms for the same wake', async () => {
    const f = fixture('wake-current');
    const state = structuredClone(f.read());
    const ctx = taskRunnerAttemptContext(f.ctx, state);
    state.completed = true;
    await ctx.storage.put('state', state);
    await ctx.storage.setAlarm(42);
    expect(f.read().completed).toBe(true);
    expect(f.setAlarm).toHaveBeenCalledWith(42);
  });
});
