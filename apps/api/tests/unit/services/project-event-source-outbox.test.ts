import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  admitProjectEventSourceIntentById,
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
      PROJECT_EVENT_SOURCE_OUTBOX_PROCESSING_LEASE_MS: '1000',
      PROJECT_EVENT_SOURCE_OUTBOX_ADMISSION_TIMEOUT_MS: '600000',
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

  it('marks ProjectData delivery conflicts as permanent failed instead of admitted', async () => {
    admitProjectEvent.mockResolvedValue({
      outcome: 'conflict',
      event: {
        id: 'event-conflicted',
        state: 'conflicted',
        payloadFingerprint: 'sha256:old',
      },
      matches: [],
      conflict: {
        deliveryKey: 'task:task-1:status:completed',
        existingFingerprint: 'sha256:old',
        incomingFingerprint: 'sha256:stable',
      },
    });

    const result = await enqueueAndAdmitProjectEventSourceIntent(env, sourceEvent());

    expect(result).toMatchObject({
      state: 'permanent_failed',
      admissionOutcome: 'conflict',
      eventId: 'event-conflicted',
    });
    expect(
      sqlite
        .prepare(
          `SELECT state, admission_outcome, admitted_event_id, terminalized_at
             FROM project_event_source_outbox`
        )
        .get()
    ).toEqual({
      state: 'permanent_failed',
      admission_outcome: 'conflict',
      admitted_event_id: 'event-conflicted',
      terminalized_at: NOW.toISOString(),
    });
  });

  it('settles claims only with the current claim token after replacement', async () => {
    let resolveFirstAdmission:
      | ((value: {
          outcome: string;
          event: { id: string; state: string };
          matches: unknown[];
        }) => void)
      | undefined;
    admitProjectEvent
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstAdmission = resolve;
          })
      )
      .mockResolvedValueOnce({
        outcome: 'created',
        event: { id: 'event-second', state: 'recorded' },
        matches: [],
      });

    const firstPromise = enqueueAndAdmitProjectEventSourceIntent(env, sourceEvent());
    for (let i = 0; i < 5 && admitProjectEvent.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    const claimed = sqlite
      .prepare(
        `SELECT id, claim_token, attempt_count
           FROM project_event_source_outbox
          WHERE delivery_key = ?`
      )
      .get('task:task-1:status:completed') as {
      id: string;
      claim_token: string;
      attempt_count: number;
    };

    vi.setSystemTime(new Date(NOW.getTime() + 2_000));
    const second = await admitProjectEventSourceIntentById(env, claimed.id);

    expect(second).toMatchObject({
      state: 'admitted',
      admissionOutcome: 'created',
      eventId: 'event-second',
    });
    expect(
      sqlite
        .prepare(
          `SELECT admitted_event_id, attempt_count, claim_token FROM project_event_source_outbox`
        )
        .get()
    ).toEqual({
      admitted_event_id: 'event-second',
      attempt_count: 2,
      claim_token: null,
    });

    resolveFirstAdmission?.({
      outcome: 'created',
      event: { id: 'event-first-late', state: 'recorded' },
      matches: [],
    });
    const late = await firstPromise;

    expect(late).toMatchObject({
      state: 'admitted',
      admissionOutcome: 'created',
      eventId: 'event-second',
      attemptCount: 2,
    });
    expect(
      sqlite.prepare(`SELECT admitted_event_id, claim_token FROM project_event_source_outbox`).get()
    ).toEqual({
      admitted_event_id: 'event-second',
      claim_token: null,
    });
  });

  it('does not let a stale failure clear a replacement claim before it settles', async () => {
    let resolveReplacement:
      | ((value: {
          outcome: string;
          event: { id: string; state: string };
          matches: unknown[];
        }) => void)
      | undefined;
    admitProjectEvent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveReplacement = resolve;
        })
    );
    const { projectId: _projectId, ...payload } = sourceEvent();
    void _projectId;
    const staleLeaseExpiresAt = new Date(NOW.getTime() - 1_000).toISOString();
    sqlite
      .prepare(
        `INSERT INTO project_event_source_outbox
          (id, project_id, source, event_type, subject_type, subject_id, delivery_key,
           payload_fingerprint, event_payload_json, state, attempt_count, max_attempts,
           next_attempt_at, processing_lease_expires_at, expires_at, claim_token, created_at, updated_at)
         VALUES ('intent-stale-failure', 'project-1', 'sam.lifecycle', 'task.completed',
          'task', 'task-1', 'task:task-1:status:completed', 'sha256:stable', ?,
          'processing', 1, 3, ?, ?, ?, 'stale-token', ?, ?)`
      )
      .run(
        JSON.stringify(payload),
        NOW.toISOString(),
        staleLeaseExpiresAt,
        new Date(NOW.getTime() + 60_000).toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );

    vi.setSystemTime(new Date(NOW.getTime() + 2_000));
    const replacementPromise = admitProjectEventSourceIntentById(env, 'intent-stale-failure');
    for (let i = 0; i < 50 && admitProjectEvent.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    const replacementClaim = sqlite
      .prepare(`SELECT state, attempt_count, claim_token FROM project_event_source_outbox`)
      .get() as { state: string; attempt_count: number; claim_token: string | null };
    expect(replacementClaim).toMatchObject({ state: 'processing', attempt_count: 2 });
    expect(replacementClaim.claim_token).not.toBe('stale-token');

    const staleFailure = sqlite
      .prepare(
        `UPDATE project_event_source_outbox
            SET state = 'retryable_failed', processing_lease_expires_at = NULL,
                claim_token = NULL, last_error = 'old claim failed late'
          WHERE id = 'intent-stale-failure'
            AND state = 'processing'
            AND claim_token = 'stale-token'`
      )
      .run();

    expect(staleFailure.changes).toBe(0);
    expect(
      sqlite
        .prepare(
          `SELECT state, attempt_count, claim_token, last_error FROM project_event_source_outbox`
        )
        .get()
    ).toEqual({
      state: 'processing',
      attempt_count: 2,
      claim_token: replacementClaim.claim_token,
      last_error: null,
    });

    resolveReplacement?.({
      outcome: 'created',
      event: { id: 'event-second', state: 'recorded' },
      matches: [],
    });
    const replacement = await replacementPromise;

    expect(replacement).toMatchObject({
      state: 'admitted',
      eventId: 'event-second',
      attemptCount: 2,
    });
  });

  it('marks exhausted rows at claim time without calling ProjectData', async () => {
    admitProjectEvent.mockResolvedValue({
      outcome: 'created',
      event: { id: 'event-never', state: 'recorded' },
      matches: [],
    });
    await sqlite
      .prepare(
        `INSERT INTO project_event_source_outbox
          (id, project_id, source, event_type, subject_type, subject_id, delivery_key,
           payload_fingerprint, event_payload_json, state, attempt_count, max_attempts,
           next_attempt_at, expires_at, created_at, updated_at)
         VALUES ('intent-exhausted', 'project-1', 'sam.lifecycle', 'task.completed',
          'task', 'task-1', 'delivery-exhausted', 'sha256:stable', '{}',
          'pending', 3, 3, ?, ?, ?, ?)`
      )
      .run(
        NOW.toISOString(),
        new Date(NOW.getTime() + 60_000).toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );

    const result = await admitProjectEventSourceIntentById(env, 'intent-exhausted', NOW);

    expect(result).toMatchObject({ state: 'permanent_failed', attemptCount: 3 });
    expect(admitProjectEvent).not.toHaveBeenCalled();
    expect(
      sqlite.prepare(`SELECT state, terminalized_at FROM project_event_source_outbox`).get()
    ).toEqual({
      state: 'permanent_failed',
      terminalized_at: NOW.toISOString(),
    });
  });

  it('bounds expired history before due admission candidates', async () => {
    admitProjectEvent.mockResolvedValue({
      outcome: 'created',
      event: { id: 'event-due', state: 'recorded' },
      matches: [],
    });
    const expiredAt = new Date(NOW.getTime() - 1_000).toISOString();
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    const insert = sqlite.prepare(
      `INSERT INTO project_event_source_outbox
        (id, project_id, source, event_type, subject_type, subject_id, delivery_key,
         payload_fingerprint, event_payload_json, state, attempt_count, max_attempts,
         next_attempt_at, expires_at, created_at, updated_at)
       VALUES (?, 'project-1', 'sam.lifecycle', 'task.completed', 'task', ?, ?,
        'sha256:stable', '{}', 'pending', 0, 3, ?, ?, ?, ?)`
    );
    for (let i = 0; i < 15; i += 1) {
      insert.run(
        `expired-${i}`,
        `expired-task-${i}`,
        `expired-delivery-${i}`,
        expiredAt,
        expiredAt,
        expiredAt,
        expiredAt
      );
    }
    insert.run(
      'due-1',
      'task-due',
      'delivery-due',
      NOW.toISOString(),
      future,
      NOW.toISOString(),
      NOW.toISOString()
    );

    const stats = await reconcileProjectEventSourceOutbox(env, { now: NOW });

    expect(stats).toMatchObject({ expired: 10, admitted: 0, attempted: 0, hasMore: true });
    expect(admitProjectEvent).not.toHaveBeenCalled();
    expect(
      sqlite
        .prepare(
          `SELECT state, COUNT(*) AS count
             FROM project_event_source_outbox
            GROUP BY state
            ORDER BY state`
        )
        .all()
    ).toEqual([
      { state: 'expired', count: 10 },
      { state: 'pending', count: 6 },
    ]);
  });

  it('treats admission timeout as ambiguous and converges on exact replay', async () => {
    env.PROJECT_EVENT_SOURCE_OUTBOX_ADMISSION_TIMEOUT_MS = '10';
    let resolveRemote:
      | ((value: {
          outcome: string;
          event: { id: string; state: string };
          matches: unknown[];
        }) => void)
      | undefined;
    admitProjectEvent
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRemote = resolve;
          })
      )
      .mockResolvedValueOnce({
        outcome: 'duplicate_replay',
        event: { id: 'event-created-after-timeout', state: 'recorded' },
        matches: [],
      });

    const firstPromise = enqueueAndAdmitProjectEventSourceIntent(env, sourceEvent());
    await vi.advanceTimersByTimeAsync(10);
    const first = await firstPromise;

    expect(first).toMatchObject({ state: 'retryable_failed' });
    resolveRemote?.({
      outcome: 'created',
      event: { id: 'event-created-after-timeout', state: 'recorded' },
      matches: [],
    });

    vi.setSystemTime(new Date(NOW.getTime() + 1_010));
    const stats = await reconcileProjectEventSourceOutbox(env, {
      now: new Date(NOW.getTime() + 1_010),
    });

    expect(stats).toMatchObject({ attempted: 1, admitted: 1 });
    expect(
      sqlite
        .prepare(
          `SELECT state, admission_outcome, admitted_event_id, attempt_count
             FROM project_event_source_outbox`
        )
        .get()
    ).toEqual({
      state: 'admitted',
      admission_outcome: 'duplicate_replay',
      admitted_event_id: 'event-created-after-timeout',
      attempt_count: 2,
    });
  });
});
