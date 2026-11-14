/** Producer -> subscription -> durable wake -> real delivery alarm, with only VM HTTP stubbed. */
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { admitGitHubWebhookProjectEvents } from '../../src/services/github-project-event-producer';
import * as svc from '../../src/services/project-data';
import {
  okBody,
  testEnv,
  twoAgentProject,
  withAgentMessageChannels,
} from './helpers/agent-message-channels';
import { materialize, withQuietAlarms } from './helpers/event-wake-harness';
import { expectSteeredOnce, mockSteered } from './helpers/steer-wake-harness';

const SHA = '1234567890123456789012345678901234567890';

describe('CI webhook storage optimization preserves subscriber wakes', () => {
  afterEach(() => vi.restoreAllMocks());
  it('rearms for a newly due wake and leaves an already due wake armed', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      await withQuietAlarms(f, async () => {
        await f.a.tool('create_project_event_subscription', {
          idempotencyKey: 'alarm-control',
          filter: { version: 1, source: 'github', subjectType: 'commit', subjectId: SHA },
        });
        // Establish retention first, so only a new materialization due time can
        // explain the positive alarm call below.
        await svc.admitProjectEvent(testEnv, f.projectId, {
          source: 'github',
          eventType: 'push',
          subject: { type: 'commit', id: 'other' },
          deliveryKey: 'unmatched',
          payloadFingerprint: 'fp',
          metadata: {},
          display: { title: 'push' },
        });
        await runInDurableObject(f.stub, async (instance, state) => {
          const doEnv = (instance as unknown as { env: { PROJECT_EVENT_WAKE_ENABLED?: string } })
            .env;
          const previous = doEnv.PROJECT_EVENT_WAKE_ENABLED;
          doEnv.PROJECT_EVENT_WAKE_ENABLED = 'true';
          const alarm = vi.spyOn(state.storage, 'setAlarm');
          try {
            const event = {
              projectId: f.projectId,
              source: 'github',
              eventType: 'check_run.completed',
              subject: { type: 'commit', id: SHA },
              deliveryKey: 'wake-one',
              payloadFingerprint: 'fp',
              metadata: {},
              display: { title: 'CI' },
            };
            expect(instance.admitProjectEvent(event).matches).toHaveLength(1);
            await vi.waitFor(() => expect(alarm).toHaveBeenCalledTimes(1));
            const armedAt = await state.storage.getAlarm();
            alarm.mockClear();
            expect(
              instance.admitProjectEvent({ ...event, deliveryKey: 'wake-two' }).matches
            ).toHaveLength(1);
            expect(await state.storage.getAlarm()).toBe(armedAt);
            expect(alarm).not.toHaveBeenCalled();
          } finally {
            doEnv.PROJECT_EVENT_WAKE_ENABLED = previous;
            alarm.mockRestore();
            await state.storage.deleteAlarm();
          }
        });
      });
    });
  });

  it.each(['check_run', 'check_suite', 'workflow_run'])(
    'delivers %s through the real producer and preserves no historical replay',
    async (eventType) => {
      await withAgentMessageChannels(async () => {
        const f = await twoAgentProject();
        const repository = `cost-wake/${f.projectId}`;
        await env.DATABASE.prepare('UPDATE projects SET repository=? WHERE id=?')
          .bind(repository, f.projectId)
          .run();
        const payload = {
          action: 'completed',
          repository: { id: 991, full_name: repository },
          sender: { login: 'ci', type: 'Bot' },
          [eventType]: {
            id: 100,
            name: 'CI',
            head_sha: SHA,
            status: 'completed',
            conclusion: 'success',
          },
        };
        await withQuietAlarms(f, async () => {
          // Pin current behavior: an unmatched event remains in admin status, but
          // subscribing later creates no retroactive match or wake.
          const before = await admitGitHubWebhookProjectEvents(testEnv, {
            deliveryId: 'before-subscription',
            eventType,
            payload,
          });
          expect(before.admittedEvents).toEqual([
            expect.objectContaining({ projectId: f.projectId, outcome: 'created' }),
          ]);
          const { subscription } = okBody<{ subscription: { id: string } }>(
            await f.a.tool('create_project_event_subscription', {
              idempotencyKey: 'ci-cost-wake',
              filter: {
                version: 1,
                source: 'github',
                eventType: `${eventType}.completed`,
                subjectType: 'commit',
                subjectId: SHA,
              },
            })
          );
          const initial = okBody<{ events: unknown[] }>(
            await f.a.tool('list_subscription_events', { subscriptionId: subscription.id })
          );
          expect(initial.events).toEqual([]);
          expect(await materialize(f, Date.now())).not.toMatchObject({ status: 'materialized' });

          const admitted = await admitGitHubWebhookProjectEvents(testEnv, {
            deliveryId: 'after-subscription',
            eventType,
            payload,
          });
          expect(admitted.admittedEvents).toEqual([
            expect.objectContaining({ projectId: f.projectId, outcome: 'created' }),
          ]);
          const replay = await admitGitHubWebhookProjectEvents(testEnv, {
            deliveryId: 'after-subscription',
            eventType,
            payload,
          });
          expect(replay.admittedEvents[0]).toMatchObject({
            outcome: 'duplicate_replay',
            eventId: admitted.admittedEvents[0]!.eventId,
          });
          const result = await materialize(f, Date.now());
          expect(result).toMatchObject({ status: 'materialized', materialized: 1 });
          if (result.status !== 'materialized') throw new Error('expected CI wake');
          const batchId = result.accepted[0]!.accepted.message.id;
          await expectSteeredOnce(f, batchId, mockSteered());
          const readable = okBody<{ event: { id: string; eventType: string } }>(
            await f.a.tool('get_event', { eventId: admitted.admittedEvents[0]!.eventId })
          );
          expect(readable.event).toMatchObject({
            id: admitted.admittedEvents[0]!.eventId,
            eventType: `${eventType}.completed`,
          });
          const status = await svc.getProjectEventRecentStatus(testEnv, f.projectId);
          expect(status.events.map((event) => event.id)).toContain(
            before.admittedEvents[0]!.eventId
          );
          expect(status.events.map((event) => event.id)).toContain(
            admitted.admittedEvents[0]!.eventId
          );
          await runInDurableObject(f.stub, (_instance, state) => {
            expect(
              state.storage.sql
                .exec(
                  'SELECT COUNT(*) AS n FROM project_event_matches WHERE subscription_id=?',
                  subscription.id
                )
                .one().n
            ).toBe(1);
          });
        });
      });
    }
  );
});
