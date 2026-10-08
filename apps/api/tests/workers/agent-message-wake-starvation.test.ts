import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  runProjectEventWakeMaterializationBatch,
  selectProjectEventWakeMaterializationCandidates,
} from '../../src/durable-objects/project-data/project-events-materialization';
import {
  computeProjectEventMaterializationAlarmTime,
  recordSchedulerFailure,
} from '../../src/durable-objects/project-data/project-events-scheduler';
import {
  type ChannelReceipt,
  inboxRows,
  okBody,
  sqlRows,
  testEnv,
  twoAgentProject,
  withAgentMessageChannels,
} from './helpers/agent-message-channels';

type Fixture = Awaited<ReturnType<typeof twoAgentProject>>;
const wakeEnv = () => ({ ...testEnv, PROJECT_EVENT_WAKE_ENABLED: 'true' });
const materialize = (f: Fixture, now: number) =>
  runInDurableObject(f.stub, (_instance, state) =>
    state.storage.transactionSync(() =>
      runProjectEventWakeMaterializationBatch(state.storage.sql, wakeEnv(), f.projectId, now)
    )
  );
const due = (f: Fixture, now: number) =>
  runInDurableObject(f.stub, (_instance, state) =>
    computeProjectEventMaterializationAlarmTime(state.storage.sql, wakeEnv(), f.projectId, now)
  );
const send = (from: Fixture['a'], to: Fixture['a'], message: string) =>
  from.tool('send_durable_message', { targetTaskId: to.taskId, message, messageClass: 'notify' });

describe('agent message wake scheduler isolation', () => {
  it('notifies a newly eligible chat while another chat still holds an unacknowledged wake', async () => {
    const f = await twoAgentProject();
    await withAgentMessageChannels(async () => {
      okBody(await send(f.a, f.b, 'first notification remains unacknowledged'));
      const firstAt = Date.now();
      expect(await materialize(f, firstAt)).toMatchObject({ status: 'materialized' });
      okBody(await send(f.a, f.b, 'second notification must wait for the same recipient'));
      // The real default subscription cooldown is 30 seconds. The first wake
      // still has its 24-hour lease: only this target should be deferred.
      const afterCooldown = firstAt + 31_000;
      expect(await materialize(f, afterCooldown)).toMatchObject({ status: 'capacity_deferred' });
      const reply = okBody<ChannelReceipt>(await send(f.b, f.a, 'new work for an eligible chat'));
      expect(await due(f, afterCooldown)).toBe(afterCooldown + 1_000);
      const candidates = await runInDurableObject(f.stub, (_instance, state) =>
        selectProjectEventWakeMaterializationCandidates(
          state.storage.sql,
          wakeEnv(),
          f.projectId,
          afterCooldown
        )
      );
      expect(candidates.map((candidate) => candidate.targetSessionId)).toEqual([f.a.sessionId]);
      expect(await materialize(f, afterCooldown + 1_000)).toMatchObject({
        status: 'materialized',
        materialized: 1,
      });
      const wakes = await inboxRows(f.stub);
      expect(wakes.filter((w) => w.target_session_id === f.b.sessionId)).toHaveLength(1);
      expect(wakes.filter((w) => w.target_session_id === f.a.sessionId)).toEqual([
        expect.objectContaining({ content: expect.stringContaining(reply.eventId) }),
      ]);
      const read = okBody<{ event: { metadata: { message: string }; delivery: { id: string } } }>(
        await f.a.tool('get_event', { eventId: reply.eventId })
      );
      expect(read.event.metadata.message).toBe('new work for an eligible chat');
      expect(
        okBody(await f.a.tool('ack_event_delivery', { deliveryId: read.event.delivery.id }))
      ).toMatchObject({ acknowledged: true });
    });
  });

  it('recovers a pre-upgrade global capacity checkpoint without bypassing real failure backoff', async () => {
    const f = await twoAgentProject();
    await withAgentMessageChannels(async () => {
      okBody(await send(f.a, f.b, 'ready after upgrade'));
      const now = Date.now();
      // Old releases persisted a successful target deferral as a global checkpoint.
      await sqlRows(
        f.stub,
        `INSERT INTO project_event_wake_scheduler_state
        (project_id, next_attempt_at, materialization_failures, retention_failures, updated_at)
        VALUES (?, ?, 0, 0, ?) ON CONFLICT(project_id) DO UPDATE SET
        next_attempt_at = excluded.next_attempt_at, materialization_failures = 0`,
        f.projectId,
        now + 86_400_000,
        now
      );
      expect(await due(f, now)).toBe(now + 1_000);
      await runInDurableObject(f.stub, (_instance, state) =>
        recordSchedulerFailure(
          state.storage.sql,
          wakeEnv(),
          f.projectId,
          'materialization',
          new Error('transient failure'),
          now
        )
      );
      expect(await due(f, now)).toBe(now + 5_000);
      expect(await materialize(f, now + 1_000)).toMatchObject({ status: 'not_due' });
      expect(await inboxRows(f.stub)).toHaveLength(0);
      expect(await materialize(f, now + 5_000)).toMatchObject({ status: 'materialized' });
      expect(await inboxRows(f.stub)).toHaveLength(1);
    });
  });
});
