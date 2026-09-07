import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  enqueueAndAdmitProjectEventSourceIntent,
  reconcileProjectEventSourceOutbox,
} from '../../../src/services/project-event-source-outbox';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const admitProjectEvent = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/project-data', () => ({ admitProjectEvent }));

const NOW = new Date('2026-09-07T00:00:00.000Z');

describe('project event source outbox', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.projectEventSourceOutbox]);
    sqlite.exec(
      `CREATE UNIQUE INDEX idx_project_event_source_outbox_delivery
         ON project_event_source_outbox(project_id, source, delivery_key)`
    );
    env = {
      DATABASE: createSqliteD1(sqlite),
      PROJECT_EVENT_SOURCE_OUTBOX_RETRY_BASE_MS: '1000',
      PROJECT_EVENT_SOURCE_OUTBOX_RETRY_MAX_MS: '1000',
      PROJECT_EVENT_SOURCE_OUTBOX_BATCH_ROWS: '10',
    } as unknown as Env;
  });

  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
  });

  function sourceEvent() {
    return {
      projectId: 'project-1',
      source: 'sam.lifecycle',
      eventType: 'task.completed',
      subject: { type: 'task', id: 'task-1' },
      severity: 'info' as const,
      deliveryKey: 'task:task-1:status:completed',
      payloadFingerprint: 'sha256:stable',
      metadata: { taskId: 'task-1', status: 'completed' },
      display: { title: 'Task completed' },
      occurredAt: NOW.getTime(),
      receivedAt: NOW.getTime(),
    };
  }

  it('retries a failed first admission and admits once under the stable delivery key', async () => {
    admitProjectEvent
      .mockRejectedValueOnce(new Error('Injected ProjectData admission failure'))
      .mockResolvedValueOnce({
        outcome: 'created',
        event: { id: 'event-1', state: 'recorded' },
        matches: [],
      });

    const first = await enqueueAndAdmitProjectEventSourceIntent(env, sourceEvent());

    expect(first).toMatchObject({ state: 'retryable_failed' });
    expect(admitProjectEvent).toHaveBeenCalledTimes(1);
    expect(admitProjectEvent).toHaveBeenNthCalledWith(
      1,
      env,
      'project-1',
      expect.objectContaining({
        source: 'sam.lifecycle',
        eventType: 'task.completed',
        deliveryKey: 'task:task-1:status:completed',
      })
    );

    const retryAt = new Date(NOW.getTime() + 1000);
    const stats = await reconcileProjectEventSourceOutbox(env, { now: retryAt });

    expect(stats).toMatchObject({ attempted: 1, admitted: 1, retryableFailed: 0 });
    expect(admitProjectEvent).toHaveBeenCalledTimes(2);
    expect(admitProjectEvent).toHaveBeenNthCalledWith(
      2,
      env,
      'project-1',
      expect.objectContaining({
        deliveryKey: 'task:task-1:status:completed',
      })
    );
    expect(
      sqlite
        .prepare(
          `SELECT state, attempt_count, admitted_event_id, admission_outcome
             FROM project_event_source_outbox
            WHERE delivery_key = ?`
        )
        .get('task:task-1:status:completed')
    ).toEqual({
      state: 'admitted',
      attempt_count: 2,
      admitted_event_id: 'event-1',
      admission_outcome: 'created',
    });
  });

  it('does not enqueue duplicate rows for a repeated stable source delivery key', async () => {
    admitProjectEvent.mockResolvedValue({
      outcome: 'created',
      event: { id: 'event-1', state: 'recorded' },
      matches: [],
    });

    await enqueueAndAdmitProjectEventSourceIntent(env, sourceEvent());
    await enqueueAndAdmitProjectEventSourceIntent(env, sourceEvent());

    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM project_event_source_outbox').get()
    ).toEqual({ count: 1 });
  });
});
