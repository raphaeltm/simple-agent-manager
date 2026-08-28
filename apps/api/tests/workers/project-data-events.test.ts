import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { AdmitProjectEventInput } from '../../src/durable-objects/project-data/project-events';
import type { Env } from '../../src/env';
import * as svc from '../../src/services/project-data';
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
      { PROJECT_EVENT_RETENTION_DAYS: '1', PROJECT_EVENT_RETENTION_BATCH_ROWS: '1' },
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
      }
    );
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
