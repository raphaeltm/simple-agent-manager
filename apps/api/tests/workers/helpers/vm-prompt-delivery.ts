import { resolveDurableExecutionConfig } from '@simple-agent-manager/project-data/internal/do/durable-execution-config';
import { claimDuePromptDeliveries } from '@simple-agent-manager/project-data/internal/do/prompt-delivery';
import { runPromptDeliveryClaim } from '@simple-agent-manager/project-data/internal/do/prompt-delivery-runner';
import { runInDurableObject } from 'cloudflare:test';

import type { Env } from '../../../src/env';
import { DefaultVmPromptDeliveryAdapter } from '../../../src/services/vm-prompt-delivery-adapter';
import type { projectStub } from './agent-message-channels';

const config = resolveDurableExecutionConfig({});

/** Run one due claim with real object bindings and the production VM adapter. */
export async function runDueDelivery(
  f: { stub: ReturnType<typeof projectStub>; projectId: string },
  now = Date.now()
) {
  return runInDurableObject(f.stub, async (instance, state) => {
    const [claim] = claimDuePromptDeliveries(state.storage.sql, config, now);
    if (!claim) return null;
    // Bindings must come from the object's own context, as in its production alarm.
    const objectEnv = (instance as unknown as { env: Env }).env;
    return runPromptDeliveryClaim(
      state.storage.sql,
      objectEnv,
      config,
      claim,
      new DefaultVmPromptDeliveryAdapter(objectEnv),
      {
        projectId: f.projectId,
        recalculateAlarm: async () => undefined,
        broadcastEvent: () => undefined,
        armIdleCleanup: () => undefined,
        nudgeDeliveries: () => 0,
        scheduleSummarySync: () => undefined,
      }
    );
  });
}
