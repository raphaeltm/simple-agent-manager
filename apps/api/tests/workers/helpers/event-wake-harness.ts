/**
 * Drives ProjectData event wakes the way the alarm and the prompt-delivery runner do, without
 * a reachable runtime: materialize due wakes, read the wake section's next alarm time, and apply
 * a runtime acceptance through the checkpoint the runner calls. Background alarms are switched
 * off for the object (`withQuietAlarms`) so only the test advances the clock.
 */
import { runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';

import { runProjectEventWakeMaterializationBatch } from '../../../src/durable-objects/project-data/project-events-materialization';
import { computeProjectEventMaterializationAlarmTime } from '../../../src/durable-objects/project-data/project-events-scheduler';
import { advanceProjectEventPromptAttemptCheckpoint } from '../../../src/durable-objects/project-data/project-events-wake-delivery';
import type { PromptDeliveryResult } from '../../../src/durable-objects/project-data/prompt-delivery';
import { parseMailboxMessageRow } from '../../../src/durable-objects/project-data/row-schemas';
import {
  sqlRows,
  testEnv,
  type twoAgentProject,
  withProjectDataEnv,
} from './agent-message-channels';

export type WakeFixture = Awaited<ReturnType<typeof twoAgentProject>>;

export type WakeBatch = {
  id: string;
  subscription_id: string;
  state: string;
  acked_at: number | null;
  event_count: number;
};

export const wakeEnv = () => ({ ...testEnv, PROJECT_EVENT_WAKE_ENABLED: 'true' });

export const materialize = (f: WakeFixture, now: number) =>
  runInDurableObject(f.stub, (_instance, state) =>
    state.storage.transactionSync(() =>
      runProjectEventWakeMaterializationBatch(state.storage.sql, wakeEnv(), f.projectId, now)
    )
  );

/** The wake section's next alarm time, or null when nothing can run. */
export const wakeDueAt = (f: WakeFixture, now: number) =>
  runInDurableObject(f.stub, (_instance, state) =>
    computeProjectEventMaterializationAlarmTime(state.storage.sql, wakeEnv(), f.projectId, now)
  );

export const wakeBatches = (f: WakeFixture, sessionId: string) =>
  sqlRows<WakeBatch>(
    f.stub,
    `SELECT id, subscription_id, state, acked_at, event_count
     FROM project_event_delivery_batches
     WHERE delivery_channel = 'prompt_queue' AND target_session_id = ?
     ORDER BY created_at, id`,
    sessionId
  );

/** The chat's only prompt-queue wake so far. */
export async function onlyWake(f: WakeFixture, sessionId: string): Promise<WakeBatch> {
  const batches = await wakeBatches(f, sessionId);
  expect(batches).toHaveLength(1);
  return batches[0] as WakeBatch;
}

/** Apply a runtime acceptance through the same checkpoint the prompt-delivery runner calls. */
export async function acceptWake(f: WakeFixture, batchId: string, now: number): Promise<void> {
  await runInDurableObject(f.stub, (_instance, state) => {
    const message = parseMailboxMessageRow(
      state.storage.sql.exec('SELECT * FROM session_inbox WHERE id = ?', batchId).toArray()[0]
    );
    const accepted: PromptDeliveryResult = {
      kind: 'accepted',
      acpSessionId: message.targetSessionId,
      promptEpoch: now,
      runtimeIdentity: 'runtime:occupancy',
      capabilities: {
        protocolVersion: 1,
        runtimeIdentity: 'runtime:occupancy',
        promptReceipts: { supported: true, lookup: true, states: ['accepted'] },
        checkpointRollover: {
          supported: false,
          automatic: false,
          states: [],
          defaultGraceMs: 0,
          maxGraceMs: 0,
          operationTimeoutMs: 0,
        },
      },
      receipt: {
        deliveryId: `receipt:${batchId}`,
        state: 'accepted',
        runtimeIdentity: 'runtime:occupancy',
        acceptedAt: now,
        completedAt: null,
      },
    };
    advanceProjectEventPromptAttemptCheckpoint(
      state.storage.sql,
      f.projectId,
      { message, attemptId: `attempt:${batchId}`, mode: 'submit' },
      accepted,
      now
    );
  });
}

/**
 * The MCP send path needs event wakes and durable delivery on. Once setup is done, switch both
 * off for the ProjectData object (Miniflare shares this env with the test worker) so background
 * alarms cannot materialize wakes or deliver them to the seeded, unreachable VM mid-test. The
 * tests drive materialization through `wakeEnv()` and delivery outcomes through `acceptWake`.
 */
export function withQuietAlarms<T>(f: WakeFixture, fn: () => Promise<T>): Promise<T> {
  return withProjectDataEnv(
    f.stub,
    { PROJECT_EVENT_WAKE_ENABLED: 'false', DURABLE_PROMPT_DELIVERY_ENABLED: 'false' },
    fn
  );
}

/**
 * Fire the wake section the way the alarm does: ask the scheduler when it is next due, run the
 * sweep at exactly that time, and repeat until a wake materializes or nothing is due. Returns
 * every time the alarm would have fired, so a sweep that keeps re-arming without work shows up.
 */
export async function fireWakeAlarmsUntilMaterialized(
  f: WakeFixture,
  from: number,
  maxTicks = 4
): Promise<number[]> {
  const fireTimes: number[] = [];
  let clock = from;
  for (let tick = 0; tick < maxTicks; tick++) {
    const dueAt = await wakeDueAt(f, clock);
    if (dueAt === null) break;
    fireTimes.push(dueAt);
    clock = dueAt;
    const result = await materialize(f, clock);
    if (result.status === 'materialized') break;
  }
  return fireTimes;
}
