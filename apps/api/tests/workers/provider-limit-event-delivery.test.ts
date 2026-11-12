import { nudgePromptDeliveriesForTarget } from '@simple-agent-manager/project-data/internal/do/prompt-delivery';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as svc from '../../src/services/project-data';
import { newProviderLimitWait } from '../../src/services/provider-limit-policy';
import { DefaultVmPromptDeliveryAdapter } from '../../src/services/vm-prompt-delivery-adapter';
import {
  okBody,
  sqlRows,
  testEnv,
  twoAgentProject,
  withAgentMessageChannels as withChannels,
} from './helpers/agent-message-channels';
import { materialize, type WakeFixture, withQuietAlarms } from './helpers/event-wake-harness';
import { seedTask } from './helpers/seed-d1';
import { accepted, capabilities, deliveryPass, snapshot } from './helpers/steer-wake-harness';

const withAgentMessageChannels = (fn: () => Promise<void>) =>
  withChannels(fn, { PROJECT_EVENT_WAKE_PROMPT_TTL_MS: String(10 * 60_000) });

async function eventBatch(
  f: WakeFixture,
  subjects = ['another-credential'],
  expiresAt = Date.now() + 6 * 60 * 60_000
) {
  okBody(
    await f.a.tool('create_project_event_subscription', {
      idempotencyKey: 'limit-events',
      filter: { version: 1, subjectType: 'credential' },
      requestedDelivery: 'existing_session_prompt',
      expiresAt,
    })
  );
  const ids: string[] = [];
  for (const subject of subjects) {
    const event = await svc.admitProjectEvent(testEnv, f.projectId, {
      source: 'platform',
      eventType: 'credential.limit.rejected',
      subject: { type: 'credential', id: subject },
      severity: 'warning',
      deliveryKey: crypto.randomUUID(),
      payloadFingerprint: 'sha256:limit',
      metadata: {},
      display: { title: 'Provider rejected a prompt' },
      occurredAt: Date.now(),
      receivedAt: Date.now(),
    });
    ids.push(event.event.id);
  }
  const result = await materialize(f, Date.now());
  expect(result.accepted).toHaveLength(1);
  return { batchId: result.accepted[0]!.accepted.message.id, ids };
}
async function nudge(f: WakeFixture) {
  await runInDurableObject(f.stub, (_i, state) => {
    nudgePromptDeliveriesForTarget(state.storage.sql, f.a.sessionId);
  });
}
async function wait(f: WakeFixture, phase: 'waiting' | 'blocked') {
  const value = newProviderLimitWait({
    taskId: f.a.taskId,
    origin: 'callback',
    incidentId: 'limit',
    credentialKey: 'own-credential',
    previous: null,
    now: Date.now(),
    resetsAt: Date.now() + 2 * 60 * 60_000,
    jitter: 0,
  });
  value.phase = phase;
  await testEnv.DATABASE.prepare('UPDATE tasks SET provider_limit_wait_json=? WHERE id=?')
    .bind(JSON.stringify(value), f.a.taskId)
    .run();
  return value;
}

describe('provider-limited project event deliveries through the real alarm', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  for (const phase of ['waiting', 'blocked'] as const)
    it(`defers ${phase} beyond transport TTL and delivers once after release`, async () => {
      await withAgentMessageChannels(async () => {
        const f = await twoAgentProject();
        await withQuietAlarms(f, async () => {
          const value = await wait(f, phase);
          const { batchId } = await eventBatch(f);
          const submit = vi
            .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit')
            .mockImplementation(async (input) => accepted(input));
          const steer = vi.spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'steer');
          await deliveryPass(f);
          expect(submit).not.toHaveBeenCalled();
          expect(steer).not.toHaveBeenCalled();
          expect(await snapshot(f, batchId)).toMatchObject({
            inbox: { delivery_state: 'retry_wait' },
            batch: { state: 'pending' },
          });
          const actualNow = Date.now();
          vi.spyOn(Date, 'now').mockReturnValue(actualNow + 2 * 60 * 60_000);
          await nudge(f);
          await deliveryPass(f);
          expect(submit).not.toHaveBeenCalled();
          expect(await snapshot(f, batchId)).toMatchObject({ batch: { state: 'pending' } });
          await testEnv.DATABASE.prepare('UPDATE tasks SET provider_limit_wait_json=? WHERE id=?')
            .bind(JSON.stringify({ ...value, phase: 'released' }), f.a.taskId)
            .run();
          await nudge(f);
          await deliveryPass(f);
          expect(submit).toHaveBeenCalledTimes(1);
          expect(await snapshot(f, batchId)).toMatchObject({ batch: { state: 'delivered' } });
          await deliveryPass(f);
          expect(submit).toHaveBeenCalledTimes(1);
        });
      });
    });
  it('defers a legacy subscription when a recovery successor owns the provider-limited chat', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      await withQuietAlarms(f, async () => {
        const { batchId } = await eventBatch(f);
        const sourceTaskId = f.a.taskId;
        const successorTaskId = `recovery-${crypto.randomUUID()}`;
        await testEnv.DATABASE.prepare('UPDATE tasks SET chat_session_id=NULL WHERE id=?')
          .bind(sourceTaskId)
          .run();
        await seedTask(successorTaskId, f.projectId, f.a.userId, {
          chatSessionId: f.a.sessionId,
          workspaceId: f.a.workspaceId,
          status: 'in_progress',
          recoverySourceTaskId: sourceTaskId,
          triggeredBy: 'session-recovery',
        });
        await testEnv.DATABASE.prepare(
          "UPDATE tasks SET chat_session_id=NULL, status='cancelled', superseded_by_task_id=? WHERE id=?"
        )
          .bind(successorTaskId, sourceTaskId)
          .run();
        const successor = { ...f, a: { ...f.a, taskId: successorTaskId } };
        const value = await wait(successor, 'waiting');
        const submit = vi
          .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit')
          .mockImplementation(async (input) => accepted(input));
        await deliveryPass(f);
        expect(submit).not.toHaveBeenCalled();
        expect(
          await sqlRows(f.stub, 'SELECT last_error FROM session_inbox WHERE id=?', batchId)
        ).toEqual([
          { last_error: 'Project events deferred until provider limit wait is released' },
        ]);
        expect(await snapshot(f, batchId)).toMatchObject({
          inbox: { delivery_state: 'retry_wait' },
          batch: { state: 'pending' },
        });
        await testEnv.DATABASE.prepare('UPDATE tasks SET provider_limit_wait_json=? WHERE id=?')
          .bind(JSON.stringify({ ...value, phase: 'released' }), successorTaskId)
          .run();
        await nudge(f);
        await deliveryPass(f);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(submit.mock.calls[0]![0].claim.message.sourceTaskId).toBe(sourceTaskId);
      });
    });
  });
  it('removes own credential events from mixed batches while delivering other credentials', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      await withQuietAlarms(f, async () => {
        await testEnv.DATABASE.prepare(
          'UPDATE agent_sessions SET agent_credential_reference=? WHERE id=?'
        )
          .bind('own-credential', f.a.agentSessionId)
          .run();
        const { ids, batchId } = await eventBatch(f, ['own-credential', 'another-credential']);
        const transcriptBefore = await sqlRows<{ content: string }>(
          f.stub,
          'SELECT content FROM chat_messages WHERE id=(SELECT prompt_message_id FROM session_inbox WHERE id=?)',
          batchId
        );
        expect(transcriptBefore[0]!.content).toContain(ids[0]);
        expect(transcriptBefore[0]!.content).toContain(ids[1]);
        const noticeOf = async () => {
          const [row] = await sqlRows<{ tool_metadata: string }>(
            f.stub,
            'SELECT tool_metadata FROM chat_messages WHERE id=(SELECT prompt_message_id FROM session_inbox WHERE id=?)',
            batchId
          );
          return JSON.parse(row!.tool_metadata).samNotice as {
            headline: string;
            refs: { id: string }[];
          };
        };
        const noticeBefore = await noticeOf();
        expect(noticeBefore.headline).toBe('2 project updates');
        expect(noticeBefore.refs.map((ref) => ref.id)).toEqual(ids);
        const submit = vi
          .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit')
          .mockImplementation(async (input) => accepted(input));
        await deliveryPass(f);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(submit.mock.calls[0]![0].claim.message.metadata?.eventIds).toEqual([ids[1]]);
        expect(submit.mock.calls[0]![0].claim.message.content).not.toContain(ids[0]);
        const transcriptAfter = await sqlRows<{ content: string; tool_metadata: string }>(
          f.stub,
          'SELECT content, tool_metadata FROM chat_messages WHERE id=(SELECT prompt_message_id FROM session_inbox WHERE id=?)',
          batchId
        );
        expect(transcriptAfter[0]!.content).toBe(transcriptBefore[0]!.content);
        expect(JSON.parse(transcriptAfter[0]!.tool_metadata)).toMatchObject({
          eventIds: [ids[1]],
          eventCount: 1,
        });
        // The chat notice describes the batch the agent got, not the one first accepted.
        const noticeAfter = await noticeOf();
        expect(noticeAfter.headline).not.toBe('2 project updates');
        expect(noticeAfter.refs.map((ref) => ref.id)).toEqual([ids[1]]);
        const inboxAfter = await sqlRows<{ content: string; metadata: string }>(
          f.stub,
          'SELECT content, metadata FROM session_inbox WHERE id=?',
          batchId
        );
        expect(inboxAfter[0]!.content).toBe(submit.mock.calls[0]![0].claim.message.content);
        expect(JSON.parse(inboxAfter[0]!.metadata)).toMatchObject({
          eventIds: [ids[1]],
          eventCount: 1,
        });
        await deliveryPass(f);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(
          await sqlRows(
            f.stub,
            'SELECT content FROM chat_messages WHERE id=(SELECT prompt_message_id FROM session_inbox WHERE id=?)',
            batchId
          )
        ).toEqual(transcriptBefore);
        expect(
          await sqlRows(
            f.stub,
            'SELECT event_count FROM project_event_delivery_batches WHERE id=?',
            submit.mock.calls[0]![0].claim.message.id
          )
        ).toEqual([{ event_count: 1 }]);
      });
    });
  });
  it('reconciles a previously submitted receipt without rewriting its event payload or transcript', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      await withQuietAlarms(f, async () => {
        await testEnv.DATABASE.prepare(
          'UPDATE agent_sessions SET agent_credential_reference=? WHERE id=?'
        )
          .bind('own-credential', f.a.agentSessionId)
          .run();
        const { ids, batchId } = await eventBatch(f, ['own-credential', 'another-credential']);
        const before = await sqlRows(
          f.stub,
          'SELECT content, metadata FROM session_inbox WHERE id=?',
          batchId
        );
        const transcript = await sqlRows(
          f.stub,
          'SELECT content, tool_metadata FROM chat_messages WHERE id=(SELECT prompt_message_id FROM session_inbox WHERE id=?)',
          batchId
        );
        // The runtime accepted this old payload, but its worker died after persisting submission.
        await runInDurableObject(f.stub, (_i, state) => {
          state.storage.sql.exec(
            `UPDATE session_inbox SET delivery_state='delivering', prompt_delivery_phase='submitting',
            attempt_id='lost-submission', attempt_started_at=0, last_delivery_at=0,
            delivery_attempts=1, runtime_identity='runtime', adapter_protocol_version=1, receipt_supported=1 WHERE id=?`,
            batchId
          );
        });
        const submit = vi.spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit');
        const reconcile = vi
          .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'reconcile')
          .mockImplementation(async (input) => {
            expect(input.claim.mode).toBe('reconcile');
            expect(input.claim.message.metadata?.eventIds).toEqual(ids);
            return {
              kind: 'accepted',
              acpSessionId: f.a.agentSessionId,
              promptEpoch: Date.now(),
              runtimeIdentity: 'runtime',
              capabilities,
              receipt: {
                deliveryId: batchId,
                state: 'accepted',
                runtimeIdentity: 'runtime',
                acceptedAt: Date.now(),
                completedAt: null,
              },
            };
          });
        await deliveryPass(f);
        expect(reconcile).toHaveBeenCalledTimes(1);
        expect(submit).not.toHaveBeenCalled();
        expect(await snapshot(f, batchId)).toMatchObject({ batch: { state: 'delivered' } });
        expect(
          await sqlRows(f.stub, 'SELECT content, metadata FROM session_inbox WHERE id=?', batchId)
        ).toEqual(before);
        expect(
          await sqlRows(
            f.stub,
            'SELECT content, tool_metadata FROM chat_messages WHERE id=(SELECT prompt_message_id FROM session_inbox WHERE id=?)',
            batchId
          )
        ).toEqual(transcript);
      });
    });
  });
  it('honors explicit subscription expiry while a provider wait is blocked', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      await withQuietAlarms(f, async () => {
        await wait(f, 'blocked');
        const { batchId } = await eventBatch(f, ['another-credential'], Date.now() + 60_000);
        const submit = vi.spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit');
        await deliveryPass(f);
        const actualNow = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(actualNow + 120_000);
        await nudge(f);
        await deliveryPass(f);
        expect(submit).not.toHaveBeenCalled();
        expect(await snapshot(f, batchId)).toMatchObject({ inbox: { delivery_state: 'expired' } });
      });
    });
  });
  it('suppresses queued self-notices after resume changes the active credential', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      await withQuietAlarms(f, async () => {
        const value = await wait(f, 'waiting');
        const { batchId } = await eventBatch(f, ['own-credential']);
        await testEnv.DATABASE.prepare('UPDATE tasks SET provider_limit_wait_json=? WHERE id=?')
          .bind(JSON.stringify({ ...value, phase: 'released' }), f.a.taskId)
          .run();
        await testEnv.DATABASE.prepare(
          'UPDATE agent_sessions SET agent_credential_reference=? WHERE id=?'
        )
          .bind('replacement-credential', f.a.agentSessionId)
          .run();
        const submit = vi.spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit');
        await deliveryPass(f);
        expect(submit).not.toHaveBeenCalled();
        expect(
          await sqlRows(f.stub, 'SELECT last_error FROM session_inbox WHERE id=?', batchId)
        ).toEqual([
          {
            last_error: 'Own credential limit events are recorded without prompting their session',
          },
        ]);
      });
    });
  });
  it('never prompts for an own credential event using retained wait identity after parking', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      await withQuietAlarms(f, async () => {
        const value = await wait(f, 'waiting');
        await testEnv.DATABASE.prepare(
          'UPDATE tasks SET provider_limit_wait_json=?, workspace_id=NULL WHERE id=?'
        )
          .bind(JSON.stringify({ ...value, phase: 'released' }), f.a.taskId)
          .run();
        const { batchId } = await eventBatch(f, ['own-credential']);
        const submit = vi.spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit');
        await deliveryPass(f);
        expect(submit).not.toHaveBeenCalled();
        expect(await snapshot(f, batchId)).toMatchObject({ inbox: { delivery_state: 'failed' } });
        expect(
          await sqlRows(f.stub, 'SELECT last_error FROM session_inbox WHERE id=?', batchId)
        ).toEqual([
          {
            last_error: 'Own credential limit events are recorded without prompting their session',
          },
        ]);
      });
    });
  });
});
