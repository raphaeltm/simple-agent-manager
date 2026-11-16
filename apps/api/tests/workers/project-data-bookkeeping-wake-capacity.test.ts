import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type ChannelReceipt,
  okBody,
  sqlRows,
  twoAgentProject,
  withAgentMessageChannels,
  withProjectDataEnv,
} from './helpers/agent-message-channels';
import { materialize, wakeBatches, withQuietAlarms } from './helpers/event-wake-harness';

afterEach(() => vi.restoreAllMocks());

describe('pending ingest counts at event wake capacity', () => {
  it.each([false, true])(
    'defers a real wake when pending chunks reach the transcript limit (merging=%s)',
    async (enabled) => {
      vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
        enabled,
        maxRowBytes: 65536,
        recentIds: 200,
      });
      const f = await twoAgentProject();
      await withAgentMessageChannels(
        async () => {
          await withProjectDataEnv(f.stub, { MAX_MESSAGES_PER_SESSION: '2' }, async () => {
            okBody<ChannelReceipt>(
              await f.b.tool('send_durable_message', {
                targetTaskId: f.a.taskId,
                message: 'synthetic capacity wake',
                messageClass: 'deliver',
              })
            );
            await withQuietAlarms(f, async () => {
              const source = {
                workspaceId: f.a.workspaceId,
                callbackGeneration: 'capacity-generation',
                outboxIncarnation: 'capacity-outbox',
              };
              for (const sequence of [1, 2])
                expect(
                  await f.stub.persistMessageBatch(
                    f.a.sessionId,
                    [
                      {
                        messageId: `capacity-chunk-${sequence}`,
                        role: 'assistant',
                        content: 'synthetic capacity chunk',
                        toolMetadata: null,
                        timestamp: new Date().toISOString(),
                        sequence,
                      },
                    ],
                    source
                  )
                ).toMatchObject({ persisted: 1 });
              // No eager fold may conceal a capacity reader that ignores pending receipts.
              await runInDurableObject(f.stub, (_instance, state) => {
                expect(
                  state.storage.sql
                    .exec(
                      'SELECT message_count,pending_message_count FROM chat_sessions WHERE id=?',
                      f.a.sessionId
                    )
                    .one()
                ).toMatchObject({ message_count: 0, pending_message_count: 2 });
              });
              expect((await f.stub.getSession(f.a.sessionId))?.messageCount).toBe(2);
              const now = Date.now();
              expect(await materialize(f, now)).toMatchObject({
                status: 'capacity_deferred',
                materialized: 0,
                accepted: [],
              });
              expect(await wakeBatches(f, f.a.sessionId)).toEqual([]);
              const subscriptions = await sqlRows<{ delivery_cooldown_until: number | null }>(
                f.stub,
                'SELECT delivery_cooldown_until FROM project_event_subscriptions WHERE target_session_id=?',
                f.a.sessionId
              );
              expect(subscriptions.length).toBeGreaterThan(0);
              expect(subscriptions.some((row) => Number(row.delivery_cooldown_until) > now)).toBe(
                true
              );
            });
          });
        },
        { MAX_MESSAGES_PER_SESSION: '2' }
      );
    }
  );
});
