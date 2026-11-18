/** Real producer -> MCP subscription -> SQLite materialization -> VM-boundary delivery. */
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { admitGitHubWebhookProjectEvents } from '../../src/services/github-project-event-producer';
import {
  okBody,
  testEnv,
  twoAgentProject,
  withAgentMessageChannels,
} from './helpers/agent-message-channels';
import { materialize, type WakeFixture, withQuietAlarms } from './helpers/event-wake-harness';
import { expectSteeredOnce, mockSteered } from './helpers/steer-wake-harness';

const SHA = '1234567890123456789012345678901234567890';
const OTHER_SHA = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';

async function withCiSubscription(
  eventType: string | string[],
  run: (f: WakeFixture, repository: string, subscription: { id: string }) => Promise<void>
) {
  return withAgentMessageChannels(async () => {
    const f = await twoAgentProject();
    const repository = `terminal-ci/${f.projectId}`;
    await env.DATABASE.prepare('UPDATE projects SET repository=? WHERE id=?')
      .bind(repository, f.projectId)
      .run();
    return withQuietAlarms(f, async () => {
      const { subscription } = okBody<{ subscription: { id: string } }>(
        await f.a.tool('create_project_event_subscription', {
          idempotencyKey: 'terminal-ci',
          filter: {
            version: 1,
            source: 'github',
            subjectType: 'commit',
            subjectId: SHA,
            eventType,
          },
        })
      );
      return run(f, repository, subscription);
    });
  });
}

describe('terminal CI subscription guidance semantics', () => {
  afterEach(() => vi.restoreAllMocks());
  it('keeps one subscription active for two workflows on the same SHA and wakes twice', async () => {
    await withCiSubscription(
      ['check_suite.completed', 'workflow_run.completed'],
      async (f, repository, subscription) => {
        const publish = (id: number, name: string, action: string, conclusion: string | null) =>
          admitGitHubWebhookProjectEvents(testEnv, {
            deliveryId: `${id}-${action}`,
            eventType: 'workflow_run',
            payload: {
              action,
              repository: { id: 991, full_name: repository },
              workflow_run: {
                id,
                name,
                head_sha: SHA,
                run_attempt: 1,
                status: action === 'completed' ? 'completed' : 'in_progress',
                conclusion,
              },
            },
          });
        // CI is still running when a separate workflow finishes. A first terminal
        // wake cannot certify all required checks; only that workflow is readable.
        await publish(201, 'CI', 'in_progress', null);
        expect(await materialize(f, Date.now())).not.toMatchObject({ status: 'materialized' });
        const first = await publish(202, 'CodeRabbit request', 'completed', 'success');
        const firstWake = await materialize(f, Date.now());
        expect(firstWake).toMatchObject({ status: 'materialized', materialized: 1 });
        if (firstWake.status !== 'materialized') throw new Error('expected first workflow wake');
        const steer = mockSteered();
        const firstBatchId = firstWake.accepted[0]!.accepted.message.id;
        await expectSteeredOnce(f, firstBatchId, steer);
        const firstRead = okBody<{ event: { metadata: unknown } }>(
          await f.a.tool('get_event', { eventId: first.admittedEvents[0]!.eventId })
        );
        expect(firstRead.event.metadata).toMatchObject({
          workflowRun: { id: '202', name: 'CodeRabbit request', conclusion: 'success' },
        });
        expect(
          okBody<{ events: unknown[] }>(
            await f.a.tool('list_subscription_events', {
              subscriptionId: subscription.id,
            })
          ).events
        ).toHaveLength(1);
        okBody(await f.a.tool('ack_event_delivery', { deliveryId: firstBatchId }));
        expect(
          okBody<{ subscription: unknown }>(
            await f.a.tool('get_project_event_subscription', {
              subscriptionId: subscription.id,
            })
          ).subscription
        ).toMatchObject({ id: subscription.id, state: 'active' });

        // Separate completions arrive after the platform's 30-second cooldown.
        // Advance a fixture-owned clock, without deriving timing from the scheduler.
        const nextNow = Date.now() + 60_000;
        vi.spyOn(Date, 'now').mockReturnValue(nextNow);
        const second = await publish(201, 'CI', 'completed', 'failure');
        const secondWake = await materialize(f, nextNow);
        expect(secondWake).toMatchObject({ status: 'materialized', materialized: 1 });
        if (secondWake.status !== 'materialized') throw new Error('expected second workflow wake');
        const secondBatchId = secondWake.accepted[0]!.accepted.message.id;
        expect(secondBatchId).not.toBe(firstBatchId);
        steer.mockClear();
        await expectSteeredOnce(f, secondBatchId, steer);
        const secondRead = okBody<{ event: { metadata: unknown } }>(
          await f.a.tool('get_event', { eventId: second.admittedEvents[0]!.eventId })
        );
        expect(secondRead.event.metadata).toMatchObject({
          workflowRun: { id: '201', name: 'CI', conclusion: 'failure' },
        });
        expect(
          okBody<{ subscriptions: unknown[] }>(
            await f.a.tool('list_project_event_subscriptions', {
              state: 'any',
            })
          ).subscriptions
        ).toEqual([expect.objectContaining({ id: subscription.id, state: 'active' })]);
        expect(
          okBody<{ events: unknown[] }>(
            await f.a.tool('list_subscription_events', {
              subscriptionId: subscription.id,
            })
          ).events
        ).toHaveLength(2);
      }
    );
  });
  it.each(['check_suite', 'workflow_run', 'check_run'])(
    'wakes for failed %s on the full SHA, with explicit job opt-in',
    async (eventType) => {
      await withCiSubscription(
        eventType === 'check_run'
          ? 'check_run.completed'
          : ['check_suite.completed', 'workflow_run.completed'],
        async (f, repository, subscription) => {
          const deliver = (type: string, sha: string, deliveryId: string) =>
            admitGitHubWebhookProjectEvents(testEnv, {
              deliveryId,
              eventType: type,
              payload: {
                action: 'completed',
                repository: { id: 991, full_name: repository },
                sender: { login: 'ci-app', type: 'Bot' },
                [type]: {
                  id: 100,
                  head_sha: sha,
                  status: 'completed',
                  conclusion: 'failure',
                  app: { slug: 'external-check-app' },
                  run_attempt: 2,
                },
              },
            });
          // A wrong head never wakes; the terminal default ignores individual jobs.
          // Conversely the explicit job subscription ignores summary events.
          await deliver(eventType, OTHER_SHA, 'wrong-head');
          await deliver(
            eventType === 'check_run' ? 'check_suite' : 'check_run',
            SHA,
            'excluded-type'
          );
          expect(
            okBody<{ events: unknown[] }>(
              await f.a.tool('list_subscription_events', {
                subscriptionId: subscription.id,
              })
            ).events
          ).toEqual([]);
          expect(await materialize(f, Date.now())).not.toMatchObject({ status: 'materialized' });

          const admitted = await deliver(eventType, SHA, 'matching-failure');
          const result = await materialize(f, Date.now());
          expect(result).toMatchObject({ status: 'materialized', materialized: 1 });
          if (result.status !== 'materialized') throw new Error('expected terminal CI wake');
          await expectSteeredOnce(f, result.accepted[0]!.accepted.message.id, mockSteered());
          const { event } = okBody<{
            event: { eventType: string; subject: unknown; metadata: Record<string, unknown> };
          }>(await f.a.tool('get_event', { eventId: admitted.admittedEvents[0]!.eventId }));
          expect(event).toMatchObject({
            eventType: `${eventType}.completed`,
            subject: { type: 'commit', id: SHA },
          });
          const metadataKey = {
            check_suite: 'checkSuite',
            workflow_run: 'workflowRun',
            check_run: 'checkRun',
          }[eventType]!;
          expect(event.metadata[metadataKey]).toMatchObject({
            status: 'completed',
            conclusion: 'failure',
            headSha: SHA,
          });
        }
      );
    }
  );
});
