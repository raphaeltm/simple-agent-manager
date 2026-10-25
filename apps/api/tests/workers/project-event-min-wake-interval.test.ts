/**
 * An agent can choose how often one subscription wakes its chat (minWakeIntervalSeconds on
 * follow_event_channel and create_project_event_subscription). Raphaël, 2026-10-25: channel
 * messages wake agents too often and slow them down; a follower should be able to ask for "at
 * most once every 10 minutes" instead of every message.
 *
 * Every test enters through the real MCP tools, publishes through the real channel tool, and
 * drives the wake section's real scheduler and sweep together, with runtime acceptance applied
 * through the checkpoint the prompt-delivery runner calls.
 */
import { describe, expect, it } from 'vitest';

import * as svc from '../../src/services/project-data';
import {
  type ChannelReceipt,
  managedSubscriptions,
  okBody,
  sqlRows,
  testEnv,
  type ToolReply,
  twoAgentProject,
  withAgentMessageChannels,
} from './helpers/agent-message-channels';
import {
  acceptWake,
  fireWakeAlarmsUntilMaterialized,
  materialize,
  onlyWake,
  retryWakeBehindBusyTurn,
  wakeBatches,
  wakeDueAt,
  type WakeFixture,
  withQuietAlarms,
} from './helpers/event-wake-harness';

const CHANNEL = 'builds';
const HEAD_SHA = 'a51c94aeb7d0f1f6a8c0e5d2b3a4f5e6d7c8b9a0';
const PLATFORM_COOLDOWN_MS = 30_000;

type SubscriptionRecord = {
  id: string;
  minWakeIntervalMs?: number | null;
  deliveryPreference: { resolved: string };
};
type FollowReply = { result: { subscription: SubscriptionRecord; idempotent: boolean } };
type CreateReply = { subscription: SubscriptionRecord; idempotent: boolean };

/** Agent B publishes; agent A follows. A publication never wakes its own author. */
async function publish(f: WakeFixture, key: string): Promise<void> {
  okBody(
    await f.b.tool('publish_channel_event', {
      channel: CHANNEL,
      message: `build ${key} finished`,
      idempotencyKey: key,
    })
  );
}

function follow(f: WakeFixture, args: Record<string, unknown> = {}): Promise<ToolReply> {
  return f.a.tool('follow_event_channel', {
    channel: CHANNEL,
    idempotencyKey: 'follow-builds',
    requestedDelivery: 'existing_session_prompt',
    ...args,
  });
}

function subscribeToHeadCommit(
  f: WakeFixture,
  args: Record<string, unknown> = {}
): Promise<ToolReply> {
  return f.a.tool('create_project_event_subscription', {
    idempotencyKey: `ci-${HEAD_SHA}`,
    filter: { version: 1, source: 'github', subjectType: 'commit', subjectId: HEAD_SHA },
    requestedDelivery: 'existing_session_prompt',
    ...args,
  });
}

function admitCheckRunCompleted(f: WakeFixture, check: string) {
  const now = Date.now();
  return svc.admitProjectEvent(testEnv, f.projectId, {
    source: 'github',
    eventType: 'check_run.completed',
    subject: { type: 'commit', id: HEAD_SHA },
    severity: 'info',
    deliveryKey: `delivery:${check}-${crypto.randomUUID()}`,
    payloadFingerprint: `sha256:${check}`,
    metadata: { conclusion: 'success', checkName: check },
    display: { title: `${check} passed`, summary: 'CI check completed' },
    occurredAt: now,
    receivedAt: now,
  });
}

const storedInterval = async (f: WakeFixture, subscriptionId: string) =>
  (
    await sqlRows<{ min_wake_interval_ms: number | null }>(
      f.stub,
      'SELECT min_wake_interval_ms FROM project_event_subscriptions WHERE id = ?',
      subscriptionId
    )
  )[0]?.min_wake_interval_ms;

const storedCooldown = async (f: WakeFixture, subscriptionId: string) =>
  (
    await sqlRows<{ delivery_cooldown_until: number | null }>(
      f.stub,
      'SELECT delivery_cooldown_until FROM project_event_subscriptions WHERE id = ?',
      subscriptionId
    )
  )[0]?.delivery_cooldown_until;

const subscriptionCount = async (f: WakeFixture) =>
  (
    await sqlRows<{ n: number }>(
      f.stub,
      "SELECT COUNT(*) AS n FROM project_event_subscriptions WHERE idempotency_key NOT LIKE 'sam-agent-message:%'"
    )
  )[0]?.n;

/** Channels exist once something is published to them. */
async function channelFixture(): Promise<WakeFixture> {
  const f = await twoAgentProject();
  await publish(f, 'kickoff');
  return f;
}

describe('agent-chosen wake interval', () => {
  it('wakes a channel follower at most once per its interval, counted from when it received the last wake', async () => {
    await withAgentMessageChannels(async () => {
      const f = await channelFixture();
      const followed = okBody<FollowReply>(await follow(f, { minWakeIntervalSeconds: 600 }));
      expect(followed.result.subscription.minWakeIntervalMs).toBe(600_000);
      const subscriptionId = followed.result.subscription.id;

      await withQuietAlarms(f, async () => {
        // The first build after a quiet spell still wakes the follower promptly.
        await publish(f, 'first');
        const t0 = Date.now();
        expect(await materialize(f, t0)).toMatchObject({ status: 'materialized', materialized: 1 });
        const firstWake = await onlyWake(f, f.a.sessionId);

        // The agent receives that wake five seconds later, then two more builds finish.
        await acceptWake(f, firstWake.id, t0 + 5_000);
        await publish(f, 'second');
        await publish(f, 'third');

        // The platform cooldown alone would wake the chat again 30 s after the first wake.
        expect(await fireWakeAlarmsUntilMaterialized(f, t0 + 6_000)).toEqual([t0 + 605_000]);
        expect(await wakeBatches(f, f.a.sessionId)).toEqual([
          expect.objectContaining({ id: firstWake.id, state: 'delivered' }),
          expect.objectContaining({
            subscription_id: subscriptionId,
            state: 'pending',
            event_count: 2,
          }),
        ]);
      });

      // Nothing was dropped: every build is still readable through the subscription.
      const listed = okBody<{ events: unknown[] }>(
        await f.a.tool('list_subscription_events', { subscriptionId })
      );
      expect(listed.events).toHaveLength(3);
    });
  });

  it('does not wake again right after a wake that waited behind a long turn', async () => {
    await withAgentMessageChannels(async () => {
      const f = await channelFixture();
      okBody<FollowReply>(await follow(f, { minWakeIntervalSeconds: 600 }));

      await withQuietAlarms(f, async () => {
        await publish(f, 'first');
        const t0 = Date.now();
        expect(await materialize(f, t0)).toMatchObject({ status: 'materialized' });
        const firstWake = await onlyWake(f, f.a.sessionId);

        // The agent stays busy for 15 minutes while builds keep finishing. Its first wake is
        // still undelivered, so nothing else can run for the chat yet.
        await publish(f, 'second');
        await publish(f, 'third');
        expect(await wakeDueAt(f, t0 + 700_000)).toBeNull();

        // The turn ends and the agent receives the first wake. The ten minutes counted from
        // queueing have long passed; the next wake must still wait ten minutes from now.
        const receivedAt = t0 + 900_000;
        await acceptWake(f, firstWake.id, receivedAt);
        expect(await fireWakeAlarmsUntilMaterialized(f, receivedAt + 1_000)).toEqual([
          receivedAt + 600_000,
        ]);
        expect(await wakeBatches(f, f.a.sessionId)).toEqual([
          expect.objectContaining({ id: firstWake.id, state: 'delivered' }),
          expect.objectContaining({ state: 'pending', event_count: 2 }),
        ]);
      });
    });
  });

  it('counts the interval from queueing when the agent reads its events before the wake reaches it', async () => {
    await withAgentMessageChannels(async () => {
      const f = await channelFixture();
      const followed = okBody<FollowReply>(await follow(f, { minWakeIntervalSeconds: 600 }));
      const subscriptionId = followed.result.subscription.id;

      await withQuietAlarms(f, async () => {
        await publish(f, 'first');
        const t0 = Date.now();
        expect(await materialize(f, t0)).toMatchObject({ status: 'materialized' });
        const firstWake = await onlyWake(f, f.a.sessionId);

        // Mid-turn, the agent reads the subscription itself. That takes the queued wake over
        // through pull, so the runtime never accepts a wake prompt for it.
        okBody(await f.a.tool('list_subscription_events', { subscriptionId }));
        expect(await onlyWake(f, f.a.sessionId)).toMatchObject({
          id: firstWake.id,
          state: 'delivered',
        });

        // A minute later another build finishes. The interval still runs from the first wake.
        await publish(f, 'second');
        expect(await fireWakeAlarmsUntilMaterialized(f, t0 + 60_000)).toEqual([t0 + 600_000]);
      });
    });
  });

  it('keeps the platform cooldown for subscriptions and agent messages that set no interval', async () => {
    await withAgentMessageChannels(async () => {
      const f = await channelFixture();
      const followed = okBody<FollowReply>(await follow(f));
      expect(followed.result.subscription.minWakeIntervalMs).toBeNull();

      // A direct agent message rides a SAM-managed subscription, which never sets an interval.
      okBody<ChannelReceipt>(
        await f.b.tool('send_durable_message', {
          targetTaskId: f.a.taskId,
          message: 'review verdict: no blockers',
          messageClass: 'deliver',
        })
      );
      const managed = await managedSubscriptions(f.stub);
      expect(managed.length).toBeGreaterThan(0);
      for (const row of managed) expect(await storedInterval(f, row.id)).toBeNull();

      // Only the channel follow is exercised below, so retire the message wake first.
      await withQuietAlarms(f, async () => {
        const t0 = Date.now();
        expect(await materialize(f, t0)).toMatchObject({ status: 'materialized' });
        const messageWake = await onlyWake(f, f.a.sessionId);
        await acceptWake(f, messageWake.id, t0 + 1_000);

        await publish(f, 'first');
        expect(await fireWakeAlarmsUntilMaterialized(f, t0 + 2_000)).toEqual([t0 + 3_000]);
        const channelWake = (await wakeBatches(f, f.a.sessionId))[1];
        expect(channelWake).toMatchObject({
          subscription_id: followed.result.subscription.id,
          state: 'pending',
        });

        // Unchanged behaviour: the next wake follows the queue-time platform cooldown, and
        // accepting the wake does not extend it.
        const queuedAt = t0 + 3_000;
        await acceptWake(f, channelWake!.id, queuedAt + 5_000);
        await publish(f, 'second');
        expect(await fireWakeAlarmsUntilMaterialized(f, queuedAt + 6_000)).toEqual([
          queuedAt + PLATFORM_COOLDOWN_MS,
        ]);
      });
    });
  });

  it('applies the interval to runtime_interrupt wakes delivered by stopping a busy turn', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      const created = okBody<CreateReply>(
        await subscribeToHeadCommit(f, {
          requestedDelivery: 'runtime_interrupt',
          minWakeIntervalSeconds: 300,
        })
      );
      const subscriptionId = created.subscription.id;

      await withQuietAlarms(f, async () => {
        await admitCheckRunCompleted(f, 'unit');
        const t0 = Date.now();
        expect(await materialize(f, t0)).toMatchObject({ status: 'materialized' });
        const wake = await onlyWake(f, f.a.sessionId);
        const inbox = await sqlRows<{ message_class: string }>(
          f.stub,
          'SELECT message_class FROM session_inbox WHERE id = ?',
          wake.id
        );
        expect(inbox).toEqual([{ message_class: 'interrupt' }]);

        // Stop-and-deliver: the first attempt stops the busy turn and is retried. A retry is
        // not a delivery, so only the queue-time interval holds the subscription.
        await retryWakeBehindBusyTurn(f, wake.id, t0 + 1_000);
        expect(await storedCooldown(f, subscriptionId)).toBe(t0 + 300_000);
        expect(await onlyWake(f, f.a.sessionId)).toMatchObject({ state: 'pending' });

        // The resubmitted wake is the agent's next prompt; the interval counts from then.
        await acceptWake(f, wake.id, t0 + 15_000);
        await admitCheckRunCompleted(f, 'e2e');
        expect(await fireWakeAlarmsUntilMaterialized(f, t0 + 16_000)).toEqual([t0 + 315_000]);
      });
    });
  });

  it('keeps each subscription on its own interval when several wake the same chat', async () => {
    await withAgentMessageChannels(async () => {
      const f = await channelFixture();
      const channel = okBody<FollowReply>(await follow(f, { minWakeIntervalSeconds: 600 }));
      const ci = okBody<CreateReply>(
        await subscribeToHeadCommit(f, { minWakeIntervalSeconds: 120 })
      );
      const channelId = channel.result.subscription.id;
      const ciId = ci.subscription.id;

      await withQuietAlarms(f, async () => {
        await publish(f, 'first');
        const t0 = Date.now();
        expect(await materialize(f, t0)).toMatchObject({ status: 'materialized' });
        await acceptWake(f, (await onlyWake(f, f.a.sessionId)).id, t0 + 2_000);

        // CI finishes: the channel follow's ten minutes do not hold the CI subscription back.
        await admitCheckRunCompleted(f, 'unit');
        expect(await fireWakeAlarmsUntilMaterialized(f, t0 + 3_000)).toEqual([t0 + 4_000]);
        const ciWake = (await wakeBatches(f, f.a.sessionId))[1];
        expect(ciWake).toMatchObject({ subscription_id: ciId, state: 'pending' });
        await acceptWake(f, ciWake!.id, t0 + 6_000);
        expect(await storedCooldown(f, channelId)).toBe(t0 + 602_000);
        expect(await storedCooldown(f, ciId)).toBe(t0 + 126_000);

        // More of both arrive. Each wakes on its own schedule: CI after two minutes, the
        // channel only when its own ten minutes are up.
        await publish(f, 'second');
        await admitCheckRunCompleted(f, 'e2e');
        expect(await fireWakeAlarmsUntilMaterialized(f, t0 + 7_000)).toEqual([t0 + 126_000]);
        const secondCiWake = (await wakeBatches(f, f.a.sessionId))[2];
        expect(secondCiWake).toMatchObject({ subscription_id: ciId, event_count: 1 });
        await acceptWake(f, secondCiWake!.id, t0 + 127_000);
        expect(await fireWakeAlarmsUntilMaterialized(f, t0 + 128_000)).toEqual([t0 + 602_000]);
        expect((await wakeBatches(f, f.a.sessionId))[3]).toMatchObject({
          subscription_id: channelId,
          event_count: 1,
        });
      });
    });
  });

  it('stops waking once an interval subscription is cancelled mid-interval', async () => {
    await withAgentMessageChannels(async () => {
      const f = await channelFixture();
      const followed = okBody<FollowReply>(await follow(f, { minWakeIntervalSeconds: 600 }));
      const subscriptionId = followed.result.subscription.id;

      await withQuietAlarms(f, async () => {
        await publish(f, 'first');
        const t0 = Date.now();
        expect(await materialize(f, t0)).toMatchObject({ status: 'materialized' });
        await acceptWake(f, (await onlyWake(f, f.a.sessionId)).id, t0 + 1_000);
        await publish(f, 'second');
        // Liveness: the next wake is armed for the end of the interval.
        expect(await wakeDueAt(f, t0 + 2_000)).toBe(t0 + 601_000);

        okBody(await f.a.tool('cancel_project_event_subscription', { subscriptionId }));
        expect(await wakeDueAt(f, t0 + 2_000)).toBeNull();
        expect(await materialize(f, t0 + 601_000)).toMatchObject({ status: 'no_due_work' });
        expect(await wakeBatches(f, f.a.sessionId)).toHaveLength(1);
      });
    });
  });

  it('spends one alarm tick and no wake when the subscription expires inside its interval', async () => {
    await withAgentMessageChannels(async () => {
      const f = await channelFixture();
      okBody<FollowReply>(
        await follow(f, { minWakeIntervalSeconds: 600, expiresAt: Date.now() + 300_000 })
      );

      await withQuietAlarms(f, async () => {
        await publish(f, 'first');
        const t0 = Date.now();
        expect(await materialize(f, t0)).toMatchObject({ status: 'materialized' });
        await acceptWake(f, (await onlyWake(f, f.a.sessionId)).id, t0 + 1_000);
        await publish(f, 'second');

        // The interval outlasts the subscription: the single alarm at its end finds the
        // subscription expired, delivers nothing and does not re-arm.
        expect(await fireWakeAlarmsUntilMaterialized(f, t0 + 2_000)).toEqual([t0 + 601_000]);
        expect(await wakeDueAt(f, t0 + 601_000)).toBeNull();
        expect(await wakeBatches(f, f.a.sessionId)).toHaveLength(1);
      });
    });
  });

  it('honours the interval on create_project_event_subscription', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      const created = okBody<CreateReply>(
        await subscribeToHeadCommit(f, { minWakeIntervalSeconds: 120 })
      );
      expect(created.subscription).toMatchObject({
        minWakeIntervalMs: 120_000,
        deliveryPreference: { resolved: 'queued_for_prompt_delivery' },
      });

      await withQuietAlarms(f, async () => {
        await admitCheckRunCompleted(f, 'unit');
        const t0 = Date.now();
        expect(await materialize(f, t0)).toMatchObject({ status: 'materialized', materialized: 1 });
        const firstWake = await onlyWake(f, f.a.sessionId);
        await acceptWake(f, firstWake.id, t0 + 2_000);
        await admitCheckRunCompleted(f, 'e2e');
        await admitCheckRunCompleted(f, 'lint');

        expect(await fireWakeAlarmsUntilMaterialized(f, t0 + 3_000)).toEqual([t0 + 122_000]);
        expect((await wakeBatches(f, f.a.sessionId))[1]).toMatchObject({
          subscription_id: created.subscription.id,
          event_count: 2,
        });
      });
    });
  });

  it('raises an interval below the platform cooldown to the cooldown', async () => {
    await withAgentMessageChannels(async () => {
      const f = await channelFixture();
      const followed = okBody<FollowReply>(await follow(f, { minWakeIntervalSeconds: 5 }));
      expect(followed.result.subscription.minWakeIntervalMs).toBe(PLATFORM_COOLDOWN_MS);
      expect(await storedInterval(f, followed.result.subscription.id)).toBe(PLATFORM_COOLDOWN_MS);
    });
  });

  it('accepts an interval equal to the wake subscription lifetime and rejects a longer one', async () => {
    await withAgentMessageChannels(async () => {
      const f = await channelFixture();
      okBody<FollowReply>(
        await follow(f, { idempotencyKey: 'follow-daily', minWakeIntervalSeconds: 86_400 })
      );
      const before = await subscriptionCount(f);
      const tooLong = await follow(f, {
        idempotencyKey: 'follow-too-long',
        minWakeIntervalSeconds: 86_401,
      });
      expect(tooLong.error?.message).toBe(
        'minimum wake interval cannot exceed the wake subscription lifetime of 86400 seconds'
      );
      expect(await subscriptionCount(f)).toBe(before);
    });
  });

  it('rejects an interval on a subscription that never wakes the chat', async () => {
    await withAgentMessageChannels(async () => {
      const f = await channelFixture();
      const before = await subscriptionCount(f);
      const message =
        'minimum wake interval applies only to subscriptions that wake the chat ' +
        '(requestedDelivery existing_session_prompt or runtime_interrupt)';

      const recordOnlyFollow = await f.a.tool('follow_event_channel', {
        channel: CHANNEL,
        idempotencyKey: 'record-only-follow',
        minWakeIntervalSeconds: 600,
      });
      expect(recordOnlyFollow.error?.message).toBe(message);

      const recordOnlyCreate = await subscribeToHeadCommit(f, {
        requestedDelivery: 'record_only',
        minWakeIntervalSeconds: 600,
      });
      expect(recordOnlyCreate.error?.message).toBe(message);
      expect(await subscriptionCount(f)).toBe(before);

      // Liveness control: the same calls without the interval succeed.
      okBody(
        await f.a.tool('follow_event_channel', {
          channel: CHANNEL,
          idempotencyKey: 'record-only-follow',
        })
      );
      okBody(await subscribeToHeadCommit(f, { requestedDelivery: 'record_only' }));
    });
  });

  it('rejects a malformed minWakeIntervalSeconds on both tools', async () => {
    await withAgentMessageChannels(async () => {
      const f = await channelFixture();
      const before = await subscriptionCount(f);
      for (const value of [0, -60, 1.5, '600', true]) {
        const followed = await follow(f, { minWakeIntervalSeconds: value });
        expect(followed.error?.message).toBe('minWakeIntervalSeconds must be a positive integer');
        const created = await subscribeToHeadCommit(f, { minWakeIntervalSeconds: value });
        expect(created.error?.message).toBe('minWakeIntervalSeconds must be a positive integer');
      }
      expect(await subscriptionCount(f)).toBe(before);
    });
  });

  it('replays a follow with the same interval and refuses a changed one under the same key', async () => {
    await withAgentMessageChannels(async () => {
      const f = await channelFixture();
      const first = okBody<FollowReply>(await follow(f, { minWakeIntervalSeconds: 600 }));
      const replay = okBody<FollowReply>(await follow(f, { minWakeIntervalSeconds: 600 }));
      expect(replay.result).toMatchObject({
        idempotent: true,
        subscription: { id: first.result.subscription.id, minWakeIntervalMs: 600_000 },
      });

      const changed = await follow(f, { minWakeIntervalSeconds: 300 });
      expect(changed.error?.data).toMatchObject({ outcome: 'conflict' });
      const dropped = await follow(f);
      expect(dropped.error?.data).toMatchObject({ outcome: 'conflict' });
      expect(await storedInterval(f, first.result.subscription.id)).toBe(600_000);
    });
  });
});
