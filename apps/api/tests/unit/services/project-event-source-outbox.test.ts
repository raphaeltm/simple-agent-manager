import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  admitProjectEventSourceIntentById,
  enqueueAndAdmitProjectEventSourceIntent,
  enqueueProjectEventSourceIntent,
  markProjectEventSourceIntentSuperseded,
  projectEventSourceOutboxInsertStatement,
  readProjectEventSourceIntentByDelivery,
  readProjectEventSourceIntentById,
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
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.projectEventSourceOutbox, schema.credentialLimitWindows]);
    createOutboxIndexes();
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

  function createOutboxIndexes() {
    sqlite.exec(`
      CREATE UNIQUE INDEX idx_project_event_source_outbox_delivery
        ON project_event_source_outbox(project_id, source, delivery_key);
      CREATE INDEX idx_project_event_source_outbox_due
        ON project_event_source_outbox(state, next_attempt_at, id);
      CREATE INDEX idx_project_event_source_outbox_processing_lease
        ON project_event_source_outbox(state, processing_lease_expires_at, id);
      CREATE INDEX idx_project_event_source_outbox_active_expiry
        ON project_event_source_outbox(state, expires_at, id);
      CREATE INDEX idx_project_event_source_outbox_active_capacity
        ON project_event_source_outbox(project_id, source, state, expires_at, id);
      CREATE INDEX idx_project_event_source_outbox_active_attempts
        ON project_event_source_outbox(state, attempt_count, id);
      CREATE INDEX idx_project_event_source_outbox_exhausted_ready
        ON project_event_source_outbox(state, (attempt_count >= max_attempts), processing_lease_expires_at, id);
      CREATE INDEX idx_project_event_source_outbox_terminal_retention
        ON project_event_source_outbox(state, terminalized_at, id);
      CREATE INDEX idx_project_event_source_outbox_project_subject
        ON project_event_source_outbox(project_id, subject_type, subject_id, state);
    `);
  }

  function addCredentialLimitOutboxColumns() {
    sqlite.exec(`
      ALTER TABLE project_event_source_outbox ADD COLUMN credential_limit_window_type TEXT;
      ALTER TABLE project_event_source_outbox ADD COLUMN credential_limit_observed_at INTEGER;
      CREATE INDEX idx_project_event_source_outbox_credential_limit_active
        ON project_event_source_outbox(project_id, source, subject_id, credential_limit_window_type, state, credential_limit_observed_at, id)
        WHERE credential_limit_window_type IS NOT NULL AND credential_limit_observed_at IS NOT NULL;
      CREATE INDEX idx_credential_limit_windows_project_updated
        ON credential_limit_windows(project_id, updated_at, credential_reference, window_type);
      CREATE INDEX idx_credential_limit_windows_project_delivery
        ON credential_limit_windows(project_id, last_event_delivery_key)
        WHERE last_event_delivery_key IS NOT NULL;
    `);
  }

  async function waitForProjectDataAdmissions(count: number) {
    for (let i = 0; i < 100 && admitProjectEvent.mock.calls.length < count; i += 1) {
      await Promise.resolve();
    }
    expect(admitProjectEvent).toHaveBeenCalledTimes(count);
  }

  function rowById(id: string) {
    return sqlite
      .prepare(
        `SELECT state, attempt_count, claim_token, admitted_event_id,
                admission_outcome, terminalized_at, last_error
           FROM project_event_source_outbox
          WHERE id = ?`
      )
      .get(id) as
      | {
          state: string;
          attempt_count: number;
          claim_token: string | null;
          admitted_event_id: string | null;
          admission_outcome: string | null;
          terminalized_at: string | null;
          last_error: string | null;
        }
      | undefined;
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
    await waitForProjectDataAdmissions(1);
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

  it('does not adopt a replacement token before the initial claim read', async () => {
    admitProjectEvent.mockResolvedValue({
      outcome: 'created',
      event: { id: 'event-must-not-admit', state: 'recorded' },
      matches: [],
    });
    const { projectId: _projectId, ...payload } = sourceEvent();
    void _projectId;
    sqlite
      .prepare(
        `INSERT INTO project_event_source_outbox
          (id, project_id, source, event_type, subject_type, subject_id, delivery_key,
           payload_fingerprint, event_payload_json, state, attempt_count, max_attempts,
           next_attempt_at, expires_at, created_at, updated_at)
         VALUES ('intent-replaced-before-read', 'project-1', 'sam.lifecycle', 'task.completed',
          'task', 'task-1', 'delivery-replaced-before-read', 'sha256:stable', ?,
          'pending', 0, 3, ?, ?, ?, ?)`
      )
      .run(
        JSON.stringify(payload),
        NOW.toISOString(),
        new Date(NOW.getTime() + 60_000).toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );

    const database = env.DATABASE;
    let replaced = false;
    env.DATABASE = {
      ...database,
      prepare: (sql: string) => {
        if (
          !replaced &&
          sql.includes("WHERE id = ? AND state = 'processing' AND claim_token = ?")
        ) {
          replaced = true;
          sqlite
            .prepare(
              `UPDATE project_event_source_outbox
                  SET claim_token = 'replacement-token',
                      attempt_count = 2,
                      claimed_at = ?,
                      processing_lease_expires_at = ?
                WHERE id = 'intent-replaced-before-read'`
            )
            .run(NOW.toISOString(), new Date(NOW.getTime() + 60_000).toISOString());
        }
        return database.prepare(sql);
      },
    } as D1Database;

    const result = await admitProjectEventSourceIntentById(env, 'intent-replaced-before-read', NOW);

    expect(result).toMatchObject({ state: 'processing', attemptCount: 2 });
    expect(admitProjectEvent).not.toHaveBeenCalled();
    expect(rowById('intent-replaced-before-read')).toMatchObject({
      state: 'processing',
      attempt_count: 2,
      claim_token: 'replacement-token',
      admitted_event_id: null,
    });
  });

  it('does not cross into ProjectData after losing the claim before admission', async () => {
    admitProjectEvent.mockResolvedValue({
      outcome: 'created',
      event: { id: 'event-must-not-admit', state: 'recorded' },
      matches: [],
    });
    await enqueueProjectEventSourceIntent(env, sourceEvent(), {
      id: 'intent-loses-before-admission',
      now: NOW,
    });

    const database = env.DATABASE;
    let claimReads = 0;
    env.DATABASE = {
      ...database,
      prepare: (sql: string) => {
        if (sql.includes("WHERE id = ? AND state = 'processing' AND claim_token = ?")) {
          claimReads += 1;
          if (claimReads === 2) {
            sqlite
              .prepare(
                `UPDATE project_event_source_outbox
                    SET claim_token = 'replacement-before-effect',
                        attempt_count = 2,
                        claimed_at = ?,
                        processing_lease_expires_at = ?
                  WHERE id = 'intent-loses-before-admission'`
              )
              .run(NOW.toISOString(), new Date(NOW.getTime() + 60_000).toISOString());
          }
        }
        return database.prepare(sql);
      },
    } as D1Database;

    const result = await admitProjectEventSourceIntentById(
      env,
      'intent-loses-before-admission',
      NOW
    );

    expect(result).toMatchObject({ state: 'processing', attemptCount: 2 });
    expect(admitProjectEvent).not.toHaveBeenCalled();
    expect(rowById('intent-loses-before-admission')).toMatchObject({
      state: 'processing',
      attempt_count: 2,
      claim_token: 'replacement-before-effect',
      admitted_event_id: null,
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

  it('does not exhaust a live final processing attempt during a duplicate nudge', async () => {
    const { projectId: _projectId, ...payload } = sourceEvent();
    void _projectId;
    sqlite
      .prepare(
        `INSERT INTO project_event_source_outbox
          (id, project_id, source, event_type, subject_type, subject_id, delivery_key,
           payload_fingerprint, event_payload_json, state, attempt_count, max_attempts,
           next_attempt_at, processing_lease_expires_at, expires_at, claim_token, created_at, updated_at)
         VALUES ('intent-live-final', 'project-1', 'sam.lifecycle', 'task.completed',
          'task', 'task-1', 'delivery-live-final', 'sha256:stable', ?,
          'processing', 3, 3, ?, ?, ?, 'live-final-token', ?, ?)`
      )
      .run(
        JSON.stringify(payload),
        NOW.toISOString(),
        new Date(NOW.getTime() + 60_000).toISOString(),
        new Date(NOW.getTime() + 120_000).toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );

    const result = await admitProjectEventSourceIntentById(env, 'intent-live-final', NOW);

    expect(result).toMatchObject({ state: 'processing', attemptCount: 3 });
    expect(admitProjectEvent).not.toHaveBeenCalled();
    expect(rowById('intent-live-final')).toMatchObject({
      state: 'processing',
      attempt_count: 3,
      claim_token: 'live-final-token',
      terminalized_at: null,
    });
  });

  it('keeps live final attempts during sweep and exhausts them after lease expiry', async () => {
    const { projectId: _projectId, ...payload } = sourceEvent();
    void _projectId;
    const insert = sqlite.prepare(
      `INSERT INTO project_event_source_outbox
        (id, project_id, source, event_type, subject_type, subject_id, delivery_key,
         payload_fingerprint, event_payload_json, state, attempt_count, max_attempts,
         next_attempt_at, processing_lease_expires_at, expires_at, claim_token, created_at, updated_at)
       VALUES (?, 'project-1', 'sam.lifecycle', 'task.completed',
        'task', 'task-1', ?, 'sha256:stable', ?, 'processing', 3, 3, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      'intent-live-final-sweep',
      'delivery-live-final-sweep',
      JSON.stringify(payload),
      NOW.toISOString(),
      new Date(NOW.getTime() + 60_000).toISOString(),
      new Date(NOW.getTime() + 120_000).toISOString(),
      'live-sweep-token',
      NOW.toISOString(),
      NOW.toISOString()
    );
    insert.run(
      'intent-abandoned-final-sweep',
      'delivery-abandoned-final-sweep',
      JSON.stringify(payload),
      NOW.toISOString(),
      new Date(NOW.getTime() - 1_000).toISOString(),
      new Date(NOW.getTime() + 120_000).toISOString(),
      'abandoned-sweep-token',
      NOW.toISOString(),
      NOW.toISOString()
    );

    const stats = await reconcileProjectEventSourceOutbox(env, { limit: 10, now: NOW });

    expect(stats).toMatchObject({ permanentFailed: 1 });
    expect(rowById('intent-live-final-sweep')).toMatchObject({
      state: 'processing',
      claim_token: 'live-sweep-token',
      terminalized_at: null,
    });
    expect(rowById('intent-abandoned-final-sweep')).toMatchObject({
      state: 'permanent_failed',
      claim_token: null,
      terminalized_at: NOW.toISOString(),
    });
  });

  it('does not return or mutate a same-project row when an explicit ID collides with another delivery', async () => {
    await enqueueProjectEventSourceIntent(env, sourceEvent(), {
      id: 'shared-project-explicit-intent-id',
      now: NOW,
    });
    const collidingInput = {
      ...sourceEvent(),
      subject: { type: 'task', id: 'task-2' },
      deliveryKey: 'task:task-2:status:completed',
      payloadFingerprint: 'sha256:stable-task-2',
      metadata: { taskId: 'task-2', status: 'completed' },
    };

    await expect(
      enqueueProjectEventSourceIntent(env, collidingInput, {
        id: 'shared-project-explicit-intent-id',
        now: NOW,
      })
    ).rejects.toThrow('Project event source outbox intent was not persisted');

    expect(
      sqlite
        .prepare(
          `SELECT project_id, subject_id, delivery_key, state, admission_outcome
             FROM project_event_source_outbox
            WHERE id = 'shared-project-explicit-intent-id'`
        )
        .get()
    ).toEqual({
      project_id: 'project-1',
      subject_id: 'task-1',
      delivery_key: 'task:task-1:status:completed',
      state: 'pending',
      admission_outcome: null,
    });
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM project_event_source_outbox`).get()
    ).toEqual({ count: 1 });
  });

  it('does not return or mutate a foreign project row when explicit IDs collide', async () => {
    await enqueueProjectEventSourceIntent(env, sourceEvent(), {
      id: 'shared-explicit-intent-id',
      now: NOW,
    });
    const foreignInput = {
      ...sourceEvent(),
      projectId: 'project-2',
      subject: { type: 'task', id: 'task-2' },
      deliveryKey: 'task:task-2:status:completed',
      metadata: { taskId: 'task-2', status: 'completed' },
    };

    await expect(
      enqueueProjectEventSourceIntent(env, foreignInput, {
        id: 'shared-explicit-intent-id',
        now: NOW,
      })
    ).rejects.toThrow('Project event source outbox intent was not persisted');

    expect(
      sqlite
        .prepare(
          `SELECT project_id, subject_id, state, admission_outcome
             FROM project_event_source_outbox
            WHERE id = 'shared-explicit-intent-id'`
        )
        .get()
    ).toEqual({
      project_id: 'project-1',
      subject_id: 'task-1',
      state: 'pending',
      admission_outcome: null,
    });
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM project_event_source_outbox`).get()
    ).toEqual({ count: 1 });
  });

  it('captures credential limit window transitions with stale-window and capacity guards', async () => {
    addCredentialLimitOutboxColumns();
    const observedAt = NOW.getTime();
    const event = {
      ...sourceEvent(),
      source: 'sam.credential_limit',
      eventType: 'credential.limit.warning',
      subject: { type: 'credential', id: 'cc_credentials:cred-1' },
      deliveryKey: 'credential-limit:winning',
      payloadFingerprint: 'sha256:credential-window',
      metadata: { level: 'warning', windowType: 'openai.tokens' },
    };

    const inserted = await projectEventSourceOutboxInsertStatement(env, event, {
      id: 'credential-window-intent',
      now: NOW,
      capture: {
        kind: 'credential_limit_window_transition',
        projectId: 'project-1',
        credentialReference: 'cc_credentials:cred-1',
        windowType: 'openai.tokens',
        observedAt,
        maxActiveIntentsPerProject: 2,
      },
    }).run();
    sqlite
      .prepare(
        `INSERT INTO credential_limit_windows
          (project_id, credential_reference, window_type, credential_source, provider,
           provider_mode, user_id, source, status, last_event_level, observed_at,
           freshness_ms, last_event_delivery_key, duplicate_sample_count,
           stale_sample_count, created_at, updated_at)
         VALUES ('project-1', 'cc_credentials:cred-1', 'openai.tokens', 'user',
          'openai', 'user-api-key', 'user-1', 'proxy', 'allowed_warning',
          'warning', ?, 0, 'credential-limit:winning', 0, 0, ?, ?)`
      )
      .run(observedAt, observedAt, observedAt);

    const stale = await projectEventSourceOutboxInsertStatement(
      env,
      {
        ...event,
        deliveryKey: 'credential-limit:losing',
        payloadFingerprint: 'sha256:credential-window-losing',
      },
      {
        id: 'credential-window-losing-intent',
        now: NOW,
        capture: {
          kind: 'credential_limit_window_transition',
          projectId: 'project-1',
          credentialReference: 'cc_credentials:cred-1',
          windowType: 'openai.tokens',
          observedAt,
          maxActiveIntentsPerProject: 2,
        },
      }
    ).run();
    const capacity = await projectEventSourceOutboxInsertStatement(
      env,
      {
        ...event,
        subject: { type: 'credential', id: 'cc_credentials:cred-2' },
        deliveryKey: 'credential-limit:capacity',
        payloadFingerprint: 'sha256:credential-window-capacity',
      },
      {
        id: 'credential-window-capacity-intent',
        now: NOW,
        capture: {
          kind: 'credential_limit_window_transition',
          projectId: 'project-1',
          credentialReference: 'cc_credentials:cred-2',
          windowType: 'openai.tokens',
          observedAt,
          maxActiveIntentsPerProject: 1,
        },
      }
    ).run();

    expect(inserted.meta.changes).toBe(1);
    expect(stale.meta.changes).toBe(0);
    expect(capacity.meta.changes).toBe(0);
    expect(() =>
      projectEventSourceOutboxInsertStatement(env, event, {
        id: 'credential-window-mismatch',
        now: NOW,
        capture: {
          kind: 'credential_limit_window_transition',
          projectId: 'project-1',
          credentialReference: 'cc_credentials:other',
          windowType: 'openai.tokens',
          observedAt,
          maxActiveIntentsPerProject: 2,
        },
      })
    ).toThrow('Credential limit capture credential does not match intent subject');
    expect(
      sqlite
        .prepare(
          `SELECT id, delivery_key, credential_limit_window_type, credential_limit_observed_at
             FROM project_event_source_outbox
           WHERE source = 'sam.credential_limit'`
        )
        .all()
    ).toEqual([
      {
        id: 'credential-window-intent',
        delivery_key: 'credential-limit:winning',
        credential_limit_window_type: 'openai.tokens',
        credential_limit_observed_at: observedAt,
      },
    ]);
  });

  it('reads by delivery and supersedes only scoped non-live source intents', async () => {
    await enqueueProjectEventSourceIntent(env, sourceEvent(), { id: 'supersede-intent', now: NOW });
    await enqueueProjectEventSourceIntent(env, {
      ...sourceEvent(),
      deliveryKey: 'task:task-1:status:other',
      payloadFingerprint: 'sha256:other',
    });
    await enqueueProjectEventSourceIntent(env, {
      ...sourceEvent(),
      projectId: 'project-2',
      deliveryKey: 'task:foreign:status:completed',
      payloadFingerprint: 'sha256:foreign',
    }, {
      id: 'foreign-intent',
      now: NOW,
    });

    const byDelivery = await readProjectEventSourceIntentByDelivery(env, {
      projectId: 'project-1',
      source: 'sam.lifecycle',
      deliveryKey: 'task:task-1:status:completed',
    });
    expect(byDelivery?.id).toBe('supersede-intent');
    await expect(
      readProjectEventSourceIntentById(env, {
        id: 'foreign-intent',
        projectId: 'project-1',
        source: 'sam.lifecycle',
        deliveryKey: 'task:foreign:status:completed',
      })
    ).resolves.toBeNull();
    await expect(
      markProjectEventSourceIntentSuperseded(env, {
        id: 'foreign-intent',
        projectId: 'project-1',
        source: 'sam.lifecycle',
        deliveryKey: 'task:foreign:status:completed',
        now: NOW,
        reason: 'wrong project should not leak',
      })
    ).resolves.toBeNull();
    expect(
      sqlite
        .prepare(`SELECT project_id, state, last_error FROM project_event_source_outbox WHERE id = ?`)
        .get('foreign-intent')
    ).toEqual({ project_id: 'project-2', state: 'pending', last_error: null });

    sqlite
      .prepare(
        `UPDATE project_event_source_outbox
            SET state = 'processing',
                claim_token = 'live-claim',
                processing_lease_expires_at = ?
          WHERE id = 'supersede-intent'`
      )
      .run(new Date(NOW.getTime() + 10_000).toISOString());

    await markProjectEventSourceIntentSuperseded(env, {
      id: 'supersede-intent',
      projectId: 'project-1',
      source: 'sam.lifecycle',
      deliveryKey: 'task:task-1:status:completed',
      now: NOW,
      reason: 'test supersede',
    });
    expect(rowById('supersede-intent')).toMatchObject({
      state: 'processing',
      claim_token: 'live-claim',
      terminalized_at: null,
    });

    const afterLease = new Date(NOW.getTime() + 10_001);
    await markProjectEventSourceIntentSuperseded(env, {
      id: 'supersede-intent',
      projectId: 'project-1',
      source: 'sam.lifecycle',
      deliveryKey: 'task:task-1:status:completed',
      now: afterLease,
      reason: 'test supersede',
    });
    expect(rowById('supersede-intent')).toMatchObject({
      state: 'permanent_failed',
      claim_token: null,
      terminalized_at: afterLease.toISOString(),
      last_error: 'test supersede',
    });
    expect(
      sqlite
        .prepare(`SELECT state FROM project_event_source_outbox WHERE delivery_key = ?`)
        .get('task:task-1:status:other')
    ).toEqual({ state: 'pending' });
  });

  it('accounts claim and settle mutations under a finite sweep mutation budget', async () => {
    admitProjectEvent
      .mockResolvedValueOnce({
        outcome: 'created',
        event: { id: 'event-limit-one', state: 'recorded' },
        matches: [],
      })
      .mockResolvedValueOnce({
        outcome: 'created',
        event: { id: 'event-limit-two', state: 'recorded' },
        matches: [],
      });
    await enqueueProjectEventSourceIntent(env, sourceEvent(), {
      id: 'intent-limit-one',
      now: NOW,
    });
    await enqueueProjectEventSourceIntent(env, {
      ...sourceEvent(),
      subject: { type: 'task', id: 'task-2' },
      deliveryKey: 'task:task-2:status:completed',
      payloadFingerprint: 'sha256:stable-2',
      metadata: { taskId: 'task-2', status: 'completed' },
    }, {
      id: 'intent-limit-two',
      now: NOW,
    });

    const before = sqlite.prepare(`SELECT total_changes() AS changes`).get() as {
      changes: number;
    };
    const stats = await reconcileProjectEventSourceOutbox(env, { limit: 1, now: NOW });
    const after = sqlite.prepare(`SELECT total_changes() AS changes`).get() as {
      changes: number;
    };

    expect(after.changes - before.changes).toBe(2);
    expect(stats).toMatchObject({ attempted: 1, admitted: 1, outboxMutations: 2, hasMore: true });
    expect(admitProjectEvent).toHaveBeenCalledTimes(1);
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
      { state: 'admitted', count: 1 },
      { state: 'pending', count: 1 },
    ]);
  });

  it('passes the remaining sweep wall allowance into external admission', async () => {
    env.PROJECT_EVENT_SOURCE_OUTBOX_SWEEP_WALL_MS = '5';
    env.PROJECT_EVENT_SOURCE_OUTBOX_ADMISSION_TIMEOUT_MS = '40';
    let resolveRemote:
      | ((value: {
          outcome: string;
          event: { id: string; state: string };
          matches: unknown[];
        }) => void)
      | undefined;
    admitProjectEvent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemote = resolve;
        })
    );
    await enqueueProjectEventSourceIntent(env, sourceEvent(), {
      id: 'intent-wall-budget',
      now: NOW,
    });

    const statsPromise = reconcileProjectEventSourceOutbox(env, { limit: 1, now: NOW });
    await waitForProjectDataAdmissions(1);
    await vi.advanceTimersByTimeAsync(5);
    const stats = await statsPromise;

    expect(stats).toMatchObject({
      attempted: 1,
      retryableFailed: 1,
      timedOut: 1,
      outboxMutations: 2,
    });
    expect(rowById('intent-wall-budget')).toMatchObject({
      state: 'retryable_failed',
      attempt_count: 1,
      last_error: 'ProjectEventSourceAdmissionTimeoutError: ProjectData admission timed out after 5ms',
    });
    resolveRemote?.({
      outcome: 'created',
      event: { id: 'event-after-wall-timeout', state: 'recorded' },
      matches: [],
    });
  });

  it('does not start external admission after claim reads consume the sweep wall', async () => {
    env.PROJECT_EVENT_SOURCE_OUTBOX_SWEEP_WALL_MS = '20';
    env.PROJECT_EVENT_SOURCE_OUTBOX_ADMISSION_TIMEOUT_MS = '40';
    admitProjectEvent.mockResolvedValue({
      outcome: 'created',
      event: { id: 'event-after-deadline', state: 'recorded' },
      matches: [],
    });
    await enqueueProjectEventSourceIntent(env, sourceEvent(), {
      id: 'intent-deadline-before-admission',
      now: NOW,
    });

    const database = env.DATABASE;
    let delayed = false;
    env.DATABASE = {
      ...database,
      prepare: (sql: string) => {
        const statement = database.prepare(sql);
        if (
          delayed ||
          !sql.includes("WHERE id = ? AND state = 'processing' AND claim_token = ?")
        ) {
          return statement;
        }
        return {
          ...statement,
          bind: (...params: unknown[]) => {
            const bound = statement.bind(...params);
            return {
              ...bound,
              first: async (column?: string) => {
                delayed = true;
                await vi.advanceTimersByTimeAsync(35);
                return bound.first(column);
              },
            };
          },
        } as D1PreparedStatement;
      },
    } as D1Database;

    const stats = await reconcileProjectEventSourceOutbox(env, { limit: 1, now: NOW });

    expect(admitProjectEvent).not.toHaveBeenCalled();
    expect(stats).toMatchObject({
      attempted: 1,
      retryableFailed: 1,
      timedOut: 1,
      outboxMutations: 2,
    });
    expect(rowById('intent-deadline-before-admission')).toMatchObject({
      state: 'retryable_failed',
      attempt_count: 1,
      claim_token: null,
      last_error: 'ProjectEventSourceAdmissionTimeoutError: ProjectData admission timed out after 0ms',
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
    await waitForProjectDataAdmissions(1);
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

  it('reclaims upgraded legacy terminal rows whose terminalized timestamp is null', async () => {
    env.PROJECT_EVENT_SOURCE_OUTBOX_TERMINAL_RETENTION_MS = '0';
    const old = new Date(NOW.getTime() - 60_000).toISOString();
    sqlite
      .prepare(
        `INSERT INTO project_event_source_outbox
          (id, project_id, source, event_type, subject_type, subject_id, delivery_key,
           payload_fingerprint, event_payload_json, state, attempt_count, max_attempts,
           next_attempt_at, expires_at, admitted_event_id, admission_outcome,
           terminalized_at, created_at, updated_at)
         VALUES ('legacy-admitted-null-terminalized', 'project-1', 'sam.lifecycle',
          'task.completed', 'task', 'task-1', 'legacy-terminal-delivery',
          'sha256:legacy-terminal', '{}', 'admitted', 1, 3, ?, ?, 'event-legacy',
          'created', NULL, ?, ?)`
      )
      .run(old, old, old, old);

    const stats = await reconcileProjectEventSourceOutbox(env, { limit: 5, now: NOW });

    expect(stats).toMatchObject({ terminalDeleted: 1 });
    expect(rowById('legacy-admitted-null-terminalized')).toBeUndefined();
  });

  it('uses the exhausted-ready index instead of scanning healthy attempt prefixes', () => {
    sqlite.close();
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.projectEventSourceOutbox]);
    createOutboxIndexes();
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    const insert = sqlite.prepare(
      `INSERT INTO project_event_source_outbox
        (id, project_id, source, event_type, subject_type, subject_id, delivery_key,
         payload_fingerprint, event_payload_json, state, attempt_count, max_attempts,
         next_attempt_at, processing_lease_expires_at, expires_at, created_at, updated_at)
       VALUES (?, 'project-1', 'sam.lifecycle', 'task.completed', 'task', ?,
        ?, 'sha256:healthy', '{}', 'pending', 0, 8, ?, NULL, ?, ?, ?)`
    );
    const manyHealthy = sqlite.transaction(() => {
      for (let i = 0; i < 20_000; i += 1) {
        insert.run(`healthy-${i}`, `task-${i}`, `delivery-${i}`, future, future, future, future);
      }
    });
    manyHealthy();

    const plan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM project_event_source_outbox
          WHERE state = ? AND (attempt_count >= max_attempts) = 1
          ORDER BY processing_lease_expires_at, id
          LIMIT ?`
      )
      .all('pending', 10) as Array<{ detail: string }>;

    expect(plan.map((row) => row.detail).join('\n')).toContain(
      'idx_project_event_source_outbox_exhausted_ready'
    );
    expect(plan.map((row) => row.detail).join('\n')).not.toMatch(/\bSCAN\b/);
  });

  it('uses the active-capacity index for bounded credential capture capacity probes', () => {
    const plan = sqlite
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT COUNT(*) FROM (
           SELECT id FROM project_event_source_outbox
            WHERE project_id = ? AND source = ?
              AND state IN ('pending', 'processing', 'retryable_failed')
              AND expires_at > ?
            LIMIT ?
         )`
      )
      .all('project-1', 'sam.credential_limit', NOW.toISOString(), 10) as Array<{
      detail: string;
    }>;

    expect(plan.map((row) => row.detail).join('\n')).toContain(
      'idx_project_event_source_outbox_active_capacity'
    );
  });
});
