import { eq } from 'drizzle-orm';
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

function createRecordingDb() {
  const calls = { updates: [] as RecordedUpdate[], inserts: [] as RecordedInsert[] };
  const db = {
    update: vi.fn((table: unknown) => ({
      set: vi.fn((set: Record<string, unknown>) => ({
        where: vi.fn((where: unknown) => {
          calls.updates.push({ table, set, where });
          return Promise.resolve();
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
  it('marks the task failed and records the queued→failed status event', async () => {
    const { db, calls } = createRecordingDb();

    await markQueuedTaskFailed(db, 'task-123', 'Session creation failed: DO unavailable');

    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0].table).toBe(schema.tasks);
    expect(calls.updates[0].set).toMatchObject({
      status: 'failed',
      errorMessage: 'Session creation failed: DO unavailable',
    });
    expect(typeof calls.updates[0].set.updatedAt).toBe('string');
    // Update is scoped to exactly the given task id
    expect(calls.updates[0].where).toEqual(eq(schema.tasks.id, 'task-123'));

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
});
