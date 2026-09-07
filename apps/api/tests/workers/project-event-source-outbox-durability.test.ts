import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdmitProjectEventInput } from '../../src/durable-objects/project-data/project-events';
import type { Env } from '../../src/env';
import * as projectDataService from '../../src/services/project-data';
import {
  admitProjectEventSourceIntentById,
  enqueueProjectEventSourceIntent,
  markProjectEventSourceIntentSuperseded,
  projectEventSourceOutboxInsertStatement,
  readProjectEventSourceIntentById,
  reconcileProjectEventSourceOutbox,
} from '../../src/services/project-event-source-outbox';
import { transitionTaskToTerminal } from '../../src/services/task-terminal-transition';
import { seedInstallation, seedNode, seedProject, seedUser } from './helpers/seed-d1';

const TEST_PREFIX = `source-outbox-durability-${Date.now()}`;
const testEnv = env as unknown as Env;
const NOW = new Date('2026-09-07T00:00:00.000Z');

function withoutProjectId(
  input: AdmitProjectEventInput
): Omit<AdmitProjectEventInput, 'projectId'> {
  const { projectId, ...event } = input;
  void projectId;
  return event;
}

async function seedProjectGraph(suffix: string): Promise<{ userId: string; projectId: string }> {
  const userId = `${TEST_PREFIX}-${suffix}-user`;
  const installationId = `${TEST_PREFIX}-${suffix}-installation`;
  const projectId = `${TEST_PREFIX}-${suffix}-project`;
  await seedUser(userId, { githubId: `${TEST_PREFIX}-${suffix}-gh` });
  await seedInstallation(installationId, userId, {
    installationIdValue: `${TEST_PREFIX}-${suffix}-external-installation`,
    accountName: `${TEST_PREFIX}-${suffix}-account`,
  });
  await seedProject(projectId, userId, installationId, {
    name: `${TEST_PREFIX}-${suffix} Project`,
    repository: `${TEST_PREFIX}/${suffix}`,
  });
  return { userId, projectId };
}

function eventInput(
  projectId: string,
  suffix: string,
  overrides: Partial<AdmitProjectEventInput> = {}
): AdmitProjectEventInput {
  return {
    projectId,
    source: 'sam.lifecycle',
    eventType: 'task.completed',
    subject: { type: 'task', id: `${suffix}-task` },
    severity: 'info',
    deliveryKey: `task:${suffix}:status:completed`,
    payloadFingerprint: `sha256:${suffix}-fingerprint`,
    metadata: { taskId: `${suffix}-task`, status: 'completed' },
    display: { title: 'Task completed' },
    occurredAt: NOW.getTime(),
    receivedAt: NOW.getTime(),
    ...overrides,
  };
}

async function outboxRow(id: string) {
  return env.DATABASE.prepare(
    `SELECT id, state, attempt_count, claim_token, admitted_event_id, admission_outcome, terminalized_at
       FROM project_event_source_outbox
      WHERE id = ?
      LIMIT 1`
  )
    .bind(id)
    .first<{
      id: string;
      state: string;
      attempt_count: number;
      claim_token: string | null;
      admitted_event_id: string | null;
      admission_outcome: string | null;
      terminalized_at: string | null;
    }>();
}

describe('Project event source outbox durability on migrated D1', () => {
  beforeEach(async () => {
    await env.DATABASE.prepare(`DELETE FROM project_event_source_outbox WHERE id LIKE ?`)
      .bind(`${TEST_PREFIX}-%`)
      .run();
    await env.DATABASE.prepare(`DELETE FROM credential_limit_windows WHERE project_id LIKE ?`)
      .bind(`${TEST_PREFIX}-%`)
      .run();
  });

  it('does not capture lifecycle source intents for losing terminal transitions', async () => {
    const { userId, projectId } = await seedProjectGraph('losing-transition');
    const nodeId = `${projectId}-node`;
    const workspaceId = `${projectId}-workspace`;
    const taskId = `${projectId}-task`;
    await seedNode(nodeId, userId);
    await env.DATABASE.prepare(
      `INSERT INTO workspaces
         (id, project_id, user_id, name, repository, branch, node_id, status,
          vm_size, vm_location, created_at, updated_at)
       VALUES (?, ?, ?, 'Workspace', 'repo', 'main', ?, 'running', 'small', 'nbg1', ?, ?)`
    )
      .bind(workspaceId, projectId, userId, nodeId, NOW.toISOString(), NOW.toISOString())
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO tasks
         (id, project_id, user_id, chat_session_id, workspace_id, title, status,
          execution_step, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'session-1', ?, 'Race task', 'in_progress', 'running', ?, ?, ?)`
    )
      .bind(taskId, projectId, userId, workspaceId, userId, NOW.toISOString(), NOW.toISOString())
      .run();

    const database = env.DATABASE;
    const raceEnv = {
      ...testEnv,
      DATABASE: {
        prepare: database.prepare.bind(database),
        exec: database.exec.bind(database),
        dump: database.dump.bind(database),
        batch: async (statements: D1PreparedStatement[]) => {
          await database
            .prepare(
              `UPDATE tasks
                  SET status = 'completed', completed_at = ?, updated_at = ?
                WHERE id = ?`
            )
            .bind(NOW.toISOString(), NOW.toISOString(), taskId)
            .run();
          return database.batch(statements);
        },
      } as D1Database,
    } as Env;

    const outcome = await transitionTaskToTerminal(raceEnv, {
      taskId,
      projectId,
      status: 'failed',
      reason: 'lost race',
      source: 'worker-test',
      expectedWorkspaceId: workspaceId,
      expectedChatSessionId: 'session-1',
      stopWorkspace: false,
    });

    expect(outcome).toBe('not_terminalizable');
    expect(
      await env.DATABASE.prepare(
        `SELECT COUNT(*) AS count
           FROM project_event_source_outbox
          WHERE project_id = ? AND subject_id = ?`
      )
        .bind(projectId, taskId)
        .first<{ count: number }>()
    ).toEqual({ count: 0 });
  });

  it('marks a ProjectData same-delivery fingerprint conflict as a terminal outbox conflict', async () => {
    const { projectId } = await seedProjectGraph('conflict');
    const created = eventInput(projectId, 'conflict', {
      payloadFingerprint: 'sha256:original',
      metadata: { taskId: 'conflict-task', status: 'completed', generation: 'original' },
    });
    await projectDataService.admitProjectEvent(testEnv, projectId, withoutProjectId(created));

    const conflicting = eventInput(projectId, 'conflict', {
      payloadFingerprint: 'sha256:conflicting',
      metadata: { taskId: 'conflict-task', status: 'completed', generation: 'conflicting' },
    });
    await projectEventSourceOutboxInsertStatement(testEnv, conflicting, {
      id: `${projectId}-intent-conflict-worker`,
      now: NOW,
    }).run();

    const result = await admitProjectEventSourceIntentById(
      testEnv,
      `${projectId}-intent-conflict-worker`,
      NOW
    );

    expect(result).toMatchObject({ state: 'permanent_failed', admissionOutcome: 'conflict' });
    expect(await outboxRow(`${projectId}-intent-conflict-worker`)).toMatchObject({
      state: 'permanent_failed',
      admission_outcome: 'conflict',
      terminalized_at: NOW.toISOString(),
    });
  });

  it('recovers a lost ProjectData success acknowledgement by replacing the stale claim', async () => {
    const { projectId } = await seedProjectGraph('lost-ack');
    const input = eventInput(projectId, 'lost-ack');
    await projectEventSourceOutboxInsertStatement(testEnv, input, {
      id: `${projectId}-intent-lost-ack-worker`,
      now: NOW,
    }).run();
    await projectDataService.admitProjectEvent(testEnv, projectId, withoutProjectId(input));
    await env.DATABASE.prepare(
      `UPDATE project_event_source_outbox
          SET state = 'processing', attempt_count = 1, claim_token = 'stale-claim',
              claimed_at = ?, processing_lease_expires_at = ?, updated_at = ?
        WHERE id = ?`
    )
      .bind(
        NOW.toISOString(),
        new Date(NOW.getTime() - 1_000).toISOString(),
        NOW.toISOString(),
        `${projectId}-intent-lost-ack-worker`
      )
      .run();

    const stats = await reconcileProjectEventSourceOutbox(testEnv, {
      limit: 5,
      now: new Date(NOW.getTime() + 1_000),
    });

    expect(stats).toMatchObject({ attempted: 1, admitted: 1 });
    expect(await outboxRow(`${projectId}-intent-lost-ack-worker`)).toMatchObject({
      state: 'admitted',
      attempt_count: 2,
      admission_outcome: 'duplicate_replay',
    });
  });

  it('does not return or mutate a same-project row when an explicit ID collides on migrated D1', async () => {
    const { projectId } = await seedProjectGraph('same-project-id-collision');
    const sharedIntentId = `${TEST_PREFIX}-same-project-shared-intent-id`;
    await enqueueProjectEventSourceIntent(testEnv, eventInput(projectId, 'same-project-id-a'), {
      id: sharedIntentId,
      now: NOW,
    });

    await expect(
      enqueueProjectEventSourceIntent(testEnv, eventInput(projectId, 'same-project-id-b'), {
        id: sharedIntentId,
        now: NOW,
      })
    ).rejects.toThrow('Project event source outbox intent was not persisted');

    const row = await env.DATABASE.prepare(
      `SELECT project_id, delivery_key, state, admission_outcome
         FROM project_event_source_outbox
        WHERE id = ?`
    )
      .bind(sharedIntentId)
      .first<{
        project_id: string;
        delivery_key: string;
        state: string;
        admission_outcome: string | null;
      }>();
    expect(row).toEqual({
      project_id: projectId,
      delivery_key: 'task:same-project-id-a:status:completed',
      state: 'pending',
      admission_outcome: null,
    });
  });

  it('does not return or mutate a foreign project row when explicit IDs collide on migrated D1', async () => {
    const first = await seedProjectGraph('id-collision-a');
    const second = await seedProjectGraph('id-collision-b');
    const sharedIntentId = `${TEST_PREFIX}-shared-intent-id`;
    await enqueueProjectEventSourceIntent(testEnv, eventInput(first.projectId, 'id-collision-a'), {
      id: sharedIntentId,
      now: NOW,
    });

    await expect(
      enqueueProjectEventSourceIntent(testEnv, eventInput(second.projectId, 'id-collision-b'), {
        id: sharedIntentId,
        now: NOW,
      })
    ).rejects.toThrow('Project event source outbox intent was not persisted');

    const row = await env.DATABASE.prepare(
      `SELECT project_id, delivery_key, state, admission_outcome
         FROM project_event_source_outbox
        WHERE id = ?`
    )
      .bind(sharedIntentId)
      .first<{
        project_id: string;
        delivery_key: string;
        state: string;
        admission_outcome: string | null;
      }>();
    expect(row).toEqual({
      project_id: first.projectId,
      delivery_key: 'task:id-collision-a:status:completed',
      state: 'pending',
      admission_outcome: null,
    });
  });

  it('does not return or mutate a foreign row when scoped supersession misses on migrated D1', async () => {
    const first = await seedProjectGraph('supersede-a');
    const second = await seedProjectGraph('supersede-b');
    const sharedIntentId = `${TEST_PREFIX}-foreign-supersede-intent`;
    await enqueueProjectEventSourceIntent(
      testEnv,
      eventInput(first.projectId, 'foreign-supersede'),
      {
        id: sharedIntentId,
        now: NOW,
      }
    );

    await expect(
      readProjectEventSourceIntentById(testEnv, {
        id: sharedIntentId,
        projectId: second.projectId,
        source: 'sam.lifecycle',
        deliveryKey: 'task:foreign-supersede:status:completed',
      })
    ).resolves.toBeNull();
    await expect(
      markProjectEventSourceIntentSuperseded(testEnv, {
        id: sharedIntentId,
        projectId: second.projectId,
        source: 'sam.lifecycle',
        deliveryKey: 'task:foreign-supersede:status:completed',
        now: NOW,
        reason: 'wrong project should not leak',
      })
    ).resolves.toBeNull();

    expect(await outboxRow(sharedIntentId)).toMatchObject({
      state: 'pending',
      attempt_count: 0,
      claim_token: null,
    });
  });

  it('requires the two-mutation candidate minimum on migrated D1', async () => {
    const { projectId } = await seedProjectGraph('mutation-budget');
    await enqueueProjectEventSourceIntent(testEnv, eventInput(projectId, 'budget-a'), {
      id: `${projectId}-budget-a-intent`,
      now: NOW,
    });
    await enqueueProjectEventSourceIntent(testEnv, eventInput(projectId, 'budget-b'), {
      id: `${projectId}-budget-b-intent`,
      now: NOW,
    });

    const tooSmall = await reconcileProjectEventSourceOutbox(testEnv, { limit: 1, now: NOW });

    expect(tooSmall).toMatchObject({
      attempted: 0,
      admitted: 0,
      outboxMutations: 0,
      hasMore: true,
    });
    expect(await projectDataService.getProjectEventRecentStatus(testEnv, projectId)).toMatchObject({
      events: [],
    });

    const minimum = await reconcileProjectEventSourceOutbox(testEnv, { limit: 2, now: NOW });

    expect(minimum).toMatchObject({
      attempted: 1,
      admitted: 1,
      outboxMutations: 2,
      hasMore: true,
    });
    expect(await outboxRow(`${projectId}-budget-a-intent`)).toMatchObject({
      state: 'admitted',
      attempt_count: 1,
      admission_outcome: 'created',
    });
    expect(await outboxRow(`${projectId}-budget-b-intent`)).toMatchObject({
      state: 'pending',
      attempt_count: 0,
    });
  });

  it('captures credential limit intents only for matching 0146 identity on migrated D1', async () => {
    const { projectId } = await seedProjectGraph('credential-capture');
    const observedAt = NOW.getTime();
    const credentialEvent = eventInput(projectId, 'credential-capture', {
      source: 'sam.credential_limit',
      eventType: 'credential.limit.warning',
      subject: { type: 'credential', id: 'cc_credentials:worker-credential' },
      deliveryKey: 'credential-limit:worker-capture',
      payloadFingerprint: 'sha256:worker-credential-window',
      metadata: { level: 'warning', windowType: 'openai.tokens', observedAt },
    });
    const capture = {
      kind: 'credential_limit_window_transition' as const,
      projectId,
      credentialReference: 'cc_credentials:worker-credential',
      windowType: 'openai.tokens',
      observedAt,
      maxActiveIntentsPerProject: 5,
    };

    const inserted = await projectEventSourceOutboxInsertStatement(testEnv, credentialEvent, {
      id: `${projectId}-credential-capture-intent`,
      now: NOW,
      capture,
    }).run();

    expect(inserted.meta.changes).toBe(1);
    await expect(
      env.DATABASE.prepare(
        `SELECT credential_limit_window_type, credential_limit_observed_at
           FROM project_event_source_outbox
          WHERE id = ?`
      )
        .bind(`${projectId}-credential-capture-intent`)
        .first()
    ).resolves.toEqual({
      credential_limit_window_type: 'openai.tokens',
      credential_limit_observed_at: observedAt,
    });
    const mismatchInputs = [
      { ...credentialEvent, source: 'sam.lifecycle' },
      { ...credentialEvent, subject: { type: 'task', id: 'cc_credentials:worker-credential' } },
      { ...credentialEvent, eventType: 'task.completed' },
      {
        ...credentialEvent,
        metadata: { ...credentialEvent.metadata, windowType: 'openai.requests' },
      },
      {
        ...credentialEvent,
        metadata: { ...credentialEvent.metadata, observedAt: observedAt + 1 },
      },
    ];
    for (const input of mismatchInputs) {
      expect(() =>
        projectEventSourceOutboxInsertStatement(testEnv, input, {
          id: `${projectId}-credential-capture-mismatch`,
          now: NOW,
          capture,
        })
      ).toThrow();
    }
    expect(() =>
      projectEventSourceOutboxInsertStatement(testEnv, credentialEvent, {
        id: `${projectId}-credential-capture-unsupported`,
        now: NOW,
        capture: { kind: 'unsupported', projectId } as never,
      })
    ).toThrow('Unsupported project event source outbox capture kind');
  });

  it('does not enter ProjectData after ownership is lost before admission on migrated D1', async () => {
    const { projectId } = await seedProjectGraph('lost-before-admission');
    const intentId = `${projectId}-intent-lost-before-admission-worker`;
    await enqueueProjectEventSourceIntent(testEnv, eventInput(projectId, 'lost-before-admission'), {
      id: intentId,
      now: NOW,
    });
    const database = env.DATABASE;
    let claimReads = 0;
    const raceEnv = {
      ...testEnv,
      DATABASE: {
        prepare: (sql: string) => {
          if (sql.includes("WHERE id = ? AND state = 'processing' AND claim_token = ?")) {
            claimReads += 1;
            if (claimReads === 2) {
              void database
                .prepare(
                  `UPDATE project_event_source_outbox
                      SET claim_token = 'replacement-before-projectdata',
                          attempt_count = 2,
                          claimed_at = ?,
                          processing_lease_expires_at = ?,
                          updated_at = ?
                    WHERE id = ?`
                )
                .bind(
                  NOW.toISOString(),
                  new Date(NOW.getTime() + 60_000).toISOString(),
                  NOW.toISOString(),
                  intentId
                )
                .run();
            }
          }
          return database.prepare(sql);
        },
        exec: database.exec.bind(database),
        dump: database.dump.bind(database),
        batch: database.batch.bind(database),
      } as D1Database,
    } as Env;

    const result = await admitProjectEventSourceIntentById(raceEnv, intentId, NOW);

    expect(result).toMatchObject({ state: 'processing', attemptCount: 2 });
    expect(await outboxRow(intentId)).toMatchObject({
      state: 'processing',
      attempt_count: 2,
      claim_token: 'replacement-before-projectdata',
      admitted_event_id: null,
    });
    const status = await projectDataService.getProjectEventRecentStatus(testEnv, projectId);
    expect(status.events).toEqual([]);
  });

  it('keeps live final processing attempts and exhausts abandoned ones after lease expiry on migrated D1', async () => {
    const { projectId } = await seedProjectGraph('live-final');
    const basePayload = JSON.stringify(withoutProjectId(eventInput(projectId, 'live-final')));
    const insert = env.DATABASE.prepare(
      `INSERT INTO project_event_source_outbox
        (id, project_id, source, event_type, subject_type, subject_id, delivery_key,
         payload_fingerprint, event_payload_json, state, attempt_count, max_attempts,
         next_attempt_at, processing_lease_expires_at, expires_at, claim_token,
         created_at, updated_at)
       VALUES (?, ?, 'sam.lifecycle', 'task.completed', 'task', ?, ?, 'sha256:live-final', ?,
        'processing', 3, 3, ?, ?, ?, ?, ?, ?)`
    );
    await insert
      .bind(
        `${projectId}-intent-live-final-worker`,
        projectId,
        'live-final-task-live',
        'live-final-delivery-live',
        basePayload,
        NOW.toISOString(),
        new Date(NOW.getTime() + 60_000).toISOString(),
        new Date(NOW.getTime() + 120_000).toISOString(),
        'live-final-worker-token',
        NOW.toISOString(),
        NOW.toISOString()
      )
      .run();
    await insert
      .bind(
        `${projectId}-intent-abandoned-final-worker`,
        projectId,
        'live-final-task-abandoned',
        'live-final-delivery-abandoned',
        basePayload,
        NOW.toISOString(),
        new Date(NOW.getTime() - 1_000).toISOString(),
        new Date(NOW.getTime() + 120_000).toISOString(),
        'abandoned-final-worker-token',
        NOW.toISOString(),
        NOW.toISOString()
      )
      .run();

    const stats = await reconcileProjectEventSourceOutbox(testEnv, { limit: 10, now: NOW });

    expect(stats).toMatchObject({ permanentFailed: 1 });
    expect(await outboxRow(`${projectId}-intent-live-final-worker`)).toMatchObject({
      state: 'processing',
      claim_token: 'live-final-worker-token',
      terminalized_at: null,
    });
    expect(await outboxRow(`${projectId}-intent-abandoned-final-worker`)).toMatchObject({
      state: 'permanent_failed',
      claim_token: null,
      terminalized_at: NOW.toISOString(),
    });
  });

  it('reclaims upgraded legacy terminal rows with null terminalized timestamps on migrated D1', async () => {
    const { projectId } = await seedProjectGraph('legacy-null-retention');
    const old = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await projectEventSourceOutboxInsertStatement(
      testEnv,
      eventInput(projectId, 'legacy-null-retention'),
      {
        id: `${projectId}-legacy-null-terminal-worker`,
        now: NOW,
      }
    ).run();
    await env.DATABASE.prepare(
      `UPDATE project_event_source_outbox
          SET state = 'admitted', admitted_event_id = 'event-legacy-null',
              admission_outcome = 'created', terminalized_at = NULL,
              created_at = ?, updated_at = ?
        WHERE id = ?`
    )
      .bind(old, old, `${projectId}-legacy-null-terminal-worker`)
      .run();
    const retentionEnv = {
      ...testEnv,
      PROJECT_EVENT_SOURCE_OUTBOX_TERMINAL_RETENTION_MS: '0',
    } as Env;

    const stats = await reconcileProjectEventSourceOutbox(retentionEnv, { limit: 5, now: NOW });

    expect(stats).toMatchObject({ terminalDeleted: 1 });
    expect(await outboxRow(`${projectId}-legacy-null-terminal-worker`)).toBeNull();
  });

  it('bounds expired and exhausted history before due candidate admission', async () => {
    const { projectId } = await seedProjectGraph('history');
    const expiredAt = new Date(NOW.getTime() - 60_000).toISOString();
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    const basePayload = JSON.stringify(withoutProjectId(eventInput(projectId, 'history-base')));
    const insert = env.DATABASE.prepare(
      `INSERT INTO project_event_source_outbox
        (id, project_id, source, event_type, subject_type, subject_id, delivery_key,
         payload_fingerprint, event_payload_json, state, attempt_count, max_attempts,
         next_attempt_at, expires_at, created_at, updated_at)
       VALUES (?, ?, 'sam.lifecycle', 'task.completed', 'task', ?, ?, 'sha256:history', ?,
        ?, ?, 3, ?, ?, ?, ?)`
    );
    for (let i = 0; i < 12; i += 1) {
      await insert
        .bind(
          `${projectId}-history-expired-${i}`,
          projectId,
          `history-expired-task-${i}`,
          `history-expired-delivery-${i}`,
          basePayload,
          'pending',
          0,
          expiredAt,
          expiredAt,
          expiredAt,
          expiredAt
        )
        .run();
    }
    for (let i = 0; i < 4; i += 1) {
      await insert
        .bind(
          `${projectId}-history-exhausted-${i}`,
          projectId,
          `history-exhausted-task-${i}`,
          `history-exhausted-delivery-${i}`,
          basePayload,
          'retryable_failed',
          3,
          NOW.toISOString(),
          future,
          NOW.toISOString(),
          NOW.toISOString()
        )
        .run();
    }
    await projectEventSourceOutboxInsertStatement(testEnv, eventInput(projectId, 'history-due'), {
      id: `${projectId}-history-due-intent`,
      now: NOW,
    }).run();

    const stats = await reconcileProjectEventSourceOutbox(testEnv, { limit: 10, now: NOW });

    expect(stats).toMatchObject({ expired: 10, permanentFailed: 0, attempted: 0, admitted: 0 });
    expect(await outboxRow(`${projectId}-history-due-intent`)).toMatchObject({ state: 'pending' });
  });

  it('reclaims terminal rows after the configured retention horizon', async () => {
    const { projectId } = await seedProjectGraph('retention');
    const oldTerminalizedAt = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await projectEventSourceOutboxInsertStatement(testEnv, eventInput(projectId, 'retention'), {
      id: `${projectId}-retention-intent`,
      now: NOW,
    }).run();
    await env.DATABASE.prepare(
      `UPDATE project_event_source_outbox
          SET state = 'admitted', admitted_event_id = 'event-retention',
              admission_outcome = 'created', terminalized_at = ?, updated_at = ?
        WHERE id = ?`
    )
      .bind(oldTerminalizedAt, oldTerminalizedAt, `${projectId}-retention-intent`)
      .run();

    const stats = await reconcileProjectEventSourceOutbox(testEnv, { limit: 5, now: NOW });

    expect(stats).toMatchObject({ terminalDeleted: 1 });
    expect(await outboxRow(`${projectId}-retention-intent`)).toBeNull();
  });
});
