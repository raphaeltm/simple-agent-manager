import {
  DIRECT_PROVISIONING_KEY,
  type DirectProvisioningIntent,
  NodeLifecycleProvisioning,
} from '../../src/durable-objects/node-lifecycle-provisioning';
import type { Env } from '../../src/env';
import type { DirectProvisioningInput } from '../../src/services/direct-provisioning';

/** Only DO transport/storage is replaced here; alarm/controller, provider, authority and D1 are real. */
export function directProvisioningHarness(env: Env) {
  const instances = new Map<
    string,
    {
      controller: NodeLifecycleProvisioning;
      values: Map<string, unknown>;
      alarm: number | null;
      restart: () => void;
    }
  >();
  const pending: Promise<unknown>[] = [];
  const binding = {
    idFromName: (name: string) => name,
    get(name: string) {
      let instance = instances.get(name);
      if (!instance) {
        const values = new Map<string, unknown>();
        const record = {
          values,
          alarm: null as number | null,
          controller: null as unknown as NodeLifecycleProvisioning,
          restart: () => {
            record.controller = new NodeLifecycleProvisioning(ctx, env);
          },
        };
        const ctx = {
          storage: {
            get: async (key: string) => structuredClone(values.get(key)),
            put: async (key: string, value: unknown) => {
              values.set(key, structuredClone(value));
            },
            setAlarm: async (time: number) => {
              record.alarm = time;
            },
            deleteAlarm: async () => {
              record.alarm = null;
            },
          },
          waitUntil: (promise: Promise<unknown>) => {
            pending.push(promise);
          },
        } as unknown as DurableObjectState;
        record.controller = new NodeLifecycleProvisioning(ctx, env);
        instances.set(name, record);
        instance = record;
      }
      return {
        startProvisioning: (input: DirectProvisioningInput) => instance!.controller.start(input),
      };
    },
  };
  Object.assign(env, { NODE_LIFECYCLE: binding });
  return {
    pending,
    instances,
    async tick() {
      for (const instance of instances.values()) {
        const intent = instance.values.get(DIRECT_PROVISIONING_KEY) as
          | DirectProvisioningIntent
          | undefined;
        if (intent?.nextAttemptAt !== null && intent) intent.nextAttemptAt = Date.now();
        await instance.controller.alarm();
      }
    },
  };
}
