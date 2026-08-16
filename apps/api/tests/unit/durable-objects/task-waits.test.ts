import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import type { TaskWaitConfig } from '../../../src/durable-objects/project-data/task-wait-config';
import {
  cancelTaskWait,
  computeTaskWaitAlarmTime,
  createTaskWait,
  decideTaskWait,
  getTaskWait,
  prepareTaskWaitWake,
  recordTaskWaitObservations,
  recordTaskWaitWakeFailure,
  resolveTaskWait,
} from '../../../src/durable-objects/project-data/task-waits';
import { createSqlStorage } from './sql-storage-test-utils';

const config: TaskWaitConfig = {
  reconcileIntervalMs: 30_000,
  maxChildren: 3,
  maxActivePerProject: 2,
  maxDurationMs: 86_400_000,
  maxCandidatesPerAlarm: 10,
};

describe('durable task waits', () => {
  let db: Database.Database;
  let sql: SqlStorage;

  beforeEach(() => {
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
  });

  afterEach(() => db.close());

  function create(overrides: Partial<Parameters<typeof createTaskWait>[2]> = {}) {
    return createTaskWait(
      sql,
      config,
      {
        id: 'wait-1',
        parentTaskId: 'parent-1',
        parentSessionId: 'session-1',
        condition: 'all',
        childTaskIds: ['child-2', 'child-1'],
        wakeDeadline: 100_000,
        wakeDeliveryId: 'delivery-1',
        ...overrides,
      },
      1_000
    );
  }

  it('creates one sorted, idempotent active subscription per parent', () => {
    const first = create();
    const duplicate = create({ id: 'wait-duplicate', wakeDeliveryId: 'delivery-duplicate' });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.subscription.id).toBe('wait-1');
    expect(duplicate.subscription.children.map((child) => child.childTaskId)).toEqual([
      'child-1',
      'child-2',
    ]);
    expect(computeTaskWaitAlarmTime(sql)).toBe(1_000);
  });

  it('keeps registration idempotent after resolution and freezes wake content', () => {
    const first = create({ idempotencyKey: 'review-round-1' });
    const prepared = prepareTaskWaitWake(
      sql,
      first.subscription.id,
      'deadline_reached',
      'immutable wake A',
      2_000
    );
    expect(prepared?.wakeContent).toBe('immutable wake A');
    expect(
      prepareTaskWaitWake(sql, first.subscription.id, 'condition_met', 'mutable wake B', 3_000)
        ?.wakeContent
    ).toBe('immutable wake A');
    expect(resolveTaskWait(sql, first.subscription.id, 'deadline_reached', 4_000)).toBe(true);

    const retry = create({
      id: 'wait-retry',
      idempotencyKey: 'review-round-1',
      wakeDeliveryId: 'delivery-retry',
      wakeDeadline: 200_000,
    });
    expect(retry.created).toBe(false);
    expect(retry.subscription.id).toBe(first.subscription.id);
    expect(retry.subscription.wakeDeliveryId).toBe('delivery-1');
  });

  it('rejects a conflicting active subscription and configured limit breaches', () => {
    create();
    expect(() =>
      create({ id: 'wait-other', wakeDeliveryId: 'delivery-other', condition: 'any' })
    ).toThrow('different active wait subscription');
    expect(() =>
      create({
        id: 'wait-too-many',
        parentTaskId: 'parent-2',
        wakeDeliveryId: 'delivery-too-many',
        childTaskIds: ['one', 'two', 'three', 'four'],
      })
    ).toThrow('child limit reached');
  });

  it('evaluates all/any conditions from normalized terminal observations', () => {
    create();
    const oneTerminal = recordTaskWaitObservations(
      sql,
      'wait-1',
      new Map([
        [
          'child-1',
          {
            taskId: 'child-1',
            status: 'completed',
            outputSummary: null,
            outputPrUrl: null,
            errorMessage: null,
          },
        ],
        [
          'child-2',
          {
            taskId: 'child-2',
            status: 'in_progress',
            outputSummary: null,
            outputPrUrl: null,
            errorMessage: null,
          },
        ],
      ]),
      2_000,
      32_000
    );
    expect(decideTaskWait(oneTerminal!, 2_000)).toEqual({ action: 'pending' });

    const allTerminal = recordTaskWaitObservations(
      sql,
      'wait-1',
      new Map([
        [
          'child-1',
          {
            taskId: 'child-1',
            status: 'completed',
            outputSummary: null,
            outputPrUrl: null,
            errorMessage: null,
          },
        ],
        [
          'child-2',
          {
            taskId: 'child-2',
            status: 'failed',
            outputSummary: null,
            outputPrUrl: null,
            errorMessage: null,
          },
        ],
      ]),
      3_000,
      33_000
    );
    expect(decideTaskWait(allTerminal!, 3_000)).toEqual({
      action: 'wake',
      reason: 'condition_met',
    });

    const any = createTaskWait(
      sql,
      config,
      {
        id: 'wait-any',
        parentTaskId: 'parent-any',
        parentSessionId: 'session-any',
        condition: 'any',
        childTaskIds: ['child-a', 'child-b'],
        wakeDeadline: 100_000,
        wakeDeliveryId: 'delivery-any',
      },
      4_000
    ).subscription;
    const missing = recordTaskWaitObservations(
      sql,
      any.id,
      new Map([
        [
          'child-b',
          {
            taskId: 'child-b',
            status: 'in_progress',
            outputSummary: null,
            outputPrUrl: null,
            errorMessage: null,
          },
        ],
      ]),
      5_000,
      35_000
    );
    expect(decideTaskWait(missing!, 5_000)).toEqual({
      action: 'wake',
      reason: 'condition_met',
    });
  });

  it('uses a finite deadline and terminal CAS transitions', () => {
    create();
    const subscription = getTaskWait(sql, 'wait-1')!;
    expect(decideTaskWait(subscription, 100_000)).toEqual({
      action: 'wake',
      reason: 'deadline_reached',
    });
    expect(resolveTaskWait(sql, 'wait-1', 'deadline_reached', 100_000)).toBe(true);
    expect(resolveTaskWait(sql, 'wait-1', 'duplicate', 100_001)).toBe(false);
    expect(getTaskWait(sql, 'wait-1')).toMatchObject({
      state: 'resolved',
      resolutionReason: 'deadline_reached',
    });

    create({
      id: 'wait-cancel',
      parentTaskId: 'parent-cancel',
      wakeDeliveryId: 'delivery-cancel',
    });
    expect(cancelTaskWait(sql, 'wait-cancel', 'parent_terminal', 101_000)).toBe(true);
    expect(getTaskWait(sql, 'wait-cancel')?.state).toBe('cancelled');
  });

  it('backs off failed expired wakes and cancels after the maximum attempts', () => {
    create({ wakeDeadline: 500 });
    prepareTaskWaitWake(sql, 'wait-1', 'deadline_reached', 'wake', 1_000);
    expect(recordTaskWaitWakeFailure(sql, 'wait-1', 1_000, 6_000, 2)).toEqual({
      cancelled: false,
      attempts: 1,
    });
    expect(computeTaskWaitAlarmTime(sql)).toBe(6_000);

    expect(recordTaskWaitWakeFailure(sql, 'wait-1', 6_000, 16_000, 2)).toEqual({
      cancelled: true,
      attempts: 2,
    });
    expect(getTaskWait(sql, 'wait-1')).toMatchObject({
      state: 'cancelled',
      resolutionReason: 'wake_delivery_failed',
      wakeAttempts: 2,
    });
    expect(computeTaskWaitAlarmTime(sql)).toBeNull();
  });
});
