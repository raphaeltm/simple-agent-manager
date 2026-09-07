import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { AdmitProjectEventInput } from '../../src/durable-objects/project-data/project-events';
import {
  runProjectEventWakeMaterializationBatch,
  terminalizeProjectEventWakeMatches,
} from '../../src/durable-objects/project-data/project-events-materialization';
import {
  advanceProjectEventPromptAttemptCheckpoint,
  hasProjectEventWakeLease,
  invalidProjectEventWakeDeliveryTargetResult,
  readProjectEventWakeLeaseUntil,
} from '../../src/durable-objects/project-data/project-events-wake-delivery';
import {
  computeProjectEventMaterializationAlarmTime,
  computeProjectEventRetentionAlarmTime,
} from '../../src/durable-objects/project-data/project-events-scheduler';
import type { PromptDeliveryResult } from '../../src/durable-objects/project-data/prompt-delivery';
import { parseMailboxMessageRow } from '../../src/durable-objects/project-data/row-schemas';
import type { Env } from '../../src/env';
import * as svc from '../../src/services/project-data';
import { seedInstallation, seedProject, seedTask, seedUser } from './helpers/seed-d1';
import {
  captureProjectDataExpectedError,
  type ProjectDataTestDouble,
} from './support/expected-error-doubles';

const testEnv = env as unknown as Env;

function getStub(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectDataTestDouble>;
}

function eventInput(
  overrides: Partial<Omit<AdmitProjectEventInput, 'projectId'>> = {}
): Omit<AdmitProjectEventInput, 'projectId'> {
  return {
    source: 'github',
    eventType: 'check_suite.completed',
    subject: { type: 'pull_request', id: '42' },
    severity: 'warning',
    deliveryKey: 'delivery-1',
    payloadFingerprint: 'sha256:fingerprint-1',
    metadata: { conclusion: 'failure' },
    display: { title: 'CI failed', summary: 'A bounded normalized event' },
    occurredAt: 1000,
    receivedAt: 1001,
    ...overrides,
  };
}

function subscriptionInput(idempotencyKey: string) {
  return {
    owner: { type: 'agent' as const, id: 'agent-1', name: 'Agent One' },
    idempotencyKey,
    filter: {
      version: 1 as const,
      source: 'github',
      eventType: 'check_suite.completed',
      subjectType: 'pull_request',
      severity: ['warning' as const, 'error' as const],
    },
    deliveryPreference: {
      requested: 'existing_session_prompt' as const,
      resolved: 'recorded_not_injected' as const,
      target: { sessionId: 'session-1', taskId: 'task-1', agentId: 'agent-1' },
    },
    reason: 'Watch pull request CI failures',
  };
}

function subscriptionInputForSession(idempotencyKey: string, sessionId: string) {
  return {
    ...subscriptionInput(idempotencyKey),
    deliveryPreference: {
      requested: 'existing_session_prompt' as const,
      resolved: 'queued_for_prompt_delivery' as const,
      target: { sessionId, taskId: 'task-1', agentId: 'agent-1' },
    },
  };
}

function durableQueueCapability() {
  return {
    adapterId: 'projectdata-prompt-queue',
    adapterKind: 'durable_queue' as const,
    agentType: null,
    protocol: 'projectdata',
    protocolVersion: '1',
    capabilities: ['durable_prompt_queue' as const],
    durableAck: true,
    available: true,
  };
}

async function withEventEnv<T>(
  overrides: Record<string, string>,
  fn: () => Promise<T>
): Promise<T> {
  const mutableEnv = testEnv as Env & Record<string, string | undefined>;
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, mutableEnv[key]);
    mutableEnv[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete mutableEnv[key];
      else mutableEnv[key] = value;
    }
  }
}

function setEventEnvForTest(key: string, value: string): () => void {
  const mutableEnv = testEnv as Env & Record<string, string | undefined>;
  const previous = mutableEnv[key];
  mutableEnv[key] = value;
  return () => {
    if (previous === undefined) delete mutableEnv[key];
    else mutableEnv[key] = previous;
  };
}

async function sessionInboxCount(projectId: string): Promise<number> {
  const stub = getStub(projectId);
  await stub.ensureProjectId(projectId);
  return runInDurableObject(stub, async (_instance, state) => {
    const row = state.storage.sql.exec('SELECT COUNT(*) AS cnt FROM session_inbox').toArray()[0] as
      | { cnt?: unknown }
      | undefined;
    return typeof row?.cnt === 'number' ? row.cnt : 0;
  });
}

async function materializeEventWakeForTest(
  projectId: string,
  now: number,
  overrides: Record<string, string> = {}
) {
  const stub = getStub(projectId);
  return runInDurableObject(stub, async (_instance, state) =>
    state.storage.transactionSync(() =>
      runProjectEventWakeMaterializationBatch(
        state.storage.sql,
        { ...testEnv, PROJECT_EVENT_WAKE_ENABLED: 'true', ...overrides },
        projectId,
        now
      )
    )
  );
}

async function disableProjectEventWakeOnStub(projectId: string): Promise<void> {
  const stub = getStub(projectId);
  await runInDurableObject(stub, async (instance) => {
    (
      instance as unknown as { env: Env & Record<string, string | undefined> }
    ).env.PROJECT_EVENT_WAKE_ENABLED = 'false';
    (
      instance as unknown as { env: Env & Record<string, string | undefined> }
    ).env.DURABLE_PROMPT_DELIVERY_ENABLED = 'false';
  });
}

describe('ProjectData event subscription core', () => {
  it('admits normalized events idempotently and exposes same-key fingerprint conflicts', async () => {
    const projectId = 'project-events-admission';

    const created = await svc.admitProjectEvent(testEnv, projectId, eventInput());
    expect(created.outcome).toBe('created');
    expect(created.event).toMatchObject({
      projectId,
      source: 'github',
      eventType: 'check_suite.completed',
      state: 'recorded',
      duplicateCount: 0,
    });

    const duplicate = await svc.admitProjectEvent(testEnv, projectId, eventInput());
    expect(duplicate.outcome).toBe('duplicate_replay');
    expect(duplicate.event.id).toBe(created.event.id);
    expect(duplicate.event.duplicateCount).toBe(1);

    const conflicted = await svc.admitProjectEvent(
      testEnv,
      projectId,
      eventInput({ payloadFingerprint: 'sha256:fingerprint-2' })
    );
    expect(conflicted.outcome).toBe('conflict');
    expect(conflicted.event.id).toBe(created.event.id);
    expect(conflicted.event.state).toBe('conflicted');
    expect(conflicted.conflict).toEqual({
      deliveryKey: 'delivery-1',
      existingFingerprint: 'sha256:fingerprint-1',
      incomingFingerprint: 'sha256:fingerprint-2',
    });
  });

  it('matches events through stored match keys and records delivery batches without prompt injection', async () => {
    const projectId = 'project-events-match-and-batch';
    const subscription = await svc.createProjectEventSubscription(
      testEnv,
      projectId,
      subscriptionInput('sub-match-1')
    );
    const listedSubscriptions = await svc.listProjectEventSubscriptions(testEnv, projectId);
    expect(listedSubscriptions.subscriptions.map((item) => item.id)).toContain(
      subscription.subscription.id
    );
    await expect(
      svc.getProjectEventSubscription(testEnv, projectId, {
        subscriptionId: subscription.subscription.id,
      })
    ).resolves.toMatchObject({
      id: subscription.subscription.id,
      filterFingerprint: subscription.subscription.filterFingerprint,
    });

    const admitted = await svc.admitProjectEvent(testEnv, projectId, eventInput());
    expect(admitted.matches).toHaveLength(1);
    expect(admitted.matches[0]).toMatchObject({
      subscriptionId: subscription.subscription.id,
      state: 'matched',
    });

    const batch = await svc.createProjectEventDeliveryBatch(testEnv, projectId, {
      subscriptionId: subscription.subscription.id,
      matchIds: [admitted.matches[0].id],
      idempotencyKey: 'batch-1',
      requestedDelivery: 'existing_session_prompt',
      terminalReason: 'foundation records the event but does not inject',
    });
    expect(batch.batch).toMatchObject({
      state: 'recorded_not_injected',
      requestedDelivery: 'existing_session_prompt',
      resolvedDelivery: 'unsupported',
      adapterDecision: {
        action: 'unsupported',
        reason: 'unsupported_delivery',
        capability: 'durable_prompt_queue',
      },
      eventCount: 1,
    });

    const replay = await svc.createProjectEventDeliveryBatch(testEnv, projectId, {
      subscriptionId: subscription.subscription.id,
      matchIds: [admitted.matches[0].id],
      idempotencyKey: 'batch-1',
      requestedDelivery: 'existing_session_prompt',
      terminalReason: 'foundation records the event but does not inject',
    });
    expect(replay.idempotent).toBe(true);
    expect(replay.batch.id).toBe(batch.batch.id);

    const duplicateBatch = await captureProjectDataExpectedError(getStub(projectId), {
      operation: 'createProjectEventDeliveryBatch',
      args: [
        {
          projectId,
          subscriptionId: subscription.subscription.id,
          matchIds: [admitted.matches[0].id],
          idempotencyKey: 'batch-duplicate-match',
          requestedDelivery: 'existing_session_prompt',
        },
      ],
    });
    expect(duplicateBatch).toMatchObject({
      threw: true,
      code: 'PROJECT_EVENT_VALIDATION',
    });
    expect(duplicateBatch.message).toMatch(/already belongs to a delivery batch/);

    const secondAdmitted = await svc.admitProjectEvent(
      testEnv,
      projectId,
      eventInput({
        deliveryKey: 'delivery-2',
        payloadFingerprint: 'sha256:fingerprint-2',
      })
    );
    const conflict = await captureProjectDataExpectedError(getStub(projectId), {
      operation: 'createProjectEventDeliveryBatch',
      args: [
        {
          projectId,
          subscriptionId: subscription.subscription.id,
          matchIds: [secondAdmitted.matches[0].id],
          idempotencyKey: 'batch-1',
          requestedDelivery: 'existing_session_prompt',
        },
      ],
    });
    expect(conflict).toMatchObject({
      threw: true,
      code: 'PROJECT_EVENT_IDEMPOTENCY_CONFLICT',
    });

    const attempt = await svc.recordProjectEventDeliveryAttempt(testEnv, projectId, {
      batchId: batch.batch.id,
      idempotencyKey: 'attempt-1',
      state: 'recorded_not_injected',
      adapter: 'foundation',
      errorMessage: 'Runtime injection intentionally deferred',
    });
    expect(attempt).toMatchObject({
      changed: true,
      attempt: { state: 'recorded_not_injected', attemptNumber: 1 },
      batch: { state: 'recorded_not_injected' },
    });
    const listedBatches = await svc.listProjectEventDeliveryBatches(testEnv, projectId, {
      subscriptionId: subscription.subscription.id,
    });
    expect(listedBatches.batches.map((item) => item.id)).toContain(batch.batch.id);
    const listedAttempts = await svc.listProjectEventDeliveryAttempts(testEnv, projectId, {
      batchId: batch.batch.id,
    });
    expect(listedAttempts.attempts.map((item) => item.id)).toContain(attempt.attempt.id);
    expect(await sessionInboxCount(projectId)).toBe(0);
  });

  it('persists queued resolver decisions without injecting prompts in this wave', async () => {
    const projectId = 'project-events-queued-resolution';
    const subscription = await svc.createProjectEventSubscription(
      testEnv,
      projectId,
      subscriptionInput('sub-queue-1')
    );
    const admitted = await svc.admitProjectEvent(testEnv, projectId, eventInput());

    const batch = await svc.createProjectEventDeliveryBatch(testEnv, projectId, {
      subscriptionId: subscription.subscription.id,
      matchIds: [admitted.matches[0].id],
      idempotencyKey: 'batch-queue-1',
      adapterCapabilities: [durableQueueCapability()],
      authorization: { allowPromptQueue: true },
    });

    expect(batch.batch).toMatchObject({
      state: 'pending',
      requestedDelivery: 'existing_session_prompt',
      resolvedDelivery: 'queued_for_prompt_delivery',
      adapterDecision: {
        action: 'queue_prompt_delivery',
        adapterId: 'projectdata-prompt-queue',
        adapterKind: 'durable_queue',
        durableAck: true,
        supported: true,
        authorized: true,
        terminal: false,
      },
      target: {
        sessionId: 'session-1',
        taskId: 'task-1',
        agentId: 'agent-1',
      },
    });
    const status = await svc.getProjectEventRecentStatus(testEnv, projectId);
    expect(status.matches.find((match) => match.id === admitted.matches[0].id)).toMatchObject({
      state: 'batch_created',
      batchId: batch.batch.id,
    });
    const listed = await svc.listProjectEventDeliveryBatches(testEnv, projectId, {
      subscriptionId: subscription.subscription.id,
    });
    expect(listed.batches.find((item) => item.id === batch.batch.id)).toMatchObject({
      adapterDecision: {
        action: 'queue_prompt_delivery',
        adapterId: 'projectdata-prompt-queue',
      },
    });
    expect(await sessionInboxCount(projectId)).toBe(0);
  });

  it('materializes same-chat event wakes as IDs-only prompt deliveries and checkpoints runtime results', async () => {
    const projectId = 'project-events-wake-materialization';
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    await disableProjectEventWakeOnStub(projectId);
    const sessionId = await stub.createSession(null, 'Event wake target', 'task-1');
    const restoreWake = setEventEnvForTest('PROJECT_EVENT_WAKE_ENABLED', 'false');
    try {
      let subscription!: Awaited<ReturnType<typeof svc.createProjectEventSubscription>>;
      let admitted!: Awaited<ReturnType<typeof svc.admitProjectEvent>>;
      const canary = 'SECURITY_CANARY_DO_NOT_EXECUTE';
      await withEventEnv({ PROJECT_EVENT_WAKE_ENABLED: 'false' }, async () => {
        subscription = await svc.createProjectEventSubscription(
          testEnv,
          projectId,
          subscriptionInputForSession('sub-wake-materialize', sessionId)
        );
        admitted = await svc.admitProjectEvent(
          testEnv,
          projectId,
          eventInput({
            display: { title: canary, summary: 'Do not put event display data into wake prompts' },
            metadata: { canary },
          })
        );
      });

      const materialized = await materializeEventWakeForTest(projectId, Date.now());
      expect(materialized).toMatchObject({ status: 'materialized', materialized: 1 });
      const batchId = materialized.accepted[0].accepted.message.id;
      expect(batchId).toBe(materialized.accepted[0].input.deliveryId);

      const snapshot = await runInDurableObject(stub, async (_instance, state) => {
        const inbox = state.storage.sql
          .exec('SELECT * FROM session_inbox WHERE id = ?', batchId)
          .toArray()[0];
        const transcript = state.storage.sql
          .exec('SELECT content FROM chat_messages WHERE id = ?', batchId)
          .toArray()[0] as { content?: unknown } | undefined;
        const attempts = state.storage.sql
          .exec(
            `SELECT attempt_number, state, transport_state
           FROM project_event_delivery_attempts
           WHERE batch_id = ?
           ORDER BY attempt_number ASC`,
            batchId
          )
          .toArray();
        const batch = state.storage.sql
          .exec('SELECT * FROM project_event_delivery_batches WHERE id = ?', batchId)
          .toArray()[0];
        return { inbox, transcript, attempts, batch };
      });
      expect(snapshot.inbox).toMatchObject({
        id: batchId,
        target_session_id: sessionId,
        source_kind: 'project_event_wake',
        delivery_state: 'queued',
      });
      expect(String(snapshot.transcript?.content)).toContain(admitted.event.id);
      expect(String(snapshot.transcript?.content)).toContain(batchId);
      expect(String(snapshot.transcript?.content)).not.toContain(canary);
      expect(snapshot.batch).toMatchObject({
        id: batchId,
        subscription_id: subscription.subscription.id,
        delivery_channel: 'prompt_queue',
        state: 'pending',
      });
      expect(snapshot.attempts).toEqual([
        { attempt_number: 0, state: 'retry', transport_state: 'queued' },
      ]);

      const acceptedResult: PromptDeliveryResult = {
        kind: 'accepted',
        acpSessionId: sessionId,
        promptEpoch: 123,
        runtimeIdentity: 'runtime:event-wake',
        capabilities: {
          protocolVersion: 1,
          runtimeIdentity: 'runtime:event-wake',
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
          deliveryId: 'receipt:event-wake',
          state: 'accepted',
          runtimeIdentity: 'runtime:event-wake',
          acceptedAt: Date.now(),
          completedAt: null,
        },
      };
      await runInDurableObject(stub, async (_instance, state) => {
        const message = parseMailboxMessageRow(
          state.storage.sql.exec('SELECT * FROM session_inbox WHERE id = ?', batchId).toArray()[0]
        );
        advanceProjectEventPromptAttemptCheckpoint(
          state.storage.sql,
          projectId,
          { message, attemptId: 'runtime-attempt-1', mode: 'submit' },
          acceptedResult
        );
      });
      const delivered = await svc.listProjectEventDeliveryBatches(testEnv, projectId, {
        subscriptionId: subscription.subscription.id,
      });
      expect(delivered.batches.find((item) => item.id === batchId)).toMatchObject({
        state: 'delivered',
        deliveryChannel: 'prompt_queue',
        deliveredVia: 'prompt_queue',
      });
      const attempts = await svc.listProjectEventDeliveryAttempts(testEnv, projectId, {
        batchId,
      });
      expect(attempts.attempts.map((item) => item.attemptNumber)).toEqual([1, 0]);
      expect(attempts.attempts.find((item) => item.attemptNumber === 1)).toMatchObject({
        state: 'accepted',
        receiptId: 'receipt:event-wake',
      });
    } finally {
      restoreWake();
    }
  });

  it('defers a blocked oldest wake target and materializes a ready later target with large history', async () => {
    const projectId = 'project-events-wake-fair-blocked-target';
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    await disableProjectEventWakeOnStub(projectId);
    const blockedSessionId = await stub.createSession(null, 'Blocked wake target', 'task-blocked-a');
    const readySessionId = await stub.createSession(null, 'Ready wake target', 'task-ready-b');
    const fairEnv = {
      PROJECT_EVENT_WAKE_ENABLED: 'false',
      PROJECT_EVENT_MAX_ACTIVE_SUBSCRIPTIONS_PER_PROJECT: '2',
      PROJECT_EVENT_DELIVERY_BATCH_MAX_EVENTS: '5',
      PROJECT_EVENT_WAKE_TARGET_COOLDOWN_MS: '30000',
    };
    let blocked!: Awaited<ReturnType<typeof svc.createProjectEventSubscription>>;
    let ready!: Awaited<ReturnType<typeof svc.createProjectEventSubscription>>;
    await withEventEnv(fairEnv, async () => {
      blocked = await svc.createProjectEventSubscription(testEnv, projectId, {
        ...subscriptionInputForSession('sub-fair-blocked-a', blockedSessionId),
        deliveryPreference: {
          requested: 'existing_session_prompt',
          resolved: 'queued_for_prompt_delivery',
          target: { sessionId: blockedSessionId, taskId: 'task-blocked-a', agentId: 'agent-1' },
        },
      });
      ready = await svc.createProjectEventSubscription(testEnv, projectId, {
        ...subscriptionInputForSession('sub-fair-ready-b', readySessionId),
        deliveryPreference: {
          requested: 'existing_session_prompt',
          resolved: 'queued_for_prompt_delivery',
          target: { sessionId: readySessionId, taskId: 'task-ready-b', agentId: 'agent-1' },
        },
      });
    });

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO project_event_delivery_batches
         (id, project_id, subscription_id, idempotency_key, idempotency_fingerprint, state,
          delivery_channel, delivery_expires_at, readable_until, ack_required,
          requested_delivery, resolved_delivery, adapter_decision_json,
          target_session_id, target_task_id, target_runtime_id, target_agent_id,
          match_ids_json, event_count, created_at, updated_at, terminal_reason)
         VALUES ('batch-fair-blocked-a-live', ?, ?, 'fair-blocked-live', 'fair-blocked-live-fp',
          'pending', 'prompt_queue', 60000, 60000, 1, 'existing_session_prompt',
          'queued_for_prompt_delivery', '{}', ?, 'task-blocked-a', NULL, 'agent-1',
          '[]', 0, 1000, 1000, NULL)`,
        projectId,
        blocked.subscription.id,
        blockedSessionId
      );
      for (let index = 0; index < 120; index += 1) {
        const eventId = `event-fair-blocked-a-${index}`;
        state.storage.sql.exec(
          `INSERT INTO project_events
           (id, project_id, contract_version, source, event_type, subject_type, subject_id,
            severity, delivery_key, payload_fingerprint, metadata_json, metadata_bytes,
            display_json, display_bytes, raw_payload_ref_json, raw_payload_ref_bytes,
            occurred_at, received_at, updated_at, state)
           VALUES (?, ?, 1, 'github', 'check_suite.completed', 'pull_request', ?,
            'warning', ?, ?, '{}', 2, '{"untrusted":true}', 18, NULL, 0, ?, ?, ?, 'recorded')`,
          eventId,
          projectId,
          `fair-blocked-a-${index}`,
          `delivery-fair-blocked-a-${index}`,
          `sha256:fair-blocked-a-${index}`,
          1000 + index,
          1000 + index,
          1000 + index
        );
        state.storage.sql.exec(
          `INSERT INTO project_event_matches
           (id, project_id, event_id, subscription_id, state, matched_at,
            lifecycle_checked_at, batch_id, reason)
           VALUES (?, ?, ?, ?, 'matched', ?, ?, NULL, NULL)`,
          `match-fair-blocked-a-${index}`,
          projectId,
          eventId,
          blocked.subscription.id,
          1000 + index,
          1000 + index
        );
      }
      state.storage.sql.exec(
        `INSERT INTO project_events
         (id, project_id, contract_version, source, event_type, subject_type, subject_id,
          severity, delivery_key, payload_fingerprint, metadata_json, metadata_bytes,
          display_json, display_bytes, raw_payload_ref_json, raw_payload_ref_bytes,
          occurred_at, received_at, updated_at, state)
         VALUES ('event-fair-ready-b', ?, 1, 'github', 'check_suite.completed', 'pull_request',
          'fair-ready-b', 'warning', 'delivery-fair-ready-b', 'sha256:fair-ready-b',
          '{}', 2, '{"untrusted":true}', 18, NULL, 0, 2000, 2000, 2000, 'recorded')`,
        projectId
      );
      state.storage.sql.exec(
        `INSERT INTO project_event_matches
         (id, project_id, event_id, subscription_id, state, matched_at,
          lifecycle_checked_at, batch_id, reason)
         VALUES ('match-fair-ready-b', ?, 'event-fair-ready-b', ?, 'matched', 2000, 2000, NULL, NULL)`,
        projectId,
        ready.subscription.id
      );
      state.storage.sql.exec(
        `UPDATE project_event_subscriptions
         SET last_matched_at = CASE
             WHEN id = ? THEN 1000
             WHEN id = ? THEN 2000
             ELSE last_matched_at
           END
         WHERE project_id = ?`,
        blocked.subscription.id,
        ready.subscription.id,
        projectId
      );
    });

    const materialized = await materializeEventWakeForTest(projectId, 20_000, {
      PROJECT_EVENT_MAX_ACTIVE_SUBSCRIPTIONS_PER_PROJECT: '2',
      PROJECT_EVENT_DELIVERY_BATCH_MAX_EVENTS: '5',
      PROJECT_EVENT_WAKE_TARGET_COOLDOWN_MS: '30000',
    });
    expect(materialized).toMatchObject({ status: 'materialized', materialized: 1 });
    expect(materialized.accepted[0]?.input.targetSessionId).toBe(readySessionId);

    const snapshot = await runInDurableObject(stub, async (_instance, state) => ({
      blockedMatches: state.storage.sql
        .exec(
          `SELECT state, COUNT(*) AS cnt
           FROM project_event_matches
           WHERE subscription_id = ?
           GROUP BY state`,
          blocked.subscription.id
        )
        .toArray(),
      readyMatches: state.storage.sql
        .exec(
          `SELECT state, COUNT(*) AS cnt
           FROM project_event_matches
           WHERE subscription_id = ?
           GROUP BY state`,
          ready.subscription.id
        )
        .toArray(),
      subscriptions: state.storage.sql
        .exec(
          `SELECT id, delivery_cooldown_until, prompt_delivery_count
           FROM project_event_subscriptions
           WHERE id IN (?, ?)
           ORDER BY id`,
          blocked.subscription.id,
          ready.subscription.id
        )
        .toArray(),
    }));
    expect(snapshot.blockedMatches).toEqual([{ state: 'matched', cnt: 120 }]);
    expect(snapshot.readyMatches).toEqual([{ state: 'batch_created', cnt: 1 }]);
    expect(snapshot.subscriptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: blocked.subscription.id,
          delivery_cooldown_until: 60000,
          prompt_delivery_count: 0,
        }),
        expect.objectContaining({
          id: ready.subscription.id,
          prompt_delivery_count: 1,
        }),
      ])
    );
  });

  it('cancels event wake materialization from a revoked D1 source before queueing a prompt', async () => {
    const projectId = 'project-events-materialization-revoked-source';
    const userId = 'user-event-wake-revoked-source';
    const installationId = 'installation-event-wake-revoked-source';
    const sourceTaskId = 'task-event-wake-revoked-source';
    await seedUser(userId, {
      githubId: 'gh-event-wake-revoked-source',
      email: 'event-wake-revoked-source@example.test',
    });
    await seedInstallation(installationId, userId, {
      installationIdValue: 'inst-event-wake-revoked-source',
      accountName: 'event-wake-revoked-source',
    });
    await seedProject(projectId, userId, installationId);

    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const sessionId = await stub.createSession(null, 'Revoked event source target', sourceTaskId);
    await seedTask(sourceTaskId, projectId, userId, {
      status: 'cancelled',
      chatSessionId: sessionId,
      triggeredBy: 'mcp',
    });

    let subscription!: Awaited<ReturnType<typeof svc.createProjectEventSubscription>>;
    await withEventEnv({ PROJECT_EVENT_WAKE_ENABLED: 'false' }, async () => {
      subscription = await svc.createProjectEventSubscription(testEnv, projectId, {
        ...subscriptionInputForSession('sub-event-wake-revoked-source', sessionId),
        ownerTaskId: sourceTaskId,
        deliveryPreference: {
          requested: 'existing_session_prompt',
          resolved: 'queued_for_prompt_delivery',
          target: { sessionId, taskId: sourceTaskId, agentId: 'agent-1' },
        },
      });
      await svc.admitProjectEvent(
        testEnv,
        projectId,
        eventInput({
          deliveryKey: 'delivery-event-wake-revoked-source',
          payloadFingerprint: 'sha256:event-wake-revoked-source',
        })
      );
    });

    await runInDurableObject(stub, async (instance) => {
      (instance as unknown as { env: Env & Record<string, string | undefined> }).env
        .PROJECT_EVENT_WAKE_ENABLED = 'true';
      await instance.alarm();
    });

    const snapshot = await runInDurableObject(stub, async (_instance, state) => ({
      subscription: state.storage.sql
        .exec(
          `SELECT lifecycle_state, cancelled_by_id, cancel_reason
           FROM project_event_subscriptions
           WHERE id = ?`,
          subscription.subscription.id
        )
        .toArray()[0],
      matches: state.storage.sql
        .exec(
          `SELECT state, reason, COUNT(*) AS cnt
           FROM project_event_matches
           GROUP BY state, reason`
        )
        .toArray(),
      inboxCount: state.storage.sql
        .exec(
          `SELECT COUNT(*) AS cnt
           FROM session_inbox
           WHERE source_kind = 'project_event_wake'`
        )
        .toArray()[0],
    }));
    expect(snapshot.subscription).toMatchObject({
      lifecycle_state: 'cancelled',
      cancelled_by_id: 'project-event-wake-authority',
      cancel_reason: 'source task authority revoked before event wake materialization',
    });
    expect(snapshot.matches).toEqual([
      {
        state: 'cancelled',
        reason: 'source task authority revoked before event wake materialization',
        cnt: 1,
      },
    ]);
    expect(snapshot.inboxCount).toEqual({ cnt: 0 });
  });

  it('uses indexed wake and retention query plans with large ineligible prefixes', async () => {
    const projectId = 'project-events-query-plan-prefix';
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const sessionId = await stub.createSession(null, 'Plan target', 'task-plan');
    await runInDurableObject(stub, async (_instance, state) => {
      for (let index = 0; index < 120; index += 1) {
        state.storage.sql.exec(
          `INSERT INTO project_event_subscriptions
           (id, project_id, contract_version, owner_type, owner_id, owner_name,
            idempotency_key, idempotency_fingerprint, filter_version, filter_json,
            filter_fingerprint, match_key_count, requested_delivery, resolved_delivery,
            target_session_id, target_task_id, target_runtime_id, target_agent_id,
            lifecycle_state, reason, created_at, updated_at, expires_at,
            owner_version, owner_project_id, owner_chat_session_id, owner_task_id,
            owner_runtime_id, prompt_delivery_count, prompt_delivery_last_at,
            delivery_cooldown_until, delivery_lifetime_expires_at)
           VALUES (?, ?, 2, 'agent', ?, NULL, ?, ?, 1, '{"version":1}', ?, 0,
            'existing_session_prompt', 'queued_for_prompt_delivery', ?, 'task-plan',
            NULL, 'agent-plan', 'cancelled', NULL, ?, ?, NULL, 2, ?, ?, 'task-plan',
            NULL, 0, NULL, NULL, NULL)`,
          `sub-plan-ineligible-${index}`,
          projectId,
          `agent-plan-${index}`,
          `idem-plan-${index}`,
          `fp-plan-${index}`,
          `filter-plan-${index}`,
          sessionId,
          1000 + index,
          1000 + index,
          projectId,
          sessionId
        );
      }
    });

    const plans = await runInDurableObject(stub, async (_instance, state) => {
      const wake = state.storage.sql
        .exec(
          `EXPLAIN QUERY PLAN
           SELECT s.id AS subscription_id
           FROM project_event_subscriptions s
           JOIN chat_sessions c ON c.id = s.target_session_id
           WHERE s.project_id = ?
             AND s.owner_project_id = ?
             AND s.contract_version >= 2
             AND s.owner_version >= 2
             AND s.owner_type = 'agent'
             AND s.owner_chat_session_id = s.target_session_id
             AND s.owner_task_id IS NOT NULL
             AND s.lifecycle_state = 'active'
             AND (s.expires_at IS NULL OR s.expires_at > ?)
             AND (s.delivery_lifetime_expires_at IS NULL OR s.delivery_lifetime_expires_at > ?)
             AND s.prompt_delivery_count < ?
             AND (s.delivery_cooldown_until IS NULL OR s.delivery_cooldown_until <= ?)
             AND s.requested_delivery = 'existing_session_prompt'
             AND s.resolved_delivery = 'queued_for_prompt_delivery'
             AND s.target_session_id IS NOT NULL
             AND c.status IN ('active', 'sleeping')
             AND EXISTS (
               SELECT 1
               FROM project_event_matches m
               WHERE m.project_id = s.project_id
                 AND m.subscription_id = s.id
                 AND m.state = 'matched'
                 AND m.batch_id IS NULL
             )
           ORDER BY s.last_matched_at ASC, s.id ASC
           LIMIT ?`,
          projectId,
          projectId,
          20_000,
          20_000,
          10,
          20_000,
          2
        )
        .toArray()
        .map((row) => String((row as { detail?: unknown }).detail ?? ''));
      const expiry = state.storage.sql
        .exec(
          `EXPLAIN QUERY PLAN
           SELECT id FROM project_event_subscriptions
           WHERE project_id = ?
             AND lifecycle_state = 'active'
             AND expires_at IS NOT NULL
             AND expires_at <= ?
           ORDER BY expires_at ASC, id
           LIMIT ?`,
          projectId,
          20_000,
          1
        )
        .toArray()
        .map((row) => String((row as { detail?: unknown }).detail ?? ''));
      const attempts = state.storage.sql
        .exec(
          `EXPLAIN QUERY PLAN
           SELECT id FROM project_event_delivery_attempts
           WHERE project_id = ?
             AND created_at < ?
             AND state IN ('recorded_not_injected', 'accepted', 'failed', 'ambiguous')
           ORDER BY created_at ASC, id
           LIMIT ?`,
          projectId,
          20_000,
          1
        )
        .toArray()
        .map((row) => String((row as { detail?: unknown }).detail ?? ''));
      const batches = state.storage.sql
        .exec(
          `EXPLAIN QUERY PLAN
           SELECT b.id AS id
           FROM project_event_delivery_batches b
           WHERE b.project_id = ?
             AND b.updated_at < ?
             AND b.state IN ('recorded_not_injected', 'delivered', 'acked', 'failed', 'ambiguous', 'expired', 'cancelled')
             AND NOT EXISTS (
               SELECT 1 FROM project_event_matches m
               WHERE m.project_id = b.project_id AND m.batch_id = b.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM project_event_delivery_attempts a
               WHERE a.project_id = b.project_id AND a.batch_id = b.id
             )
           ORDER BY b.updated_at ASC, b.id
           LIMIT ?`,
          projectId,
          20_000,
          1
        )
        .toArray()
        .map((row) => String((row as { detail?: unknown }).detail ?? ''));
      return { wake, expiry, attempts, batches };
    });

    expect(plans.wake.some((detail) => detail.includes('idx_project_event_subscriptions_wake_candidates'))).toBe(
      true
    );
    expect(plans.wake.some((detail) => detail.includes('idx_project_event_matches_subscription_due'))).toBe(
      true
    );
    expect(plans.expiry.some((detail) => detail.includes('idx_project_event_subscriptions_wake_expiry'))).toBe(
      true
    );
    expect(plans.attempts.some((detail) => detail.includes('idx_project_event_attempts_retention'))).toBe(
      true
    );
    expect(plans.batches.some((detail) => detail.includes('idx_project_event_batches_retention'))).toBe(
      true
    );
  });

  it('uses finite event-wake leases and rejects physical delivery after cancellation', async () => {
    const projectId = 'project-events-wake-lease-fence';
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    await disableProjectEventWakeOnStub(projectId);
    const sessionId = await stub.createSession(null, 'Event wake lease target', 'task-1');
    let subscription!: Awaited<ReturnType<typeof svc.createProjectEventSubscription>>;
    await withEventEnv({ PROJECT_EVENT_WAKE_ENABLED: 'false' }, async () => {
      subscription = await svc.createProjectEventSubscription(
        testEnv,
        projectId,
        subscriptionInputForSession('sub-wake-lease', sessionId)
      );
      await svc.admitProjectEvent(
        testEnv,
        projectId,
        eventInput({ deliveryKey: 'delivery-wake-lease' })
      );
    });

    const materialized = await materializeEventWakeForTest(projectId, Date.now());
    const batchId = materialized.accepted[0].accepted.message.id;
    const beforeCancel = await runInDurableObject(stub, async (_instance, state) => {
      const now = Date.now();
      const message = parseMailboxMessageRow(
        state.storage.sql.exec('SELECT * FROM session_inbox WHERE id = ?', batchId).toArray()[0]
      );
      return {
        leaseUntil: readProjectEventWakeLeaseUntil(state.storage.sql, sessionId, now),
        hasLease: hasProjectEventWakeLease(state.storage.sql, sessionId, now),
        invalid: invalidProjectEventWakeDeliveryTargetResult(
          state.storage.sql,
          { ...testEnv, PROJECT_EVENT_WAKE_ENABLED: 'true' },
          projectId,
          { message, attemptId: 'attempt-before-cancel', mode: 'submit' },
          now
        ),
      };
    });
    expect(beforeCancel.hasLease).toBe(true);
    expect(beforeCancel.leaseUntil).toBeGreaterThan(Date.now());
    expect(beforeCancel.invalid).toBeNull();

    await svc.cancelProjectEventSubscription(testEnv, projectId, {
      subscriptionId: subscription.subscription.id,
      cancelledBy: { type: 'human', id: 'human-1' },
      reason: 'cancel before physical wake',
    });
    const afterCancel = await runInDurableObject(stub, async (_instance, state) => {
      const now = Date.now();
      const message = parseMailboxMessageRow(
        state.storage.sql.exec('SELECT * FROM session_inbox WHERE id = ?', batchId).toArray()[0]
      );
      return {
        hasLease: hasProjectEventWakeLease(state.storage.sql, sessionId, now),
        invalid: invalidProjectEventWakeDeliveryTargetResult(
          state.storage.sql,
          { ...testEnv, PROJECT_EVENT_WAKE_ENABLED: 'true' },
          projectId,
          { message, attemptId: 'attempt-after-cancel', mode: 'submit' },
          now
        ),
      };
    });
    expect(afterCancel.hasLease).toBe(false);
    expect(afterCancel.invalid).toMatchObject({ kind: 'failed', reason: 'terminal_target' });
  });

  it('keeps accepted event-wake batches readable through natural expiry grace and revokes them on cancellation', async () => {
    const projectId = 'project-events-wake-read-grace';
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    await disableProjectEventWakeOnStub(projectId);
    const sessionId = await stub.createSession(null, 'Event wake grace target', 'task-1');
    const restoreWake = setEventEnvForTest('PROJECT_EVENT_WAKE_ENABLED', 'false');
    try {
      let subscription!: Awaited<ReturnType<typeof svc.createProjectEventSubscription>>;
      let admitted!: Awaited<ReturnType<typeof svc.admitProjectEvent>>;
      await withEventEnv({ PROJECT_EVENT_WAKE_ENABLED: 'false' }, async () => {
        subscription = await svc.createProjectEventSubscription(
          testEnv,
          projectId,
          subscriptionInputForSession('sub-wake-grace', sessionId)
        );
        admitted = await svc.admitProjectEvent(testEnv, projectId, eventInput());
      });
      const materialized = await materializeEventWakeForTest(projectId, Date.now());
      const batchId = materialized.accepted[0].accepted.message.id;
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE project_event_delivery_batches
         SET state = 'delivered', delivered_via = 'prompt_queue', delivered_at = ?, terminal_at = ?
         WHERE id = ?`,
          Date.now(),
          Date.now(),
          batchId
        );
        state.storage.sql.exec(
          `UPDATE project_event_subscriptions
         SET expires_at = ?, updated_at = ?
         WHERE id = ?`,
          Date.now() - 1,
          Date.now() - 1,
          subscription.subscription.id
        );
      });
      await svc.expireProjectEventSubscriptions(testEnv, projectId, { now: Date.now() });

      const visibility = {
        owner: { type: 'agent' as const, id: 'agent-1' },
        target: { sessionId, taskId: 'task-1', agentId: 'agent-1' },
      };
      const pulledAfterExpiry = await svc.getProjectEvent(testEnv, projectId, {
        eventId: admitted.event.id,
        visibility,
      });
      expect(pulledAfterExpiry).toMatchObject({
        id: admitted.event.id,
        delivery: { id: batchId, deliveryChannel: 'prompt_queue', state: 'delivered' },
      });
      const ackedAfterExpiry = await svc.ackProjectEventDelivery(testEnv, projectId, {
        deliveryId: batchId,
        visibility,
        acknowledgedBy: { type: 'agent', id: 'agent-1' },
      });
      expect(ackedAfterExpiry).toMatchObject({
        acknowledged: true,
        delivery: { id: batchId, state: 'acked' },
      });

      await svc.cancelProjectEventSubscription(testEnv, projectId, {
        subscriptionId: subscription.subscription.id,
        cancelledBy: { type: 'human', id: 'human-1' },
        reason: 'revoke grace',
      });
      await expect(
        svc.getProjectEvent(testEnv, projectId, { eventId: admitted.event.id, visibility })
      ).resolves.toBeNull();
    } finally {
      restoreWake();
    }
  });

  it('fails wrong-project calls at the ProjectData boundary', async () => {
    const stub = getStub('project-events-binding-a');
    await stub.ensureProjectId('project-events-binding-a');

    const captured = await captureProjectDataExpectedError(stub, {
      operation: 'admitProjectEvent',
      args: [
        {
          projectId: 'project-events-binding-b',
          ...eventInput(),
        },
      ],
    });

    expect(captured).toMatchObject({
      threw: true,
      code: 'PROJECT_EVENT_VALIDATION',
      name: 'ProjectEventValidationError',
    });
    expect(captured.message).toMatch(/binding mismatch/);
  });

  it('enforces subscription, match, metadata, and retention caps', async () => {
    await withEventEnv({ PROJECT_EVENT_MAX_ACTIVE_SUBSCRIPTIONS_PER_PROJECT: '1' }, async () => {
      const capProject = 'project-events-active-cap';
      await svc.createProjectEventSubscription(testEnv, capProject, subscriptionInput('sub-cap-1'));
      const stub = getStub(capProject);
      const captured = await captureProjectDataExpectedError(stub, {
        operation: 'createProjectEventSubscription',
        args: [
          {
            projectId: capProject,
            ...subscriptionInput('sub-cap-2'),
          },
        ],
      });
      expect(captured).toMatchObject({ threw: true, code: 'PROJECT_EVENT_LIMIT_EXCEEDED' });
    });

    await withEventEnv({ PROJECT_EVENT_MAX_MATCHES_PER_EVENT: '1' }, async () => {
      const matchProject = 'project-events-match-cap';
      await svc.createProjectEventSubscription(
        testEnv,
        matchProject,
        subscriptionInput('sub-match-cap-1')
      );
      await svc.createProjectEventSubscription(testEnv, matchProject, {
        ...subscriptionInput('sub-match-cap-2'),
        owner: { type: 'agent' as const, id: 'agent-2', name: 'Agent Two' },
      });
      const admitted = await svc.admitProjectEvent(testEnv, matchProject, eventInput());
      expect(admitted.matches).toHaveLength(1);
    });

    await withEventEnv({ PROJECT_EVENT_METADATA_MAX_BYTES: '64' }, async () => {
      const metadataStub = getStub('project-events-metadata-cap');
      await metadataStub.ensureProjectId('project-events-metadata-cap');
      const metadataCaptured = await captureProjectDataExpectedError(metadataStub, {
        operation: 'admitProjectEvent',
        args: [
          {
            projectId: 'project-events-metadata-cap',
            ...eventInput({ metadata: { oversized: 'x'.repeat(128) } }),
          },
        ],
      });
      expect(metadataCaptured).toMatchObject({
        threw: true,
        code: 'PROJECT_EVENT_LIMIT_EXCEEDED',
      });
    });

    await withEventEnv(
      { PROJECT_EVENT_RETENTION_DAYS: '1', PROJECT_EVENT_RETENTION_BATCH_ROWS: '10' },
      async () => {
        const retentionProject = 'project-events-retention-cap';
        await svc.admitProjectEvent(
          testEnv,
          retentionProject,
          eventInput({ deliveryKey: 'old-1', receivedAt: 1000, occurredAt: 1000 })
        );
        await svc.admitProjectEvent(
          testEnv,
          retentionProject,
          eventInput({ deliveryKey: 'old-2', receivedAt: 1001, occurredAt: 1001 })
        );
        const retention = await svc.runProjectEventRetention(testEnv, retentionProject, {
          now: 3 * 24 * 60 * 60 * 1000,
          limit: 1,
        });
        expect(retention.deletedEvents).toBe(1);
        expect(retention.accounting.find((row) => row.category === 'project_events')).toMatchObject(
          {
            recordCount: 1,
          }
        );

        const pendingProject = 'project-events-retention-preserves-pending';
        const pendingSubscription = await svc.createProjectEventSubscription(
          testEnv,
          pendingProject,
          subscriptionInput('sub-pending-retention')
        );
        const pendingEvent = await svc.admitProjectEvent(
          testEnv,
          pendingProject,
          eventInput({ receivedAt: 1000, occurredAt: 1000 })
        );
        const pendingBatch = await svc.createProjectEventDeliveryBatch(testEnv, pendingProject, {
          subscriptionId: pendingSubscription.subscription.id,
          matchIds: [pendingEvent.matches[0].id],
          idempotencyKey: 'pending-batch-retention',
        });
        await runInDurableObject(getStub(pendingProject), async (_instance, state) => {
          state.storage.sql.exec(
            `UPDATE project_event_delivery_batches
             SET state = 'pending',
                 updated_at = 1000,
                 terminal_at = NULL,
                 terminal_reason = NULL
             WHERE id = ?`,
            pendingBatch.batch.id
          );
          state.storage.sql.exec(
            `UPDATE project_event_matches
             SET state = 'batch_created',
                 matched_at = 1000,
                 lifecycle_checked_at = 1000,
                 batch_id = ?,
                 reason = ?
             WHERE id = ?`,
            pendingBatch.batch.id,
            'pending runtime injection in future wave',
            pendingEvent.matches[0].id
          );
        });
        const pendingRetention = await svc.runProjectEventRetention(testEnv, pendingProject, {
          now: 3 * 24 * 60 * 60 * 1000,
          limit: 10,
        });
        expect(pendingRetention).toMatchObject({
          deletedEvents: 0,
          deletedMatches: 0,
          deletedBatches: 0,
        });
        const pendingStatus = await svc.getProjectEventRecentStatus(testEnv, pendingProject);
        expect(
          pendingStatus.batches.find((item) => item.id === pendingBatch.batch.id)
        ).toMatchObject({
          state: 'pending',
        });
        expect(
          pendingStatus.matches.find((item) => item.id === pendingEvent.matches[0].id)
        ).toMatchObject({
          state: 'batch_created',
        });

        const terminalProject = 'project-events-retention-prunes-terminal-batches';
        const terminalSubscription = await svc.createProjectEventSubscription(
          testEnv,
          terminalProject,
          subscriptionInput('sub-terminal-retention')
        );
        const terminalEvent = await svc.admitProjectEvent(
          testEnv,
          terminalProject,
          eventInput({ receivedAt: 1000, occurredAt: 1000 })
        );
        const terminalBatch = await svc.createProjectEventDeliveryBatch(testEnv, terminalProject, {
          subscriptionId: terminalSubscription.subscription.id,
          matchIds: [terminalEvent.matches[0].id],
          idempotencyKey: 'terminal-batch-retention',
          adapterCapabilities: [durableQueueCapability()],
          authorization: { allowPromptQueue: true },
        });
        await svc.recordProjectEventDeliveryAttempt(testEnv, terminalProject, {
          batchId: terminalBatch.batch.id,
          idempotencyKey: 'terminal-attempt-retention',
          state: 'accepted',
          adapter: 'durable-queue-test',
        });
        const retryAfterDelivered = await captureProjectDataExpectedError(
          getStub(terminalProject),
          {
            operation: 'recordProjectEventDeliveryAttempt',
            args: [
              {
                projectId: terminalProject,
                batchId: terminalBatch.batch.id,
                idempotencyKey: 'terminal-attempt-retry',
                state: 'retry',
                adapter: 'durable-queue-test',
              },
            ],
          }
        );
        expect(retryAfterDelivered).toMatchObject({
          threw: true,
          code: 'PROJECT_EVENT_VALIDATION',
        });
        await runInDurableObject(getStub(terminalProject), async (_instance, state) => {
          state.storage.sql.exec(
            `UPDATE project_event_delivery_batches
             SET state = 'acked',
                 updated_at = 1000,
                 acked_at = 1000,
                 terminal_at = 1000,
                 terminal_reason = 'acknowledged'
             WHERE id = ?`,
            terminalBatch.batch.id
          );
          state.storage.sql.exec(
            `UPDATE project_event_delivery_attempts
             SET created_at = 1000,
                 started_at = 1000,
                 completed_at = 1000
             WHERE batch_id = ?`,
            terminalBatch.batch.id
          );
        });
        const terminalRetention = await svc.runProjectEventRetention(testEnv, terminalProject, {
          now: 3 * 24 * 60 * 60 * 1000,
          limit: 10,
        });
        expect(terminalRetention).toMatchObject({
          deletedEvents: 1,
          deletedMatches: 1,
          deletedBatches: 1,
          deletedAttempts: 1,
        });
        const terminalStatus = await svc.getProjectEventRecentStatus(testEnv, terminalProject);
        expect(terminalStatus.events).toHaveLength(0);
        expect(terminalStatus.matches).toHaveLength(0);
        expect(terminalStatus.batches).toHaveLength(0);
        expect(terminalStatus.attempts).toHaveLength(0);
      }
    );
  });

  it.each([97, 98, 99, 100, 500])(
    'expires %i subscriptions and matches inside the real SQLite bind budget',
    async (count) => {
      const projectId = `project-events-bind-budget-${count}`;
      const stub = getStub(projectId);
      await stub.ensureProjectId(projectId);
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO project_events
           (id, project_id, contract_version, source, event_type, subject_type, subject_id,
            severity, delivery_key, payload_fingerprint, metadata_json, metadata_bytes,
            display_json, display_bytes, raw_payload_ref_json, raw_payload_ref_bytes,
            occurred_at, received_at, updated_at, state)
           VALUES (?, ?, 1, 'github', 'check_suite.completed', 'pull_request', '42',
            'warning', 'bind-proof-event', 'sha256:bind-proof', '{}', 2,
            '{"untrusted":true}', 18, NULL, 0, 1000, 1000, 1000, 'recorded')`,
          'event-bind-proof',
          projectId
        );
        for (let index = 0; index < count; index += 1) {
          const subscriptionId = `sub-bind-proof-${index}`;
          state.storage.sql.exec(
            `INSERT INTO project_event_subscriptions
             (id, project_id, contract_version, owner_type, owner_id, owner_name,
              idempotency_key, idempotency_fingerprint, filter_version, filter_json,
              filter_fingerprint, match_key_count, requested_delivery, resolved_delivery,
              target_session_id, target_task_id, target_runtime_id, target_agent_id,
              lifecycle_state, reason, created_at, updated_at, expires_at)
             VALUES (?, ?, 1, 'agent', ?, NULL, ?, ?, 1, '{"version":1}',
              ?, 0, 'record_only', 'record_only', NULL, NULL, NULL, NULL,
              'active', NULL, 1000, 1000, 1000)`,
            subscriptionId,
            projectId,
            `agent-${index}`,
            `idem-${index}`,
            `fp-${index}`,
            `filter-${index}`
          );
          state.storage.sql.exec(
            `INSERT INTO project_event_matches
             (id, project_id, event_id, subscription_id, state, matched_at,
              lifecycle_checked_at, batch_id, reason)
             VALUES (?, ?, 'event-bind-proof', ?, 'matched', 1000, 1000, NULL, NULL)`,
            `match-bind-proof-${index}`,
            projectId,
            subscriptionId
          );
        }
      });

      const retention = await withEventEnv(
        { PROJECT_EVENT_RETENTION_BATCH_ROWS: String(count * 20) },
        () =>
          svc.runProjectEventRetention(testEnv, projectId, {
            now: 2000,
            limit: count * 20,
            refreshAccounting: false,
          })
      );
      expect(retention).toMatchObject({
        expiredSubscriptions: count,
        deletedEvents: 0,
        deletedMatches: 0,
        deletedBatches: 0,
        deletedAttempts: 0,
        hasMore: false,
      });
      const counts = await runInDurableObject(stub, async (_instance, state) => {
        const subscriptions = state.storage.sql
          .exec(
            `SELECT lifecycle_state, COUNT(*) AS cnt
             FROM project_event_subscriptions
             GROUP BY lifecycle_state`
          )
          .toArray();
        const matches = state.storage.sql
          .exec(
            `SELECT state, COUNT(*) AS cnt
             FROM project_event_matches
             GROUP BY state`
          )
          .toArray();
        return { subscriptions, matches };
      });
      expect(counts.subscriptions).toEqual([{ lifecycle_state: 'expired', cnt: count }]);
      expect(counts.matches).toEqual([{ state: 'expired', cnt: count }]);
    }
  );

  it.each([97, 98, 99, 100, 500])(
    'materializes %i wake matches without exceeding the real SQLite bind budget',
    async (count) => {
      const projectId = `project-events-wake-bind-budget-${count}`;
      const stub = getStub(projectId);
      await stub.ensureProjectId(projectId);
      await disableProjectEventWakeOnStub(projectId);
      const sessionId = await stub.createSession(null, 'Large wake target', 'task-1');
      const limitOverrides = {
        PROJECT_EVENT_DELIVERY_BATCH_MAX_EVENTS: String(count),
        PROJECT_EVENT_WAKE_MAX_PER_SUBSCRIPTION: String(count + 1),
      };
      let subscription!: Awaited<ReturnType<typeof svc.createProjectEventSubscription>>;
      await withEventEnv({ PROJECT_EVENT_WAKE_ENABLED: 'false', ...limitOverrides }, async () => {
        subscription = await svc.createProjectEventSubscription(
          testEnv,
          projectId,
          subscriptionInputForSession(`sub-wake-bind-${count}`, sessionId)
        );
      });

      await runInDurableObject(stub, async (_instance, state) => {
        for (let index = 0; index < count; index += 1) {
          const eventId = `event-wake-bind-${index}`;
          state.storage.sql.exec(
            `INSERT INTO project_events
             (id, project_id, contract_version, source, event_type, subject_type, subject_id,
              severity, delivery_key, payload_fingerprint, metadata_json, metadata_bytes,
              display_json, display_bytes, raw_payload_ref_json, raw_payload_ref_bytes,
              occurred_at, received_at, updated_at, state)
             VALUES (?, ?, 1, 'github', 'check_suite.completed', 'pull_request', ?,
              'warning', ?, ?, '{}', 2, '{"untrusted":true}', 18, NULL, 0, ?, ?, ?, 'recorded')`,
            eventId,
            projectId,
            String(index),
            `delivery-wake-bind-${index}`,
            `sha256:wake-bind-${index}`,
            1000 + index,
            1000 + index,
            1000 + index
          );
          state.storage.sql.exec(
            `INSERT INTO project_event_matches
             (id, project_id, event_id, subscription_id, state, matched_at,
              lifecycle_checked_at, batch_id, reason)
             VALUES (?, ?, ?, ?, 'matched', ?, ?, NULL, NULL)`,
            `match-wake-bind-${index}`,
            projectId,
            eventId,
            subscription.subscription.id,
            1000 + index,
            1000 + index
          );
        }
        state.storage.sql.exec(
          `UPDATE project_event_subscriptions
           SET last_matched_at = 1000
           WHERE id = ?`,
          subscription.subscription.id
        );
      });

      const materialized = await materializeEventWakeForTest(projectId, 20_000, limitOverrides);
      expect(materialized).toMatchObject({ status: 'materialized', materialized: count });
      expect(
        (materialized.accepted[0]?.input.metadata as { eventIds?: unknown[] } | undefined)?.eventIds
      ).toHaveLength(count);
      const batchId = materialized.accepted[0]!.accepted.message.id;
      const counts = await runInDurableObject(stub, async (_instance, state) => {
        const matches = state.storage.sql
          .exec(
            `SELECT state, COUNT(*) AS cnt
             FROM project_event_matches
             GROUP BY state`
          )
          .toArray();
        const batch = state.storage.sql
          .exec(
            `SELECT event_count, state
             FROM project_event_delivery_batches
             WHERE id = ?`,
            batchId
          )
          .toArray()[0];
        return { matches, batch };
      });
      expect(counts.matches).toEqual([{ state: 'batch_created', cnt: count }]);
      expect(counts.batch).toMatchObject({ event_count: count, state: 'pending' });
    }
  );

  it.each([97, 98, 99, 100, 500])(
    'terminalizes %i wake matches without exceeding reserved bind slots',
    async (count) => {
      const projectId = `project-events-wake-terminal-bind-${count}`;
      const stub = getStub(projectId);
      await stub.ensureProjectId(projectId);
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          `INSERT INTO project_event_subscriptions
           (id, project_id, contract_version, owner_type, owner_id, owner_name,
            idempotency_key, idempotency_fingerprint, filter_version, filter_json,
            filter_fingerprint, match_key_count, requested_delivery, resolved_delivery,
            target_session_id, target_task_id, target_runtime_id, target_agent_id,
            lifecycle_state, reason, created_at, updated_at, expires_at)
           VALUES ('sub-terminal-bind', ?, 1, 'agent', 'agent-terminal', NULL,
            'idem-terminal-bind', 'fp-terminal-bind', 1, '{"version":1}', 'filter-terminal-bind', 0,
            'existing_session_prompt', 'queued_for_prompt_delivery', NULL, NULL, NULL, NULL,
            'active', NULL, 1000, 1000, NULL)`,
          projectId
        );
        for (let index = 0; index < count; index += 1) {
          const eventId = `event-terminal-bind-${index}`;
          state.storage.sql.exec(
            `INSERT INTO project_events
             (id, project_id, contract_version, source, event_type, subject_type, subject_id,
              severity, delivery_key, payload_fingerprint, metadata_json, metadata_bytes,
              display_json, display_bytes, raw_payload_ref_json, raw_payload_ref_bytes,
              occurred_at, received_at, updated_at, state)
             VALUES (?, ?, 1, 'github', 'check_suite.completed', 'pull_request', ?,
              'warning', ?, ?, '{}', 2, '{"untrusted":true}', 18, NULL, 0, ?, ?, ?, 'recorded')`,
            eventId,
            projectId,
            `terminal-bind-${index}`,
            `delivery-terminal-bind-${index}`,
            `sha256:terminal-bind-${index}`,
            1000 + index,
            1000 + index,
            1000 + index
          );
          state.storage.sql.exec(
            `INSERT INTO project_event_matches
             (id, project_id, event_id, subscription_id, state, matched_at,
              lifecycle_checked_at, batch_id, reason)
             VALUES (?, ?, ?, 'sub-terminal-bind', 'matched', ?, ?, NULL, NULL)`,
            `match-terminal-bind-${index}`,
            projectId,
            eventId,
            1000 + index,
            1000 + index
          );
        }
        terminalizeProjectEventWakeMatches(
          state.storage.sql,
          projectId,
          Array.from({ length: count }, (_value, index) => `match-terminal-bind-${index}`),
          'expired',
          20_000
        );
      });
      const rows = await runInDurableObject(stub, async (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT state, reason, COUNT(*) AS cnt
             FROM project_event_matches
             GROUP BY state, reason`
          )
          .toArray()
      );
      expect(rows).toEqual([
        { state: 'expired', reason: 'event wake resolver returned terminal delivery', cnt: count },
      ]);
    }
  );

  it('counts subscription expiry fanout against a budget of one write', async () => {
    const projectId = 'project-events-budget-one-subscription-expiry';
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO project_events
         (id, project_id, contract_version, source, event_type, subject_type, subject_id,
          severity, delivery_key, payload_fingerprint, metadata_json, metadata_bytes,
          display_json, display_bytes, raw_payload_ref_json, raw_payload_ref_bytes,
          occurred_at, received_at, updated_at, state)
         VALUES ('event-budget-sub', ?, 1, 'github', 'check_suite.completed', 'pull_request', '42',
          'warning', 'delivery-budget-sub', 'sha256:budget-sub', '{}', 2,
          '{"untrusted":true}', 18, NULL, 0, 1000, 1000, 1000, 'recorded')`,
        projectId
      );
      state.storage.sql.exec(
        `INSERT INTO project_event_subscriptions
         (id, project_id, contract_version, owner_type, owner_id, owner_name,
          idempotency_key, idempotency_fingerprint, filter_version, filter_json,
          filter_fingerprint, match_key_count, requested_delivery, resolved_delivery,
          target_session_id, target_task_id, target_runtime_id, target_agent_id,
          lifecycle_state, reason, created_at, updated_at, expires_at)
         VALUES ('sub-budget-one', ?, 1, 'agent', 'agent-budget', NULL, 'idem-budget',
          'fp-budget', 1, '{"version":1}', 'filter-budget', 0, 'record_only', 'record_only',
          NULL, NULL, NULL, NULL, 'active', NULL, 1000, 1000, 1000)`,
        projectId
      );
      for (let index = 0; index < 3; index += 1) {
        const eventId = `event-budget-sub-${index}`;
        state.storage.sql.exec(
          `INSERT INTO project_events
           (id, project_id, contract_version, source, event_type, subject_type, subject_id,
            severity, delivery_key, payload_fingerprint, metadata_json, metadata_bytes,
            display_json, display_bytes, raw_payload_ref_json, raw_payload_ref_bytes,
            occurred_at, received_at, updated_at, state)
           VALUES (?, ?, 1, 'github', 'check_suite.completed', 'pull_request', ?,
            'warning', ?, ?, '{}', 2, '{"untrusted":true}', 18, NULL, 0, ?, ?, ?, 'recorded')`,
          eventId,
          projectId,
          `budget-sub-${index}`,
          `delivery-budget-sub-${index}`,
          `sha256:budget-sub-${index}`,
          1000 + index,
          1000 + index,
          1000 + index
        );
        state.storage.sql.exec(
          `INSERT INTO project_event_matches
           (id, project_id, event_id, subscription_id, state, matched_at,
            lifecycle_checked_at, batch_id, reason)
           VALUES (?, ?, ?, 'sub-budget-one', 'matched', ?, ?, NULL, NULL)`,
          `match-budget-sub-${index}`,
          projectId,
          eventId,
          1000 + index,
          1000 + index
        );
      }
    });

    const first = await svc.runProjectEventRetention(testEnv, projectId, {
      now: 2000,
      limit: 1,
      refreshAccounting: false,
    });
    expect(first).toMatchObject({ expiredSubscriptions: 1, hasMore: true });
    let counts = await runInDurableObject(stub, async (_instance, state) => ({
      subscriptions: state.storage.sql
        .exec(
          `SELECT lifecycle_state, COUNT(*) AS cnt
           FROM project_event_subscriptions
           GROUP BY lifecycle_state`
        )
        .toArray(),
      matches: state.storage.sql
        .exec(
          `SELECT state, COUNT(*) AS cnt
           FROM project_event_matches
           GROUP BY state`
        )
        .toArray(),
    }));
    expect(counts.subscriptions).toEqual([{ lifecycle_state: 'expired', cnt: 1 }]);
    expect(counts.matches).toEqual([{ state: 'matched', cnt: 3 }]);

    const second = await svc.runProjectEventRetention(testEnv, projectId, {
      now: 2001,
      limit: 1,
      refreshAccounting: false,
    });
    expect(second).toMatchObject({ expiredSubscriptions: 0, hasMore: true });
    counts = await runInDurableObject(stub, async (_instance, state) => ({
      subscriptions: state.storage.sql
        .exec(
          `SELECT lifecycle_state, COUNT(*) AS cnt
           FROM project_event_subscriptions
           GROUP BY lifecycle_state`
        )
        .toArray(),
      matches: state.storage.sql
        .exec(
          `SELECT state, COUNT(*) AS cnt
           FROM project_event_matches
           GROUP BY state
           ORDER BY state`
        )
        .toArray(),
    }));
    expect(counts.matches).toEqual([
      { state: 'expired', cnt: 1 },
      { state: 'matched', cnt: 2 },
    ]);
  });

  it('does not delete terminal batches while delivery attempts still survive the budget', async () => {
    const projectId = 'project-events-budget-one-batch-attempts';
    const subscription = await svc.createProjectEventSubscription(
      testEnv,
      projectId,
      subscriptionInput('sub-budget-batch')
    );
    const admitted = await svc.admitProjectEvent(
      testEnv,
      projectId,
      eventInput({ receivedAt: 1000, occurredAt: 1000 })
    );
    const batch = await svc.createProjectEventDeliveryBatch(testEnv, projectId, {
      subscriptionId: subscription.subscription.id,
      matchIds: [admitted.matches[0]!.id],
      idempotencyKey: 'batch-budget-one',
    });

    await runInDurableObject(getStub(projectId), async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE project_event_delivery_batches
         SET state = 'recorded_not_injected', updated_at = 1000, terminal_at = 1000
         WHERE id = ?`,
        batch.batch.id
      );
      state.storage.sql.exec(
        `INSERT INTO project_event_delivery_attempts
         (id, project_id, batch_id, idempotency_key, idempotency_fingerprint,
          attempt_number, state, adapter, protocol_version, runtime_id, receipt_id,
          error_code, error_message, started_at, completed_at, created_at, transport_state)
         VALUES ('attempt-budget-one-a', ?, ?, 'attempt-budget-one-a', 'attempt-fp-a',
          1, 'recorded_not_injected', 'retention-test', NULL, NULL, NULL, NULL, NULL,
          1000, 1000, 1000, 'terminal'),
          ('attempt-budget-one-b', ?, ?, 'attempt-budget-one-b', 'attempt-fp-b',
          2, 'recorded_not_injected', 'retention-test', NULL, NULL, NULL, NULL, NULL,
          1000, 1000, 1000, 'terminal')`,
        projectId,
        batch.batch.id,
        projectId,
        batch.batch.id
      );
    });

    const first = await withEventEnv({ PROJECT_EVENT_RETENTION_DAYS: '1' }, () =>
      svc.runProjectEventRetention(testEnv, projectId, {
        now: 3 * 24 * 60 * 60 * 1000,
        limit: 1,
        refreshAccounting: false,
      })
    );
    expect(first).toMatchObject({ deletedAttempts: 1, deletedBatches: 0, hasMore: true });
    const remaining = await runInDurableObject(getStub(projectId), async (_instance, state) => ({
      attempts: state.storage.sql
        .exec('SELECT COUNT(*) AS cnt FROM project_event_delivery_attempts')
        .toArray()[0],
      batches: state.storage.sql
        .exec('SELECT COUNT(*) AS cnt FROM project_event_delivery_batches')
        .toArray()[0],
    }));
    expect(remaining).toEqual({ attempts: { cnt: 1 }, batches: { cnt: 1 } });
  });

  it('repairs missing-batch orphan matches, deletes them on the next budget step, then deletes eligible events', async () => {
    const projectId = 'project-events-orphan-budget-one-drain';
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO project_events
         (id, project_id, contract_version, source, event_type, subject_type, subject_id,
          severity, delivery_key, payload_fingerprint, metadata_json, metadata_bytes,
          display_json, display_bytes, raw_payload_ref_json, raw_payload_ref_bytes,
          occurred_at, received_at, updated_at, state)
         VALUES ('event-orphan', ?, 1, 'github', 'check_suite.completed', 'pull_request', 'orphan',
          'warning', 'delivery-orphan', 'sha256:orphan', '{}', 2, '{"untrusted":true}', 18,
          NULL, 0, 1000, 1000, 1000, 'recorded'),
          ('event-null-unmatched', ?, 1, 'github', 'check_suite.completed', 'pull_request', 'null',
          'warning', 'delivery-null-unmatched', 'sha256:null-unmatched', '{}', 2,
          '{"untrusted":true}', 18, NULL, 0, 1000, 1000, 1000, 'recorded')`,
        projectId,
        projectId
      );
      state.storage.sql.exec(
        `INSERT INTO project_event_subscriptions
         (id, project_id, contract_version, owner_type, owner_id, owner_name,
          idempotency_key, idempotency_fingerprint, filter_version, filter_json,
          filter_fingerprint, match_key_count, requested_delivery, resolved_delivery,
          target_session_id, target_task_id, target_runtime_id, target_agent_id,
          lifecycle_state, reason, created_at, updated_at, expires_at)
         VALUES ('sub-orphan', ?, 1, 'agent', 'agent-orphan', NULL, 'idem-orphan', 'fp-orphan',
          1, '{"version":1}', 'filter-orphan', 0, 'record_only', 'record_only', NULL, NULL,
          NULL, NULL, 'active', NULL, 1000, 1000, NULL),
          ('sub-live', ?, 1, 'agent', 'agent-live', NULL, 'idem-live', 'fp-live',
          1, '{"version":1}', 'filter-live', 0, 'record_only', 'record_only', NULL, NULL,
          NULL, NULL, 'active', NULL, 1000, 1000, NULL)`,
        projectId,
        projectId
      );
      state.storage.sql.exec(
        `INSERT INTO project_event_matches
         (id, project_id, event_id, subscription_id, state, matched_at,
          lifecycle_checked_at, batch_id, reason)
         VALUES ('match-orphan', ?, 'event-orphan', 'sub-orphan', 'batch_created', 1000, 1000, 'missing-batch', NULL),
                ('match-null-unmatched', ?, 'event-null-unmatched', 'sub-live', 'matched', 1000, 1000, NULL, NULL)`,
        projectId,
        projectId
      );
    });

    const repair = await withEventEnv({ PROJECT_EVENT_RETENTION_DAYS: '1' }, () =>
      svc.runProjectEventRetention(testEnv, projectId, {
        now: 3 * 24 * 60 * 60 * 1000,
        limit: 1,
        refreshAccounting: false,
      })
    );
    expect(repair).toMatchObject({ repairedOrphanMatches: 1, deletedMatches: 0, hasMore: true });
    let snapshot = await runInDurableObject(stub, async (_instance, state) => ({
      orphan: state.storage.sql
        .exec(
          'SELECT state, batch_id, reason FROM project_event_matches WHERE id = ?',
          'match-orphan'
        )
        .toArray()[0],
      nullUnmatched: state.storage.sql
        .exec(
          'SELECT state, batch_id FROM project_event_matches WHERE id = ?',
          'match-null-unmatched'
        )
        .toArray()[0],
    }));
    expect(snapshot.orphan).toEqual({
      state: 'expired',
      batch_id: 'missing-batch',
      reason: 'retention_orphan_batch_repaired',
    });
    expect(snapshot.nullUnmatched).toEqual({ state: 'matched', batch_id: null });

    const deleteMatch = await withEventEnv({ PROJECT_EVENT_RETENTION_DAYS: '1' }, () =>
      svc.runProjectEventRetention(testEnv, projectId, {
        now: 3 * 24 * 60 * 60 * 1000 + 1,
        limit: 1,
        refreshAccounting: false,
      })
    );
    expect(deleteMatch).toMatchObject({ deletedMatches: 1, deletedEvents: 0, hasMore: true });

    const deleteEvent = await withEventEnv({ PROJECT_EVENT_RETENTION_DAYS: '1' }, () =>
      svc.runProjectEventRetention(testEnv, projectId, {
        now: 3 * 24 * 60 * 60 * 1000 + 2,
        limit: 1,
        refreshAccounting: false,
      })
    );
    expect(deleteEvent).toMatchObject({ deletedEvents: 1, hasMore: false });
    snapshot = await runInDurableObject(stub, async (_instance, state) => ({
      orphanEvent:
        state.storage.sql
          .exec('SELECT id FROM project_events WHERE id = ?', 'event-orphan')
          .toArray()[0] ?? null,
      nullUnmatched: state.storage.sql
        .exec(
          'SELECT state, batch_id FROM project_event_matches WHERE id = ?',
          'match-null-unmatched'
        )
        .toArray()[0],
    }));
    expect(snapshot.orphanEvent).toBeNull();
    expect(snapshot.nullUnmatched).toEqual({ state: 'matched', batch_id: null });

    const quiet = await withEventEnv({ PROJECT_EVENT_RETENTION_DAYS: '1' }, () =>
      svc.runProjectEventRetention(testEnv, projectId, {
        now: 3 * 24 * 60 * 60 * 1000 + 3,
        limit: 1,
        refreshAccounting: false,
      })
    );
    expect(quiet).toMatchObject({
      deletedEvents: 0,
      deletedMatches: 0,
      repairedOrphanMatches: 0,
      hasMore: false,
    });
  });

  it('honors persisted materialization checkpoints before unrelated alarms do more wake work', async () => {
    const projectId = 'project-events-materialization-checkpoint';
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const nextAttemptAt = 50_000;
    const due = await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO project_event_wake_scheduler_state
         (project_id, next_attempt_at, materialization_failures, last_materialization_error_code, updated_at)
         VALUES (?, ?, 2, 'previous failure', 10_000)`,
        projectId,
        nextAttemptAt
      );
      return {
        before: computeProjectEventMaterializationAlarmTime(
          state.storage.sql,
          { ...testEnv, PROJECT_EVENT_WAKE_ENABLED: 'true' },
          projectId,
          20_000
        ),
        run: runProjectEventWakeMaterializationBatch(
          state.storage.sql,
          { ...testEnv, PROJECT_EVENT_WAKE_ENABLED: 'true' },
          projectId,
          20_000
        ),
      };
    });
    expect(due.before).toBe(nextAttemptAt);
    expect(due.run).toMatchObject({ status: 'not_due', materialized: 0 });
  });

  it('keeps later alarm phases running when materialization and failure checkpoint persistence both fail', async () => {
    const projectId = 'project-events-alarm-failure-isolation';
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const snapshot = await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO project_events
         (id, project_id, contract_version, source, event_type, subject_type, subject_id,
          severity, delivery_key, payload_fingerprint, metadata_json, metadata_bytes,
          display_json, display_bytes, raw_payload_ref_json, raw_payload_ref_bytes,
          occurred_at, received_at, updated_at, state)
         VALUES ('event-alarm-failure-retention', ?, 1, 'github', 'check_suite.completed',
          'pull_request', 'alarm-failure', 'warning', 'delivery-alarm-failure',
          'sha256:alarm-failure', '{}', 2, '{"untrusted":true}', 18, NULL, 0,
          1000, 1000, 1000, 'recorded')`,
        projectId
      );
      state.storage.sql.exec(
        `INSERT INTO project_event_wake_scheduler_state
         (project_id, next_retention_at, updated_at)
         VALUES (?, 0, 1000)`,
        projectId
      );
      const projectData = instance as unknown as {
        env: Env & Record<string, string | undefined>;
        ctx: { storage: { transactionSync: <T>(callback: () => T) => T } };
        runProjectEventWakeMaterializationAlarm: () => Promise<void>;
      };
      projectData.env.PROJECT_EVENT_RETENTION_DAYS = '1';
      projectData.env.PROJECT_EVENT_RETENTION_BATCH_ROWS = '5';
      const originalTransaction = projectData.ctx.storage.transactionSync.bind(
        projectData.ctx.storage
      );
      let checkpointFailurePending = true;
      projectData.runProjectEventWakeMaterializationAlarm = async () => {
        projectData.ctx.storage.transactionSync = <T>(callback: () => T): T => {
          if (checkpointFailurePending) {
            checkpointFailurePending = false;
            projectData.ctx.storage.transactionSync = originalTransaction;
            throw new Error('checkpoint write failed');
          }
          return originalTransaction(callback);
        };
        throw new Error('primary materialization failed');
      };

      await instance.alarm();
      const events = state.storage.sql
        .exec(
          `SELECT COUNT(*) AS cnt
           FROM project_events
           WHERE id = 'event-alarm-failure-retention'`
        )
        .toArray()[0];
      const scheduler = state.storage.sql
        .exec(
          `SELECT next_retention_at, last_retention_error_code
           FROM project_event_wake_scheduler_state
           WHERE project_id = ?`,
          projectId
        )
        .toArray()[0];
      return { events, scheduler, checkpointFailurePending };
    });

    expect(snapshot.events).toEqual({ cnt: 0 });
    expect(snapshot.scheduler).toMatchObject({
      next_retention_at: expect.any(Number),
      last_retention_error_code: null,
    });
    expect(snapshot.checkpointFailurePending).toBe(false);
  });

  it('lazily persists upgrade retention checkpoints for old events without a scheduler row', async () => {
    const projectId = 'project-events-retention-upgrade-checkpoint';
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const scheduled = await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO project_events
         (id, project_id, contract_version, source, event_type, subject_type, subject_id,
          severity, delivery_key, payload_fingerprint, metadata_json, metadata_bytes,
          display_json, display_bytes, raw_payload_ref_json, raw_payload_ref_bytes,
          occurred_at, received_at, updated_at, state)
         VALUES ('event-upgrade-retention', ?, 1, 'github', 'check_suite.completed', 'pull_request', '42',
          'warning', 'delivery-upgrade-retention', 'sha256:upgrade-retention', '{}', 2,
          '{"untrusted":true}', 18, NULL, 0, 1000, 1000, 1000, 'recorded')`,
        projectId
      );
      const dueAt = computeProjectEventRetentionAlarmTime(
        state.storage.sql,
        {
          ...testEnv,
          PROJECT_EVENT_RETENTION_DAYS: '1',
          PROJECT_EVENT_RETENTION_MIN_ALARM_DELAY_MS: '100',
        },
        projectId,
        3 * 24 * 60 * 60 * 1000
      );
      const row = state.storage.sql
        .exec(
          `SELECT next_retention_at, retention_failures, last_retention_error_code
           FROM project_event_wake_scheduler_state
           WHERE project_id = ?`,
          projectId
        )
        .toArray()[0];
      return { dueAt, row };
    });
    expect(scheduled.dueAt).toBe(3 * 24 * 60 * 60 * 1000 + 100);
    expect(scheduled.row).toEqual({
      next_retention_at: 3 * 24 * 60 * 60 * 1000 + 100,
      retention_failures: 0,
      last_retention_error_code: null,
    });
  });

  it('clamps receivedAt to local receipt time while preserving occurredAt evidence', async () => {
    const projectId = 'project-events-received-at-clamp';
    const future = Date.now() + 60_000;
    const admitted = await svc.admitProjectEvent(testEnv, projectId, {
      ...eventInput({ occurredAt: undefined, receivedAt: future }),
      deliveryKey: 'future-received-at',
      payloadFingerprint: 'sha256:future-received-at',
    });
    expect(admitted.event.receivedAt).toBeLessThanOrEqual(Date.now());
    expect(admitted.event.occurredAt).toBe(future);
  });

  it('rechecks cancel and expiry before matching or delivery-batch recording', async () => {
    const cancelProject = 'project-events-cancel-race';
    const subscription = await svc.createProjectEventSubscription(
      testEnv,
      cancelProject,
      subscriptionInput('sub-cancel-1')
    );
    const admitted = await svc.admitProjectEvent(testEnv, cancelProject, eventInput());
    await svc.cancelProjectEventSubscription(testEnv, cancelProject, {
      subscriptionId: subscription.subscription.id,
      cancelledBy: { type: 'human', id: 'human-1', name: 'Human One' },
      reason: 'No longer needed',
    });
    const cancelStatus = await svc.getProjectEventRecentStatus(testEnv, cancelProject);
    expect(cancelStatus.matches.find((match) => match.id === admitted.matches[0].id)).toMatchObject(
      {
        state: 'cancelled',
        reason: 'subscription cancelled',
      }
    );
    const batch = await svc.createProjectEventDeliveryBatch(testEnv, cancelProject, {
      subscriptionId: subscription.subscription.id,
      matchIds: [admitted.matches[0].id],
      idempotencyKey: 'batch-after-cancel',
    });
    expect(batch.batch.state).toBe('cancelled');

    const expireProject = 'project-events-expiry-race';
    await svc.createProjectEventSubscription(testEnv, expireProject, {
      ...subscriptionInput('sub-expire-1'),
      expiresAt: Date.now() + 1_000,
    });
    const beforeExpiry = await svc.admitProjectEvent(testEnv, expireProject, eventInput());
    expect(beforeExpiry.matches).toHaveLength(1);
    const expired = await svc.expireProjectEventSubscriptions(testEnv, expireProject, {
      now: Date.now() + 2_000,
    });
    expect(expired.expired).toBe(1);
    const expiryStatus = await svc.getProjectEventRecentStatus(testEnv, expireProject);
    expect(
      expiryStatus.matches.find((match) => match.id === beforeExpiry.matches[0].id)
    ).toMatchObject({
      state: 'expired',
      reason: 'subscription expired',
    });
    const eventAfterExpiry = await svc.admitProjectEvent(
      testEnv,
      expireProject,
      eventInput({
        deliveryKey: 'delivery-after-expiry',
        payloadFingerprint: 'sha256:after-expiry',
      })
    );
    expect(eventAfterExpiry.outcome).toBe('created');
    expect(eventAfterExpiry.matches).toHaveLength(0);
  });

  it('records ambiguous attempts as terminal without replaying injection', async () => {
    const projectId = 'project-events-ambiguous-attempt';
    const subscription = await svc.createProjectEventSubscription(
      testEnv,
      projectId,
      subscriptionInput('sub-ambiguous-1')
    );
    const admitted = await svc.admitProjectEvent(testEnv, projectId, eventInput());
    const batch = await svc.createProjectEventDeliveryBatch(testEnv, projectId, {
      subscriptionId: subscription.subscription.id,
      matchIds: [admitted.matches[0].id],
      idempotencyKey: 'batch-ambiguous',
    });

    const stub = getStub(projectId);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE project_event_delivery_batches
         SET state = 'pending', terminal_at = NULL, terminal_reason = NULL
         WHERE id = ?`,
        batch.batch.id
      );
    });

    const ambiguous = await svc.recordProjectEventDeliveryAttempt(testEnv, projectId, {
      batchId: batch.batch.id,
      idempotencyKey: 'attempt-ambiguous',
      state: 'ambiguous',
      adapter: 'runtime-adapter-test',
      protocolVersion: 'test-v1',
      receiptId: 'receipt-ambiguous',
      errorMessage: 'Receipt state ambiguous; do not replay blindly',
    });

    expect(ambiguous).toMatchObject({
      attempt: { state: 'ambiguous' },
      batch: { state: 'ambiguous' },
    });
    const replayAfterTerminal = await captureProjectDataExpectedError(stub, {
      operation: 'recordProjectEventDeliveryAttempt',
      args: [
        {
          projectId,
          batchId: batch.batch.id,
          idempotencyKey: 'attempt-after-terminal',
          state: 'retry',
          adapter: 'runtime-adapter-test',
        },
      ],
    });
    expect(replayAfterTerminal).toMatchObject({
      threw: true,
      code: 'PROJECT_EVENT_VALIDATION',
    });
    expect(replayAfterTerminal.message).toMatch(/terminal delivery batch/);
    expect(await sessionInboxCount(projectId)).toBe(0);
  });

  it('rejects malformed attempt and retention timestamps at the ProjectData boundary', async () => {
    const projectId = 'project-events-invalid-timestamps';
    const subscription = await svc.createProjectEventSubscription(
      testEnv,
      projectId,
      subscriptionInput('sub-invalid-timestamps')
    );
    const admitted = await svc.admitProjectEvent(testEnv, projectId, eventInput());
    const batch = await svc.createProjectEventDeliveryBatch(testEnv, projectId, {
      subscriptionId: subscription.subscription.id,
      matchIds: [admitted.matches[0].id],
      idempotencyKey: 'batch-invalid-timestamps',
    });

    const stub = getStub(projectId);
    const invalidAttempt = await captureProjectDataExpectedError(stub, {
      operation: 'recordProjectEventDeliveryAttempt',
      args: [
        {
          projectId,
          batchId: batch.batch.id,
          idempotencyKey: 'attempt-invalid-start',
          state: 'recorded_not_injected',
          startedAt: -1,
        },
      ],
    });
    expect(invalidAttempt).toMatchObject({
      threw: true,
      code: 'PROJECT_EVENT_VALIDATION',
    });
    expect(invalidAttempt.message).toMatch(/startedAt/);

    const invalidRetention = await captureProjectDataExpectedError(stub, {
      operation: 'runProjectEventRetention',
      args: [{ projectId, now: -1 }],
    });
    expect(invalidRetention).toMatchObject({
      threw: true,
      code: 'PROJECT_EVENT_VALIDATION',
    });
    expect(invalidRetention.message).toMatch(/now/);

    const invalidRetentionLimit = await captureProjectDataExpectedError(stub, {
      operation: 'runProjectEventRetention',
      args: [{ projectId, limit: 0 }],
    });
    expect(invalidRetentionLimit).toMatchObject({
      threw: true,
      code: 'PROJECT_EVENT_VALIDATION',
    });
    expect(invalidRetentionLimit.message).toMatch(/limit/);
  });

  it('stores the security canary as bounded untrusted data only', async () => {
    const projectId = 'project-events-security-canary';
    const canary = 'SECURITY_CANARY_DO_NOT_EXECUTE';
    const admitted = await svc.admitProjectEvent(
      testEnv,
      projectId,
      eventInput({
        deliveryKey: 'delivery-canary',
        payloadFingerprint: 'sha256:canary',
        metadata: {
          note: canary,
          shell: '$(touch /tmp/project-event-canary)',
        },
        display: {
          title: canary,
          summary: '`SECURITY_CANARY_DO_NOT_EXECUTE` remains quoted display data',
        },
      })
    );

    expect(admitted.event.display).toMatchObject({ untrusted: true, title: canary });
    expect(admitted.event.metadata).toMatchObject({
      note: canary,
      shell: '$(touch /tmp/project-event-canary)',
    });
    expect(await sessionInboxCount(projectId)).toBe(0);
  });
});
