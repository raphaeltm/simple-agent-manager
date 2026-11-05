/**
 * A `runtime_steer` event subscription end to end in the Workers runtime: created through the
 * real MCP tool, then real event admission, wake materializer and ProjectData delivery alarm.
 * Only the VM adapter's HTTP methods are stubbed. The batch must ride the steer lane, record
 * its attempts through the event-wake checkpoint, and reach the chat exactly once whether the
 * runtime takes the steer or hands it back to the queue.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as svc from '../../src/services/project-data';
import { DefaultVmPromptDeliveryAdapter } from '../../src/services/vm-prompt-delivery-adapter';
import {
  okBody,
  testEnv,
  twoAgentProject,
  withAgentMessageChannels,
} from './helpers/agent-message-channels';
import { materialize, type WakeFixture, withQuietAlarms } from './helpers/event-wake-harness';
import { accepted, capabilities, deliveryPass, snapshot } from './helpers/steer-wake-harness';

/**
 * Subscribe agent A's chat through the MCP tool, admit one event, materialize. Omitting
 * `requestedDelivery` exercises the tool's default, which is `runtime_steer`.
 */
async function steerWakeBatch(
  f: WakeFixture,
  delivery: { requestedDelivery?: string; expected: string } = {
    requestedDelivery: 'runtime_steer',
    expected: 'runtime_steer',
  }
) {
  const created = okBody<{ subscription: { deliveryPreference: Record<string, unknown> } }>(
    await f.a.tool('create_project_event_subscription', {
      idempotencyKey: 'ci-steer',
      filter: { version: 1, source: 'github', subjectType: 'pull_request', subjectId: '42' },
      ...(delivery.requestedDelivery ? { requestedDelivery: delivery.requestedDelivery } : {}),
    })
  );
  expect(created.subscription.deliveryPreference).toMatchObject({
    requested: delivery.expected,
    resolved: 'queued_for_prompt_delivery',
  });
  const now = Date.now();
  await svc.admitProjectEvent(testEnv, f.projectId, {
    source: 'github',
    eventType: 'check_suite.completed',
    subject: { type: 'pull_request', id: '42' },
    severity: 'warning',
    deliveryKey: `delivery-${crypto.randomUUID()}`,
    payloadFingerprint: 'sha256:steer-wake',
    metadata: { conclusion: 'failure' },
    display: { title: 'CI failed', summary: 'A bounded normalized event' },
    occurredAt: now,
    receivedAt: now,
  });
  const materialized = await materialize(f, now);
  expect(materialized).toMatchObject({ status: 'materialized', materialized: 1 });
  if (materialized.status !== 'materialized') throw new Error('not materialized');
  return materialized.accepted[0]!.accepted.message.id as string;
}

describe('runtime_steer event wakes through the materializer and delivery alarm', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('steers the batch into the running turn and records one accepted attempt', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      await withQuietAlarms(f, async () => {
        const batchId = await steerWakeBatch(f);
        expect((await snapshot(f, batchId)).inbox).toMatchObject({
          delivery_state: 'queued',
          delivery_intent: 'steer',
          message_class: 'deliver',
        });
        const steer = vi
          .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'steer')
          .mockImplementation(async (input) => {
            expect(input.beforeSubmit?.(capabilities)).toBe(true);
            return {
              kind: 'steered',
              promptEpoch: 1,
              runtimeIdentity: 'runtime',
              capabilities,
              receipt: null,
            };
          });
        const submit = vi.spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit');

        await deliveryPass(f);

        expect(steer).toHaveBeenCalledTimes(1);
        expect(steer.mock.calls[0]![0].claim.message.id).toBe(batchId);
        expect(submit).not.toHaveBeenCalled();
        expect(await snapshot(f, batchId)).toMatchObject({
          inbox: { delivery_intent: 'steer', steer_outcome: 'steered' },
          batch: { state: 'delivered' },
          attempts: ['accepted'],
        });
      });
    });
  });

  it('hands a steer the runtime did not take to the queue, and delivers it once', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      await withQuietAlarms(f, async () => {
        const batchId = await steerWakeBatch(f);
        const steer = vi
          .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'steer')
          .mockResolvedValue({
            kind: 'steer_fallback',
            reason: 'no_running_turn',
            error: 'idle',
            runtimeIdentity: 'runtime',
            capabilities,
          });
        const submit = vi
          .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit')
          .mockImplementation(async (input) => accepted(input));

        await deliveryPass(f);
        const afterFallback = await snapshot(f, batchId);
        expect(afterFallback).toMatchObject({
          inbox: {
            delivery_state: 'queued',
            delivery_intent: 'queue',
            steer_outcome: 'queued_fallback',
            steer_reason: 'no_running_turn',
          },
          attempts: ['retry'],
        });
        expect(afterFallback.batch).not.toMatchObject({ state: 'delivered' });

        await deliveryPass(f);
        expect(steer).toHaveBeenCalledTimes(1);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(submit.mock.calls[0]![0].claim.message.id).toBe(batchId);
        expect(await snapshot(f, batchId)).toMatchObject({
          batch: { state: 'delivered' },
          attempts: ['retry', 'accepted'],
        });

        // Nothing is left to deliver: a further pass sends nothing.
        await deliveryPass(f);
        expect(steer).toHaveBeenCalledTimes(1);
        expect(submit).toHaveBeenCalledTimes(1);
      });
    });
  });
  it('steers by default: a subscription created without requestedDelivery rides the steer lane', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      await withQuietAlarms(f, async () => {
        const batchId = await steerWakeBatch(f, { expected: 'runtime_steer' });
        const steer = vi
          .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'steer')
          .mockImplementation(async (input) => {
            expect(input.beforeSubmit?.(capabilities)).toBe(true);
            return {
              kind: 'steered',
              promptEpoch: 1,
              runtimeIdentity: 'runtime',
              capabilities,
              receipt: null,
            };
          });
        const submit = vi.spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit');

        await deliveryPass(f);

        expect(steer).toHaveBeenCalledTimes(1);
        expect(submit).not.toHaveBeenCalled();
        expect(await snapshot(f, batchId)).toMatchObject({
          inbox: { delivery_intent: 'steer', steer_outcome: 'steered' },
          batch: { state: 'delivered' },
        });
      });
    });
  });

  it('still queues when existing_session_prompt is requested explicitly', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      await withQuietAlarms(f, async () => {
        const batchId = await steerWakeBatch(f, {
          requestedDelivery: 'existing_session_prompt',
          expected: 'existing_session_prompt',
        });
        const steer = vi.spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'steer');
        const submit = vi
          .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit')
          .mockImplementation(async (input) => accepted(input));

        await deliveryPass(f);

        expect(steer).not.toHaveBeenCalled();
        expect(submit).toHaveBeenCalledTimes(1);
        expect(await snapshot(f, batchId)).toMatchObject({
          inbox: { delivery_intent: 'queue', steer_outcome: null },
          batch: { state: 'delivered' },
        });
      });
    });
  });
});
