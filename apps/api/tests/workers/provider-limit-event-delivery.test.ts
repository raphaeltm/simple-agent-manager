import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nudgePromptDeliveriesForTarget } from '../../src/durable-objects/project-data/prompt-delivery';
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
import { materialize, type WakeFixture,withQuietAlarms } from './helpers/event-wake-harness';
import { accepted, deliveryPass, snapshot } from './helpers/steer-wake-harness';

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
  it('removes own credential events from mixed batches while delivering other credentials', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      await withQuietAlarms(f, async () => {
        await testEnv.DATABASE.prepare(
          'UPDATE agent_sessions SET agent_credential_reference=? WHERE id=?'
        )
          .bind('own-credential', f.a.agentSessionId)
          .run();
        const { ids } = await eventBatch(f, ['own-credential', 'another-credential']);
        const submit = vi
          .spyOn(DefaultVmPromptDeliveryAdapter.prototype, 'submit')
          .mockImplementation(async (input) => accepted(input));
        await deliveryPass(f);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(submit.mock.calls[0]![0].claim.message.metadata?.eventIds).toEqual([ids[1]]);
        expect(submit.mock.calls[0]![0].claim.message.content).not.toContain(ids[0]);
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
