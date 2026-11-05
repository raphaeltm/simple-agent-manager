/**
 * Agent-message notices steer by default, end to end in the Workers runtime: a real
 * `send_durable_message`, the managed pair subscription it creates, the wake materializer and
 * the ProjectData delivery alarm. Only the VM adapter's HTTP methods are stubbed.
 *
 * Managed subscriptions created before this default queued their wakes. They are replaced on
 * the pair's next message, and one that still owes a wake keeps it until it drains.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DefaultVmPromptDeliveryAdapter } from '../../src/services/vm-prompt-delivery-adapter';
import {
  type ChannelReceipt,
  eventMatches,
  okBody,
  sqlRows,
  twoAgentProject,
  withAgentMessageChannels,
} from './helpers/agent-message-channels';
import {
  materialize,
  wakeBatches,
  type WakeFixture,
  withQuietAlarms,
} from './helpers/event-wake-harness';
import {
  accepted,
  capabilities,
  deliveryPass,
  expectSteeredOnce,
  mockSteered,
  snapshot,
} from './helpers/steer-wake-harness';

type ManagedRow = {
  id: string;
  requested_delivery: string;
  lifecycle_state: string;
  match_keys: number;
};

/** The recipient's managed subscriptions, oldest first, with their delivery and match keys. */
const recipientSubscriptions = (f: WakeFixture) =>
  sqlRows<ManagedRow>(
    f.stub,
    `SELECT s.id, s.requested_delivery, s.lifecycle_state,
            (SELECT COUNT(*) FROM project_event_subscription_match_keys k
             WHERE k.subscription_id = s.id) AS match_keys
     FROM project_event_subscriptions s
     WHERE s.idempotency_key LIKE 'sam-agent-message:%' AND s.target_session_id = ?
     ORDER BY s.created_at, s.id`,
    f.b.sessionId
  );

const send = async (f: WakeFixture, message: string) =>
  okBody<ChannelReceipt>(
    await f.a.tool('send_durable_message', { targetTaskId: f.b.taskId, message })
  );

/** B's wake batches for one subscription, materializing any that are due first. */
async function wakesFor(f: WakeFixture, subscriptionId: string) {
  await materialize(f, Date.now());
  return (await wakeBatches(f, f.b.sessionId)).filter((b) => b.subscription_id === subscriptionId);
}

/** Send one message to B and materialize its wake; returns the wake's inbox id. */
async function peerWake(f: WakeFixture, message: string): Promise<string> {
  await send(f, message);
  const [subscription] = await recipientSubscriptions(f);
  const batches = await wakesFor(f, subscription!.id);
  expect(batches).toHaveLength(1);
  return batches[0]!.id;
}

/** Make B's current managed subscription look like one created before the steering default. */
const markLegacyQueueMode = (f: WakeFixture) =>
  sqlRows(
    f.stub,
    `UPDATE project_event_subscriptions SET requested_delivery = 'existing_session_prompt'
     WHERE idempotency_key LIKE 'sam-agent-message:%' AND target_session_id = ?`,
    f.b.sessionId
  );

describe('agent-message notices steer by default', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates the pair subscription with runtime_steer and adds the notice to the running turn', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      // The channel transport needs event wakes and prompt delivery on, so the message is sent
      // first; background alarms are then switched off and the test drives each delivery pass.
      const batchId = await peerWake(f, 'staging is free');
      await withQuietAlarms(f, async () => {
        expect(await recipientSubscriptions(f)).toEqual([
          expect.objectContaining({
            requested_delivery: 'runtime_steer',
            lifecycle_state: 'active',
          }),
        ]);
        expect((await snapshot(f, batchId)).inbox).toMatchObject({
          delivery_state: 'queued',
          delivery_intent: 'steer',
          message_class: 'deliver',
        });
        const steer = mockSteered((input) =>
          expect(input.claim.message.content).toMatch(/^SAM notice \(system-generated/)
        );
        await expectSteeredOnce(f, batchId, steer);
      });
    });
  });

  it('wakes an idle recipient with an ordinary prompt, delivered once', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      const batchId = await peerWake(f, 'are you there?');
      await withQuietAlarms(f, async () => {
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
        expect((await snapshot(f, batchId)).inbox).toMatchObject({
          delivery_intent: 'queue',
          steer_outcome: 'queued_fallback',
          steer_reason: 'no_running_turn',
        });
        await deliveryPass(f);
        await deliveryPass(f);

        expect(steer).toHaveBeenCalledTimes(1);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(await snapshot(f, batchId)).toMatchObject({
          batch: { state: 'delivered' },
          attempts: ['retry', 'accepted'],
        });
      });
    });
  });

  it('replaces a queue-mode pair subscription that owes nothing on the next message', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      await send(f, 'one');
      await markLegacyQueueMode(f);
      const [legacy] = await recipientSubscriptions(f);
      // Its wake is spent: delivered and nothing left matched.
      expect(await wakesFor(f, legacy!.id)).toHaveLength(1);
      await sqlRows(
        f.stub,
        `UPDATE project_event_delivery_batches SET state = 'delivered' WHERE subscription_id = ?`,
        legacy!.id
      );

      const second = await send(f, 'two');

      const rows = await recipientSubscriptions(f);
      expect(rows).toEqual([
        expect.objectContaining({ id: legacy!.id, lifecycle_state: 'expired' }),
        expect.objectContaining({
          requested_delivery: 'runtime_steer',
          lifecycle_state: 'active',
        }),
      ]);
      expect(await eventMatches(f.stub, second.eventId)).toEqual([
        expect.objectContaining({ subscription_id: rows[1]!.id, state: 'matched' }),
      ]);
    });
  });

  it('keeps a queue-mode pair subscription until its matched message drains, without double matching', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      const first = await send(f, 'one');
      await markLegacyQueueMode(f);
      const [legacy] = await recipientSubscriptions(f);

      // The first message is matched but not yet batched when the next one is sent.
      const second = await send(f, 'two');

      const rows = await recipientSubscriptions(f);
      expect(rows).toEqual([
        expect.objectContaining({
          id: legacy!.id,
          requested_delivery: 'existing_session_prompt',
          lifecycle_state: 'active',
          match_keys: 0,
        }),
        expect.objectContaining({
          requested_delivery: 'runtime_steer',
          lifecycle_state: 'active',
        }),
      ]);
      // The old message is still owed; the new one matches only the steering subscription.
      expect(await eventMatches(f.stub, first.eventId)).toEqual([
        expect.objectContaining({ subscription_id: legacy!.id, state: 'matched' }),
      ]);
      expect(await eventMatches(f.stub, second.eventId)).toEqual([
        expect.objectContaining({ subscription_id: rows[1]!.id, state: 'matched' }),
      ]);

      // The owed wake materializes in the mode the old subscription was created with.
      const [legacyBatch] = await wakesFor(f, legacy!.id);
      expect((await snapshot(f, legacyBatch!.id)).inbox).toMatchObject({
        delivery_intent: 'queue',
      });
    });
  });
});
