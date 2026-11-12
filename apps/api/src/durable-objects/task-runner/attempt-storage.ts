import type { ProviderLimitRecoveryApproval } from '../../services/provider-limit-recovery-approval';
import { revokeRecoveryAuthority } from './recovery-revocation';
import type { TaskRunnerState } from './types';

function attemptOf(state: TaskRunnerState): string | null {
  return state.config.recoveryAttemptId ?? null;
}

/**
 * Commit only to the run that produced this state, even across an awaited RPC.
 * A newer wake attempt in storage refuses the write; the refusal is logged after the
 * storage transaction so its diagnostic D1 read never runs inside it.
 */
export async function putTaskRunnerState(
  storage: DurableObjectStorage,
  database: D1Database,
  state: TaskRunnerState,
  options: { deleteAlarm?: boolean } = {}
): Promise<void> {
  const superseded = await storage.transaction(async (transaction) => {
    const current = await transaction.get<TaskRunnerState>('state');
    if (current && attemptOf(current) !== attemptOf(state)) return { attempt: attemptOf(current) };
    await transaction.put('state', state);
    if (options.deleteAlarm) await transaction.deleteAlarm();
    return null;
  });
  if (superseded) {
    throw await revokeRecoveryAuthority(
      database,
      state,
      'runner_attempt_superseded',
      'task_runner.put_state',
      superseded.attempt
    );
  }
}

/**
 * Extracted steps share the DO storage interface. Fence their state/alarm writes
 * centrally so a response from an old runtime cannot overwrite a newer wake.
 */
export function taskRunnerAttemptContext(
  ctx: DurableObjectState,
  state: TaskRunnerState,
  database: D1Database
): DurableObjectState {
  const storage = new Proxy(ctx.storage, {
    get(target, property) {
      if (property === 'put') {
        return async (key: string, value: unknown) => {
          if (key !== 'state') throw new Error('TaskRunner steps may only persist their state');
          await putTaskRunnerState(target, database, value as TaskRunnerState);
        };
      }
      if (property === 'setAlarm') {
        return async (scheduledTime: number | Date) => {
          const superseded = await target.transaction(async (transaction) => {
            const current = await transaction.get<TaskRunnerState>('state');
            if (current && attemptOf(current) !== attemptOf(state)) {
              return { attempt: attemptOf(current) };
            }
            await transaction.setAlarm(scheduledTime);
            return null;
          });
          if (superseded) {
            throw await revokeRecoveryAuthority(
              database,
              state,
              'runner_attempt_superseded',
              'task_runner.set_alarm',
              superseded.attempt
            );
          }
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

/** Merge consent into the current attempt, never persist the pre-RPC state. */
export async function persistProviderLimitRecoveryNudge(
  storage: DurableObjectStorage,
  observed: TaskRunnerState,
  approval: ProviderLimitRecoveryApproval
): Promise<boolean> {
  return storage.transaction(async (transaction) => {
    const current = await transaction.get<TaskRunnerState>('state');
    if (
      !current ||
      current.completed ||
      current.currentStep === 'running' ||
      current.currentStep === 'awaiting_followup'
    )
      return false;
    if (
      current.taskId !== observed.taskId ||
      current.projectId !== observed.projectId ||
      current.userId !== approval.ownerUserId ||
      attemptOf(current) !== attemptOf(observed)
    )
      return false;
    current.config.providerLimitRecoveryApproval = approval;
    await transaction.put('state', current);
    await transaction.setAlarm(Date.now());
    return true;
  });
}
