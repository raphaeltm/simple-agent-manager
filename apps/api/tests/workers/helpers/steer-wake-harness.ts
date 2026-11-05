/**
 * Drives a steer-intent prompt delivery through the real ProjectData delivery alarm with only
 * the VM adapter's HTTP methods stubbed, and reads back what the inbox, the event batch and its
 * attempts recorded. Shared by the event-wake steering tests.
 */
import type { VmPromptDeliveryCapabilities } from '@simple-agent-manager/shared';
import { runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';

import {
  type DurabilityFoundationHooks,
  processPromptDeliveryAlarm,
} from '../../../src/durable-objects/project-data/durability-foundation';
import {
  nudgePromptDeliveriesForTarget,
  type PromptDeliveryResult,
} from '../../../src/durable-objects/project-data/prompt-delivery';
import type { DefaultVmPromptDeliveryAdapter } from '../../../src/services/vm-prompt-delivery-adapter';
import { versionedPromptCapabilities } from '../../helpers/vm-prompt-delivery-fixtures';
import { testEnv } from './agent-message-channels';
import type { WakeFixture } from './event-wake-harness';

export const capabilities: VmPromptDeliveryCapabilities = {
  ...versionedPromptCapabilities('runtime'),
  steering: {
    supported: true,
    version: 1,
    lookup: true,
    states: ['accepted', 'in_flight', 'injected', 'not_consumed', 'ambiguous'],
  },
};

/** One pass of the delivery alarm inside the object, with its background work drained. */
export async function deliveryPass(f: WakeFixture) {
  await runInDurableObject(f.stub, async (_instance, state) => {
    const pending: Promise<unknown>[] = [];
    const hooks: DurabilityFoundationHooks = {
      getProjectId: () => f.projectId,
      transactionSync: (fn) => state.storage.transactionSync(fn),
      waitUntil: (promise) => {
        pending.push(promise);
      },
      recalculateAlarm: async () => {},
      scheduleSummarySync: () => {},
      broadcastEvent: () => {},
      armIdleCleanup: () => {},
      nudgeDeliveries: (id) => nudgePromptDeliveriesForTarget(state.storage.sql, id),
    };
    processPromptDeliveryAlarm(
      state.storage.sql,
      { ...testEnv, PROJECT_EVENT_WAKE_ENABLED: 'true', DURABLE_PROMPT_DELIVERY_ENABLED: 'true' },
      hooks
    );
    await Promise.all(pending);
  });
}

export async function snapshot(f: WakeFixture, batchId: string) {
  return runInDurableObject(f.stub, async (_instance, state) => {
    const sql = state.storage.sql;
    const inbox = sql
      .exec(
        `SELECT delivery_state, delivery_intent, message_class, steer_outcome, steer_reason
         FROM session_inbox WHERE id = ?`,
        batchId
      )
      .toArray()[0];
    const batch = sql
      .exec('SELECT state FROM project_event_delivery_batches WHERE id = ?', batchId)
      .toArray()[0];
    const attempts = sql
      .exec(
        `SELECT state FROM project_event_delivery_attempts
         WHERE batch_id = ? AND attempt_number > 0 ORDER BY attempt_number`,
        batchId
      )
      .toArray()
      .map((row) => row.state);
    return { inbox, batch, attempts };
  });
}

export function accepted(input: Parameters<DefaultVmPromptDeliveryAdapter['submit']>[0]) {
  expect(input.beforeSubmit?.(capabilities)).toBe(true);
  return {
    kind: 'accepted',
    acpSessionId: input.claim.message.targetSessionId,
    promptEpoch: Date.now(),
    runtimeIdentity: 'runtime',
    capabilities,
    receipt: null,
  } satisfies PromptDeliveryResult;
}
