/**
 * A chat holds at most one event wake that has not reached its runtime yet, and only until the
 * runtime accepts it. Reproduces the 2026-10-09 production incident (idea
 * 01M4E7F6JN191Q4B7H3KRB3N7H): an agent message woke a chat, was never acknowledged, and its
 * 24-hour expiry was copied into the chat's CI subscription, so finished CI never woke the chat.
 */
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/durable-objects/migrations';
import * as svc from '../../src/services/project-data';
import {
  type ChannelReceipt,
  okBody,
  sqlRows,
  testEnv,
  twoAgentProject,
  withAgentMessageChannels,
} from './helpers/agent-message-channels';
import {
  acceptWake,
  materialize,
  onlyWake,
  wakeBatches,
  wakeDueAt,
  type WakeFixture as Fixture,
  withQuietAlarms,
} from './helpers/event-wake-harness';

type SubscriptionRow = { delivery_cooldown_until: number | null; wake_due_at: number | null };

const HEAD_SHA = '107390d66f57c845f80b1b44507ccf2115635823';

const subscriptionRow = async (f: Fixture, subscriptionId: string) =>
  (
    await sqlRows<SubscriptionRow>(
      f.stub,
      `SELECT delivery_cooldown_until, wake_due_at FROM project_event_subscriptions WHERE id = ?`,
      subscriptionId
    )
  )[0];

async function subscribeToHeadCommit(f: Fixture): Promise<string> {
  const created = okBody<{
    subscription: { id: string; deliveryPreference: { resolved: string } };
  }>(
    await f.a.tool('create_project_event_subscription', {
      idempotencyKey: `ci-${HEAD_SHA}`,
      filter: { version: 1, source: 'github', subjectType: 'commit', subjectId: HEAD_SHA },
      requestedDelivery: 'existing_session_prompt',
    })
  );
  expect(created.subscription.deliveryPreference.resolved).toBe('queued_for_prompt_delivery');
  return created.subscription.id;
}

/** The shape the GitHub producer admits for a finished check run on the head commit. */
function admitCheckRunCompleted(f: Fixture, check: string) {
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

describe('event wake target occupancy', () => {
  it('wakes a chat for CI once its earlier message wake is delivered, without an acknowledgement', async () => {
    const f = await twoAgentProject();
    await withAgentMessageChannels(async () => {
      const ciSubscriptionId = await subscribeToHeadCommit(f);
      // A reviewer's message wakes the chat first. The agent never acknowledges it.
      okBody<ChannelReceipt>(
        await f.b.tool('send_durable_message', {
          targetTaskId: f.a.taskId,
          message: 'review verdict: no blockers',
          messageClass: 'deliver',
        })
      );
      await withQuietAlarms(f, async () => {
        const t0 = Date.now();
        expect(await materialize(f, t0)).toMatchObject({ status: 'materialized', materialized: 1 });
        const messageWake = await onlyWake(f, f.a.sessionId);
        expect(messageWake).toMatchObject({ state: 'pending' });

        // CI finishes while that wake is still queued behind the busy agent.
        await admitCheckRunCompleted(f, 'e2e');
        let clock = t0 + 1_000;
        // While the chat's wake is undelivered the CI wake neither runs nor re-arms the wake
        // alarm, and its subscription is not given the wake's 24-hour expiry.
        expect(await wakeDueAt(f, clock)).toBeNull();
        expect(await materialize(f, clock)).toMatchObject({ status: 'no_due_work' });
        expect(await subscriptionRow(f, ciSubscriptionId)).toMatchObject({
          delivery_cooldown_until: null,
        });

        // The runtime accepts the message wake. Nobody acknowledges it. Drive the wake section's
        // schedule and its sweep together and record every time the alarm would fire.
        clock = t0 + 5_000;
        await acceptWake(f, messageWake.id, clock);
        const fireTimes: number[] = [];
        for (let tick = 0; tick < 3; tick++) {
          const dueAt = await wakeDueAt(f, clock);
          if (dueAt === null) break;
          fireTimes.push(dueAt);
          clock = dueAt;
          await materialize(f, clock);
        }
        expect(fireTimes).toEqual([t0 + 6_000]);

        expect(await wakeBatches(f, f.a.sessionId)).toEqual([
          expect.objectContaining({ id: messageWake.id, state: 'delivered', acked_at: null }),
          expect.objectContaining({
            subscription_id: ciSubscriptionId,
            state: 'pending',
            event_count: 1,
          }),
        ]);
      });
    });
  });

  it('keeps a second wake for the same chat queued until the first reaches the runtime', async () => {
    const f = await twoAgentProject();
    await withAgentMessageChannels(async () => {
      const ciSubscriptionId = await subscribeToHeadCommit(f);
      await withQuietAlarms(f, async () => {
        await admitCheckRunCompleted(f, 'tests');
        const t0 = Date.now();
        expect(await materialize(f, t0)).toMatchObject({ status: 'materialized', materialized: 1 });
        const firstWake = await onlyWake(f, f.a.sessionId);

        // Past the 30 s subscription cooldown, a second result arrives while the first wake waits.
        await admitCheckRunCompleted(f, 'e2e');
        const afterCooldown = t0 + 31_000;
        expect(await wakeDueAt(f, afterCooldown)).toBeNull();
        expect(await materialize(f, afterCooldown)).toMatchObject({ status: 'no_due_work' });
        expect(await wakeBatches(f, f.a.sessionId)).toHaveLength(1);

        await acceptWake(f, firstWake.id, afterCooldown);
        expect(await wakeDueAt(f, afterCooldown)).toBe(afterCooldown + 1_000);
        expect(await materialize(f, afterCooldown + 1_000)).toMatchObject({
          status: 'materialized',
          materialized: 1,
        });
        expect(await wakeBatches(f, f.a.sessionId)).toEqual([
          expect.objectContaining({ id: firstWake.id, state: 'delivered' }),
          expect.objectContaining({ subscription_id: ciSubscriptionId, state: 'pending' }),
        ]);
      });
    });
  });

  it('frees the chat when the agent reads its queued wake through pull', async () => {
    const f = await twoAgentProject();
    await withAgentMessageChannels(async () => {
      await subscribeToHeadCommit(f);
      const message = okBody<ChannelReceipt>(
        await f.b.tool('send_durable_message', {
          targetTaskId: f.a.taskId,
          message: 'please re-run e2e',
          messageClass: 'deliver',
        })
      );
      await withQuietAlarms(f, async () => {
        const t0 = Date.now();
        expect(await materialize(f, t0)).toMatchObject({ status: 'materialized' });
        await admitCheckRunCompleted(f, 'e2e');
        expect(await wakeDueAt(f, t0 + 1_000)).toBeNull();

        // Reading the event before its wake is delivered takes the delivery over through pull.
        const read = okBody<{
          event: { delivery: { deliveryChannel: string; deliveredVia: string } };
        }>(await f.a.tool('get_event', { eventId: message.eventId }));
        expect(read.event.delivery).toMatchObject({
          deliveryChannel: 'prompt_queue',
          deliveredVia: 'pull',
        });
        expect(await wakeDueAt(f, t0 + 2_000)).toBe(t0 + 3_000);
      });
    });
  });

  it('frees the chat when the agent acknowledges its queued wake', async () => {
    const f = await twoAgentProject();
    await withAgentMessageChannels(async () => {
      await subscribeToHeadCommit(f);
      okBody<ChannelReceipt>(
        await f.b.tool('send_durable_message', {
          targetTaskId: f.a.taskId,
          message: 'ack me early',
          messageClass: 'deliver',
        })
      );
      await withQuietAlarms(f, async () => {
        const t0 = Date.now();
        expect(await materialize(f, t0)).toMatchObject({ status: 'materialized' });
        const messageWake = await onlyWake(f, f.a.sessionId);
        await admitCheckRunCompleted(f, 'e2e');
        expect(await wakeDueAt(f, t0 + 1_000)).toBeNull();

        okBody(await f.a.tool('ack_event_delivery', { deliveryId: messageWake.id }));
        expect(await onlyWake(f, f.a.sessionId)).toMatchObject({ state: 'acked' });
        expect(await wakeDueAt(f, t0 + 2_000)).toBe(t0 + 3_000);
      });
    });
  });

  it('frees the chat when the subscription holding its queued wake is cancelled', async () => {
    const f = await twoAgentProject();
    await withAgentMessageChannels(async () => {
      const ciSubscriptionId = await subscribeToHeadCommit(f);
      const pr = okBody<{ subscription: { id: string } }>(
        await f.a.tool('create_project_event_subscription', {
          idempotencyKey: 'pr-209',
          filter: { version: 1, source: 'github', subjectType: 'pull_request', subjectId: '209' },
          requestedDelivery: 'existing_session_prompt',
        })
      );
      await withQuietAlarms(f, async () => {
        const now = Date.now();
        await svc.admitProjectEvent(testEnv, f.projectId, {
          source: 'github',
          eventType: 'pull_request_review.submitted',
          subject: { type: 'pull_request', id: '209' },
          severity: 'info',
          deliveryKey: `delivery:review-${crypto.randomUUID()}`,
          payloadFingerprint: 'sha256:review',
          metadata: { state: 'approved' },
          display: { title: 'Review submitted', summary: 'Approved' },
          occurredAt: now,
          receivedAt: now,
        });
        const t0 = Date.now();
        expect(await materialize(f, t0)).toMatchObject({ status: 'materialized' });
        expect(await onlyWake(f, f.a.sessionId)).toMatchObject({
          subscription_id: pr.subscription.id,
          state: 'pending',
        });
        await admitCheckRunCompleted(f, 'e2e');
        expect(await wakeDueAt(f, t0 + 1_000)).toBeNull();

        okBody(
          await f.a.tool('cancel_project_event_subscription', {
            subscriptionId: pr.subscription.id,
          })
        );
        expect(await onlyWake(f, f.a.sessionId)).toMatchObject({ state: 'cancelled' });
        expect(await wakeDueAt(f, t0 + 2_000)).toBe(t0 + 3_000);
        expect(await materialize(f, t0 + 3_000)).toMatchObject({ status: 'materialized' });
        expect(await wakeBatches(f, f.a.sessionId)).toEqual([
          expect.objectContaining({ subscription_id: pr.subscription.id, state: 'cancelled' }),
          expect.objectContaining({ subscription_id: ciSubscriptionId, state: 'pending' }),
        ]);
      });
    });
  });

  it('labels events read through pull as not injected rather than unsupported', async () => {
    const f = await twoAgentProject();
    await withAgentMessageChannels(async () => {
      const ciSubscriptionId = await subscribeToHeadCommit(f);
      await withQuietAlarms(f, async () => {
        await admitCheckRunCompleted(f, 'e2e');
        const listed = okBody<{ events: Array<{ delivery: Record<string, unknown> }> }>(
          await f.a.tool('list_subscription_events', { subscriptionId: ciSubscriptionId })
        );
        expect(listed.events).toHaveLength(1);
        expect(listed.events[0]?.delivery).toMatchObject({
          deliveryChannel: 'pull',
          deliveredVia: 'pull',
          requestedDelivery: 'existing_session_prompt',
          resolvedDelivery: 'recorded_not_injected',
        });
      });
    });
  });

  it('migration 063 releases holds stamped on existing subscriptions by the old materializer', async () => {
    const f = await twoAgentProject();
    await withAgentMessageChannels(async () => {
      const ciSubscriptionId = await subscribeToHeadCommit(f);
      const cancelled = okBody<{ subscription: { id: string } }>(
        await f.a.tool('create_project_event_subscription', {
          idempotencyKey: 'pr-209',
          filter: { version: 1, source: 'github', subjectType: 'pull_request', subjectId: '209' },
          requestedDelivery: 'existing_session_prompt',
        })
      );
      okBody(
        await f.a.tool('cancel_project_event_subscription', {
          subscriptionId: cancelled.subscription.id,
        })
      );
      await withQuietAlarms(f, async () => {
        const admitted = await admitCheckRunCompleted(f, 'e2e');
        const now = Date.now();
        const stampedUntil = now + 86_400_000;
        // The pre-fix materializer wrote an open wake's expiry into every wake subscription on
        // the chat. Recreate that, plus an already-cancelled row the migration must not touch.
        await sqlRows(
          f.stub,
          `UPDATE project_event_subscriptions SET delivery_cooldown_until = ? WHERE id IN (?, ?)`,
          stampedUntil,
          ciSubscriptionId,
          cancelled.subscription.id
        );
        expect(await wakeDueAt(f, now)).toBe(stampedUntil);

        await runInDurableObject(f.stub, (_instance, state) => {
          state.storage.sql.exec(
            `DELETE FROM migrations WHERE name = '063-release-event-wake-target-holds'`
          );
          runMigrations(state.storage.sql);
        });

        expect(await subscriptionRow(f, ciSubscriptionId)).toEqual({
          delivery_cooldown_until: null,
          wake_due_at: admitted.matches[0]?.matchedAt,
        });
        expect(await subscriptionRow(f, cancelled.subscription.id)).toMatchObject({
          delivery_cooldown_until: stampedUntil,
        });
        expect(await wakeDueAt(f, now)).toBe(now + 1_000);
        expect(await materialize(f, now + 1_000)).toMatchObject({
          status: 'materialized',
          materialized: 1,
        });
      });
    });
  });
});
