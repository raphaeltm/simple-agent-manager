/** Real MCP admission -> real transactional materializer and scheduler, with workerd counters. */
import { runProjectEventWakeMaterializationBatch } from '@simple-agent-manager/project-data/internal/do/project-events-materialization';
import { RowUsage } from '@simple-agent-manager/project-data/internal/do/row-usage';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  okBody,
  sqlRows,
  testEnv,
  twoAgentProject,
  withAgentMessageChannels,
} from './helpers/agent-message-channels';
import {
  acceptWake,
  fireWakeAlarmsUntilMaterialized,
  materialize,
  retryWakeBehindBusyTurn,
  wakeBatches,
  wakeDueAt,
  wakeEnv,
  type WakeFixture,
  withQuietAlarms,
} from './helpers/event-wake-harness';

const CHANNEL = 'wake-budget';

async function publish(f: WakeFixture, key: string) {
  return okBody(
    await f.b.tool('publish_channel_event', {
      channel: CHANNEL,
      message: key,
      idempotencyKey: key,
    })
  );
}

async function follow(f: WakeFixture) {
  await publish(f, 'create-channel');
  return okBody<{ result: { subscription: { id: string } } }>(
    await f.a.tool('follow_event_channel', {
      channel: CHANNEL,
      idempotencyKey: 'follow',
      requestedDelivery: 'runtime_steer',
      minWakeIntervalSeconds: 60,
    })
  ).result.subscription.id;
}

async function dueRow(f: WakeFixture, id: string) {
  return (
    await sqlRows<{ wake_due_at: number | null; delivery_cooldown_until: number | null }>(
      f.stub,
      'SELECT wake_due_at, delivery_cooldown_until FROM project_event_subscriptions WHERE id = ?',
      id
    )
  )[0];
}

/** Meter exactly the production core, excluding setup, finalizer and native alarm writes. */
async function measuredPass(f: WakeFixture, now: number) {
  return runInDurableObject(f.stub, (_instance, state) => {
    const usage = new RowUsage(() => f.projectId);
    const cursors: SqlStorageCursor[] = [];
    const real = state.storage.sql;
    const observed = new Proxy(real, {
      get(target, key) {
        if (key !== 'exec') return Reflect.get(target, key, target);
        return (query: string, ...bindings: unknown[]) => {
          const cursor = target.exec(query, ...bindings);
          cursors.push(cursor);
          return cursor;
        };
      },
    });
    const log = vi.spyOn(console, 'log');
    try {
      const result = usage.run('alarm:project_event_wake_materialization', () =>
        state.storage.transactionSync(() =>
          runProjectEventWakeMaterializationBatch(usage.sql(observed), wakeEnv(), f.projectId, now)
        )
      );
      usage.flush(Date.now() + 3_600_000);
      const emitted = log.mock.calls
        .map(([line]) => JSON.parse(String(line)))
        .find((line) => line.event === 'project_data.row_usage');
      const labels = Object.values(emitted.labels) as Array<{ label: string; rowsWritten: number }>;
      const billed = cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0);
      expect(
        labels.find((label) => label.label === 'alarm:project_event_wake_materialization')
          ?.rowsWritten
      ).toBe(billed);
      return { result, billed };
    } finally {
      log.mockRestore();
    }
  });
}

afterEach(() => vi.restoreAllMocks());

describe('project-event materializer write budget', () => {
  it.each([1, 8, 20])('uses 55 fixed + 6/event SQL writes for %i events', async (count) => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      await withQuietAlarms(f, async () => {
        const id = await follow(f);
        for (let index = 0; index < count; index++) await publish(f, `event-${index}`);
        const now = Date.now();
        const before = await dueRow(f, id);
        expect(before?.wake_due_at).toBeTypeOf('number');
        const { result, billed } = await measuredPass(f, now);
        expect(result).toMatchObject({ status: 'materialized', materialized: count });
        // Main's measured budget was 63+6N, including two identical 8-write refreshes.
        expect(billed).toBe(55 + 6 * count);
        expect(await dueRow(f, id)).toEqual({
          wake_due_at: null,
          delivery_cooldown_until: now + 60_000,
        });
        expect(await wakeDueAt(f, now)).toBeNull();
        expect(await wakeBatches(f, f.a.sessionId)).toEqual([
          expect.objectContaining({ subscription_id: id, event_count: count, state: 'pending' }),
        ]);
      });
    });
  });

  it('preserves exact scheduler fire times across split batches, busy retry and cooldown', async () => {
    await withAgentMessageChannels(async () => {
      const f = await twoAgentProject();
      await withQuietAlarms(f, async () => {
        const id = await follow(f);
        for (let n = 0; n < 3; n++) await publish(f, `split-${n}`);
        const t0 = Date.now();
        // A deliberately small production batch limit leaves real matches behind the claim.
        const previous = wakeEnv().PROJECT_EVENT_DELIVERY_BATCH_MAX_EVENTS;
        testEnv.PROJECT_EVENT_DELIVERY_BATCH_MAX_EVENTS = '2';
        try {
          const initialDue = (await dueRow(f, id))!.wake_due_at;
          expect(initialDue).toBeTypeOf('number');
          expect(await fireWakeAlarmsUntilMaterialized(f, t0)).toEqual([t0 + 1_000]);
          const first = (await wakeBatches(f, f.a.sessionId))[0]!;
          expect(first.event_count).toBe(2);
          const remainingDue = (await dueRow(f, id))!.wake_due_at;
          expect(remainingDue).toBeTypeOf('number');
          // Pending delivery owns occupancy; a busy retry cannot create another batch.
          await retryWakeBehindBusyTurn(f, first.id, t0 + 2_000);
          expect(await wakeDueAt(f, t0 + 3_000)).toBeNull();
          expect(await materialize(f, t0 + 3_000)).toMatchObject({ status: 'no_due_work' });
          expect(await wakeBatches(f, f.a.sessionId)).toHaveLength(1);
          await acceptWake(f, first.id, t0 + 5_000);
          expect(await dueRow(f, id)).toEqual({
            wake_due_at: remainingDue,
            delivery_cooldown_until: t0 + 65_000,
          });
          expect(await fireWakeAlarmsUntilMaterialized(f, t0 + 6_000)).toEqual([t0 + 65_000]);
          const second = (await wakeBatches(f, f.a.sessionId))[1]!;
          expect(second.event_count).toBe(1);
          expect((await dueRow(f, id))!.wake_due_at).toBeNull();
          await acceptWake(f, second.id, t0 + 66_000);
          expect(await fireWakeAlarmsUntilMaterialized(f, t0 + 67_000)).toEqual([]);
          await publish(f, 'later');
          expect(await fireWakeAlarmsUntilMaterialized(f, t0 + 68_000)).toEqual([t0 + 126_000]);
          const third = (await wakeBatches(f, f.a.sessionId))[2]!;
          await acceptWake(f, third.id, t0 + 127_000);
          expect(
            (await wakeBatches(f, f.a.sessionId)).map((batch) => [batch.state, batch.event_count])
          ).toEqual([
            ['delivered', 2],
            ['delivered', 1],
            ['delivered', 1],
          ]);
          expect(await wakeDueAt(f, t0 + 128_000)).toBeNull();
        } finally {
          if (previous === undefined) delete testEnv.PROJECT_EVENT_DELIVERY_BATCH_MAX_EVENTS;
          else testEnv.PROJECT_EVENT_DELIVERY_BATCH_MAX_EVENTS = previous;
        }
      });
    });
  });
});
