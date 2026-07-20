import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { markQueuedTaskFailed } from '../../../src/services/task-failure';

interface RecordedUpdate {
  table: unknown;
  set: Record<string, unknown>;
  where: unknown;
}

interface RecordedInsert {
  table: unknown;
  values: Record<string, unknown>;
}

function createRecordingDb(updateChanges: number) {
  const calls = { updates: [] as RecordedUpdate[], inserts: [] as RecordedInsert[] };
  const db = {
    update: vi.fn((table: unknown) => ({
      set: vi.fn((set: Record<string, unknown>) => ({
        where: vi.fn((where: unknown) => {
          calls.updates.push({ table, set, where });
          return Promise.resolve({ meta: { changes: updateChanges } });
        }),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: Record<string, unknown>) => {
        calls.inserts.push({ table, values });
        return Promise.resolve();
      }),
    })),
  };
  return { db: db as never, calls };
}

describe('markQueuedTaskFailed', () => {
  it('marks the queued task failed and records the queued→failed status event', async () => {
    const { db, calls } = createRecordingDb(1);

    const transitioned = await markQueuedTaskFailed(
      db,
      'task-123',
      'Session creation failed: DO unavailable'
    );

    expect(transitioned).toBe(true);
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0].table).toBe(schema.tasks);
    expect(calls.updates[0].set).toMatchObject({
      status: 'failed',
      errorMessage: 'Session creation failed: DO unavailable',
    });
    expect(typeof calls.updates[0].set.updatedAt).toBe('string');
    // Optimistically locked: scoped to the task id AND the queued status
    expect(calls.updates[0].where).toEqual(
      and(eq(schema.tasks.id, 'task-123'), eq(schema.tasks.status, 'queued'))
    );

    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0].table).toBe(schema.taskStatusEvents);
    expect(calls.inserts[0].values).toMatchObject({
      taskId: 'task-123',
      fromStatus: 'queued',
      toStatus: 'failed',
      actorType: 'system',
      actorId: null,
      reason: 'Session creation failed: DO unavailable',
    });
    expect(typeof calls.inserts[0].values.id).toBe('string');
    expect(calls.inserts[0].values.id).not.toHaveLength(0);
    // Task row and status event carry the same failure instant
    expect(calls.inserts[0].values.createdAt).toBe(calls.updates[0].set.updatedAt);
  });

  it('does not record a status event when the task already left queued', async () => {
    const { db, calls } = createRecordingDb(0);

    const transitioned = await markQueuedTaskFailed(db, 'task-123', 'Instant launch failed: boom');

    expect(transitioned).toBe(false);
    expect(calls.updates).toHaveLength(1);
    expect(calls.inserts).toHaveLength(0);
  });
});
