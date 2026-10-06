import { SessionRecoveryAuthorityRevokedError } from '../../services/session-recovery-authority';
import type { TaskRunnerState } from './types';

/** Commit only to the run that produced this state, even across an awaited RPC. */
export async function putTaskRunnerState(
  storage: DurableObjectStorage,
  state: TaskRunnerState,
  options: { deleteAlarm?: boolean } = {}
): Promise<void> {
  await storage.transaction(async (transaction) => {
    const current = await transaction.get<TaskRunnerState>('state');
    if (
      current &&
      (current.config.recoveryAttemptId ?? null) !== (state.config.recoveryAttemptId ?? null)
    ) {
      throw new SessionRecoveryAuthorityRevokedError();
    }
    await transaction.put('state', state);
    if (options.deleteAlarm) await transaction.deleteAlarm();
  });
}

/**
 * Extracted steps share the DO storage interface. Fence their state/alarm writes
 * centrally so a response from an old runtime cannot overwrite a newer wake.
 */
export function taskRunnerAttemptContext(
  ctx: DurableObjectState,
  state: TaskRunnerState
): DurableObjectState {
  const storage = new Proxy(ctx.storage, {
    get(target, property) {
      if (property === 'put') {
        return async (key: string, value: unknown) => {
          if (key !== 'state') throw new Error('TaskRunner steps may only persist their state');
          await putTaskRunnerState(target, value as TaskRunnerState);
        };
      }
      if (property === 'setAlarm') {
        return async (scheduledTime: number | Date) => {
          await target.transaction(async (transaction) => {
            const current = await transaction.get<TaskRunnerState>('state');
            if (
              current &&
              (current.config.recoveryAttemptId ?? null) !==
                (state.config.recoveryAttemptId ?? null)
            ) {
              throw new SessionRecoveryAuthorityRevokedError();
            }
            await transaction.setAlarm(scheduledTime);
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'storage') return storage;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
