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
import { materialize, withQuietAlarms } from './helpers/event-wake-harness';
import { expectSteeredOnce, mockSteered } from './helpers/steer-wake-harness';

const SHA = '1234567890123456789012345678901234567890';
const OTHER_SHA = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';

describe('terminal CI subscription guidance semantics', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(['check_suite', 'workflow_run', 'check_run'])(
    'wakes for failed %s on the full SHA, with explicit job opt-in',
    async (eventType) => {
      await withAgentMessageChannels(async () => {
        const f = await twoAgentProject();
        const repository = `terminal-ci/${f.projectId}`;
        await env.DATABASE.prepare('UPDATE projects SET repository=? WHERE id=?')
          .bind(repository, f.projectId)
          .run();
        await withQuietAlarms(f, async () => {
          const { subscription } = okBody<{ subscription: { id: string } }>(
            await f.a.tool('create_project_event_subscription', {
              idempotencyKey: 'terminal-ci',
              filter: {
                version: 1,
                source: 'github',
                subjectType: 'commit',
                subjectId: SHA,
                eventType:
                  eventType === 'check_run'
                    ? 'check_run.completed'
                    : ['check_suite.completed', 'workflow_run.completed'],
              },
            })
          );
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
        });
      });
    }
  );
});
