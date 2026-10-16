/** Shared alarm ownership for real Workers recovery tests. */
import { env, runInDurableObject } from 'cloudflare:test';
import { vi } from 'vitest';

import type { TaskRunnerState } from '../../../src/durable-objects/task-runner';

/** Runs inside the Durable Object before each transactional `state` write. */
export type StateWriteHook = { before: (state: TaskRunnerState) => Promise<void> };

/**
 * Capture alarms instead of arming them, so the test drives every step itself. The TaskRunner
 * fences each state write in a storage transaction (`putTaskRunnerState`), so `writes.before`
 * sees every write of `state` there.
 */
export function pauseAlarms(storage: DurableObjectStorage, writes?: StateWriteHook): void {
  const transaction = storage.transaction.bind(storage);
  vi.spyOn(storage, 'setAlarm').mockImplementation(async () => undefined);
  vi.spyOn(storage, 'transaction').mockImplementation(((
    callback: (txn: DurableObjectTransaction) => unknown
  ) =>
    transaction((txn) =>
      callback(
        new Proxy(txn, {
          get(target, property) {
            if (property === 'setAlarm') return async () => undefined;
            if (property === 'put' && writes) {
              return async (key: string, value: unknown) => {
                if (key === 'state') await writes.before(value as TaskRunnerState);
                return target.put(key, value);
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        })
      )
    )) as DurableObjectStorage['transaction']);
}

export async function pauseNodeAlarms(nodeId: string): Promise<void> {
  const stub = env.NODE_LIFECYCLE.get(env.NODE_LIFECYCLE.idFromName(nodeId));
  await runInDurableObject(stub, async (_instance, ctx) => {
    pauseAlarms(ctx.storage);
    await ctx.storage.deleteAlarm();
  });
}
