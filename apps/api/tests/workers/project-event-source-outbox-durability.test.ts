import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdmitProjectEventInput } from '../../src/durable-objects/project-data/project-events';
import type { Env } from '../../src/env';
import * as projectDataService from '../../src/services/project-data';
import {
  admitProjectEventSourceIntentById,
  projectEventSourceOutboxInsertStatement,
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
    `SELECT id, state, attempt_count, admitted_event_id, admission_outcome, terminalized_at
            , claim_token, processing_lease_expires_at
       FROM project_event_source_outbox
      WHERE id = ?
      LIMIT 1`
  )
    .bind(id)
    .first<{
      id: string;
      state: string;
      attempt_count: number;
      admitted_event_id: string | null;
      admission_outcome: string | null;
      terminalized_at: string | null;
      claim_token: string | null;
      processing_lease_expires_at: string | null;
    }>();
}

async function explainPlan(sql: string, ...bindings: unknown[]): Promise<string> {
  const rows = await env.DATABASE.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...bindings)
    .all<Record<string, unknown>>();
  return (rows.results ?? [])
    .map((row) => String(row.detail ?? Object.values(row).join(' ')))
    .join('\n');
}

function expectIndexedPlan(plan: string, indexName: string): void {
  expect(plan).toContain(indexName);
  expect(plan).not.toContain('USE TEMP B-TREE');
  expect(plan).not.toContain('SCAN project_event_source_outbox');
}

describe('Project event source outbox durability on migrated D1', () => {
  beforeEach(async () => {
    await env.DATABASE.prepare(`DELETE FROM project_event_source_outbox WHERE id LIKE ?`)
      .bind(`${TEST_PREFIX}-%`)
      .run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('returns the persisted claim winner when admission success loses its claim-token CAS', async () => {
    const { projectId } = await seedProjectGraph('cas-loser');
    const input = eventInput(projectId, 'cas-loser');
    const intentId = `${projectId}-intent-cas-loser-worker`;
    await projectEventSourceOutboxInsertStatement(testEnv, input, { id: intentId, now: NOW }).run();
    vi.spyOn(projectDataService, 'admitProjectEvent').mockImplementation(async () => {
      await env.DATABASE.prepare(
        `UPDATE project_event_source_outbox
            SET state = 'processing', attempt_count = 2, claim_token = 'claim-b',
                claimed_at = ?, processing_lease_expires_at = ?, updated_at = ?
          WHERE id = ?`
      )
        .bind(
          NOW.toISOString(),
          new Date(NOW.getTime() + 60_000).toISOString(),
          NOW.toISOString(),
          intentId
        )
        .run();
      return {
        outcome: 'created',
        event: { id: 'event-a', state: 'recorded' },
        matches: [],
      } as Awaited<ReturnType<typeof projectDataService.admitProjectEvent>>;
    });

    const result = await admitProjectEventSourceIntentById(testEnv, intentId, NOW);

    expect(result).toMatchObject({ state: 'processing', attemptCount: 2 });
    expect(result?.admissionOutcome).toBeUndefined();
    expect(result?.eventId).toBeUndefined();
    expect(await outboxRow(intentId)).toMatchObject({
      state: 'processing',
      attempt_count: 2,
      claim_token: 'claim-b',
      admitted_event_id: null,
      admission_outcome: null,
    });
  });

  it('does not count a claim-token CAS loser as admitted during reconciliation', async () => {
    const { projectId } = await seedProjectGraph('cas-loser-sweep');
    const input = eventInput(projectId, 'cas-loser-sweep');
    const intentId = `${projectId}-intent-cas-loser-sweep-worker`;
    await projectEventSourceOutboxInsertStatement(testEnv, input, { id: intentId, now: NOW }).run();
    vi.spyOn(projectDataService, 'admitProjectEvent').mockImplementation(async () => {
      await env.DATABASE.prepare(
        `UPDATE project_event_source_outbox
            SET state = 'processing', attempt_count = 2, claim_token = 'claim-b-sweep',
                claimed_at = ?, processing_lease_expires_at = ?, updated_at = ?
          WHERE id = ?`
      )
        .bind(
          NOW.toISOString(),
          new Date(NOW.getTime() + 60_000).toISOString(),
          NOW.toISOString(),
          intentId
        )
        .run();
      return {
        outcome: 'created',
        event: { id: 'event-a', state: 'recorded' },
        matches: [],
      } as Awaited<ReturnType<typeof projectDataService.admitProjectEvent>>;
    });

    const stats = await reconcileProjectEventSourceOutbox(testEnv, { limit: 1, now: NOW });

    expect(stats).toMatchObject({ admitted: 0, retryableFailed: 0, skipped: 1 });
    expect(await outboxRow(intentId)).toMatchObject({
      state: 'processing',
      attempt_count: 2,
      claim_token: 'claim-b-sweep',
      admitted_event_id: null,
    });
  });

  it('does not exhaust a processing final attempt until its lease is abandoned', async () => {
    const { projectId } = await seedProjectGraph('active-final');
    const input = eventInput(projectId, 'active-final');
    const intentId = `${projectId}-intent-active-final-worker`;
    await projectEventSourceOutboxInsertStatement(testEnv, input, { id: intentId, now: NOW }).run();
    await env.DATABASE.prepare(
      `UPDATE project_event_source_outbox
          SET state = 'processing', attempt_count = 8, max_attempts = 8,
              claim_token = 'live-final', claimed_at = ?, processing_lease_expires_at = ?,
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

    const activeResult = await admitProjectEventSourceIntentById(testEnv, intentId, NOW);
    expect(activeResult).toMatchObject({ state: 'processing', attemptCount: 8 });
    expect(await outboxRow(intentId)).toMatchObject({
      state: 'processing',
      attempt_count: 8,
      claim_token: 'live-final',
    });

    const activeSweep = await reconcileProjectEventSourceOutbox(testEnv, { limit: 5, now: NOW });
    expect(activeSweep).toMatchObject({ permanentFailed: 0, admitted: 0 });
    expect(await outboxRow(intentId)).toMatchObject({
      state: 'processing',
      claim_token: 'live-final',
    });

    const abandonedSweep = await reconcileProjectEventSourceOutbox(testEnv, {
      limit: 5,
      now: new Date(NOW.getTime() + 61_000),
    });

    expect(abandonedSweep).toMatchObject({ permanentFailed: 1, admitted: 0 });
    expect(await outboxRow(intentId)).toMatchObject({
      state: 'permanent_failed',
      attempt_count: 8,
      claim_token: null,
    });
  });

  it('captures credential-window source intents only after the matching window wins', async () => {
    const { userId, projectId } = await seedProjectGraph('credential-guard');
    const observedAt = NOW.getTime();
    const deliveryKey = `credential:${projectId}:primary:hourly:${observedAt}`;
    await env.DATABASE.prepare(
      `INSERT INTO credential_limit_windows (
          project_id, credential_reference, window_type, credential_source, provider,
          provider_mode, user_id, source, status, last_event_level, observed_at,
          freshness_ms, last_event_delivery_key, created_at, updated_at
        ) VALUES (?, 'primary', 'hourly', 'project', 'openai', 'user-api-key',
          ?, 'usage-callback', 'allowed_warning', 'warning', ?, 0, ?, ?, ?)`
    )
      .bind(projectId, userId, observedAt, deliveryKey, observedAt, observedAt)
      .run();
    const credentialInput = eventInput(projectId, 'credential-guard', {
      source: 'sam.credential_limit',
      eventType: 'credential_limit.warning',
      subject: { type: 'credential_limit_window', id: 'primary:hourly' },
      deliveryKey,
      payloadFingerprint: 'sha256:credential-window',
    });

    await projectEventSourceOutboxInsertStatement(testEnv, credentialInput, {
      id: `${projectId}-credential-guard-intent`,
      now: NOW,
      capture: {
        kind: 'credential_limit_window',
        projectId,
        credentialReference: 'primary',
        windowType: 'hourly',
        observedAt,
        deliveryKey,
      },
    }).run();
    await projectEventSourceOutboxInsertStatement(
      testEnv,
      { ...credentialInput, deliveryKey: `${deliveryKey}:stale` },
      {
        id: `${projectId}-credential-guard-stale-intent`,
        now: NOW,
        capture: {
          kind: 'credential_limit_window',
          projectId,
          credentialReference: 'primary',
          windowType: 'hourly',
          observedAt: observedAt - 1,
          deliveryKey: `${deliveryKey}:stale`,
        },
      }
    ).run();

    expect(await outboxRow(`${projectId}-credential-guard-intent`)).toMatchObject({
      state: 'pending',
    });
    expect(await outboxRow(`${projectId}-credential-guard-stale-intent`)).toBeNull();
    expect(() =>
      projectEventSourceOutboxInsertStatement(testEnv, credentialInput, {
        capture: {
          kind: 'credential_limit_window',
          projectId,
          credentialReference: 'primary',
          windowType: 'hourly',
          observedAt,
          deliveryKey: `${deliveryKey}:mismatch`,
        },
      })
    ).toThrow('delivery key must match');
  });

  it('uses indexed bounded plans for outbox maintenance and candidate windows', async () => {
    const nowIso = NOW.toISOString();
    const expiryPlan = await explainPlan(
      `SELECT id FROM project_event_source_outbox
        WHERE state = ? AND expires_at <= ?
        ORDER BY expires_at, id
        LIMIT ?`,
      'pending',
      nowIso,
      10
    );
    expectIndexedPlan(expiryPlan, 'idx_project_event_source_outbox_active_expiry');

    const pendingExhaustionPlan = await explainPlan(
      `SELECT id FROM (
         SELECT id, attempt_count, max_attempts, expires_at
           FROM project_event_source_outbox
          WHERE state = ? AND next_attempt_at <= ?
          ORDER BY next_attempt_at, id
          LIMIT ?
       )
       WHERE attempt_count >= max_attempts AND expires_at > ?`,
      'pending',
      nowIso,
      10,
      nowIso
    );
    expectIndexedPlan(pendingExhaustionPlan, 'idx_project_event_source_outbox_due');

    const processingExhaustionPlan = await explainPlan(
      `SELECT id FROM (
         SELECT id, attempt_count, max_attempts, expires_at
           FROM project_event_source_outbox
          WHERE state = 'processing' AND processing_lease_expires_at IS NOT NULL
            AND processing_lease_expires_at <= ?
          ORDER BY processing_lease_expires_at, id
          LIMIT ?
       )
       WHERE attempt_count >= max_attempts AND expires_at > ?`,
      nowIso,
      10,
      nowIso
    );
    expectIndexedPlan(processingExhaustionPlan, 'idx_project_event_source_outbox_processing_lease');

    const duePlan = await explainPlan(
      `SELECT id FROM (
         SELECT id, expires_at, attempt_count, max_attempts
           FROM project_event_source_outbox
          WHERE state = ? AND next_attempt_at <= ?
          ORDER BY next_attempt_at, id
          LIMIT ?
       )
       WHERE expires_at > ? AND attempt_count < max_attempts`,
      'retryable_failed',
      nowIso,
      10,
      nowIso
    );
    expectIndexedPlan(duePlan, 'idx_project_event_source_outbox_due');

    const leasePlan = await explainPlan(
      `SELECT id FROM (
         SELECT id, expires_at, attempt_count, max_attempts
           FROM project_event_source_outbox
          WHERE state = 'processing' AND processing_lease_expires_at IS NOT NULL
            AND processing_lease_expires_at <= ?
          ORDER BY processing_lease_expires_at, id
          LIMIT ?
       )
       WHERE expires_at > ? AND attempt_count < max_attempts`,
      nowIso,
      10,
      nowIso
    );
    expectIndexedPlan(leasePlan, 'idx_project_event_source_outbox_processing_lease');

    const retentionPlan = await explainPlan(
      `SELECT id FROM project_event_source_outbox
        WHERE state = ? AND terminalized_at IS NOT NULL AND terminalized_at <= ?
        ORDER BY terminalized_at, id
        LIMIT ?`,
      'admitted',
      nowIso,
      10
    );
    expectIndexedPlan(retentionPlan, 'idx_project_event_source_outbox_terminal_retention');
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
