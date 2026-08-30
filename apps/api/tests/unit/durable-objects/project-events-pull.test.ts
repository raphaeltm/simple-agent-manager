import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  ackProjectEventDelivery,
  admitProjectEvent,
  createProjectEventDeliveryBatch,
  createProjectEventSubscription,
  getProjectEvent,
  listProjectEventSubscriptionEvents,
  ProjectEventAckPolicyError,
  ProjectEventAckStateError,
  ProjectEventCursorError,
  runProjectEventRetention,
} from '../../../src/durable-objects/project-data/project-events';
import type { Env } from '../../../src/durable-objects/project-data/types';
import { createSqlStorage } from './sql-storage-test-utils';

const PROJECT_ID = 'project-events-pull-project';
const AGENT_OWNER = { type: 'agent' as const, id: 'agent-session-1', name: 'agent-session-1' };
const AGENT_TARGET = {
  sessionId: 'session-1',
  taskId: 'task-1',
  runtimeId: null,
  agentId: 'agent-session-1',
};
const AGENT_VISIBILITY = { owner: AGENT_OWNER, target: AGENT_TARGET };

function eventEnv(overrides: Partial<Env> = {}): Env {
  return {
    PROJECT_EVENT_RETENTION_DAYS: '30',
    ...overrides,
  } as Env;
}

function createAgentSubscription(
  sql: SqlStorage,
  env: Env,
  overrides: Partial<Parameters<typeof createProjectEventSubscription>[3]> = {}
) {
  return createProjectEventSubscription(sql, env, PROJECT_ID, {
    projectId: PROJECT_ID,
    owner: AGENT_OWNER,
    idempotencyKey: `sub-${crypto.randomUUID()}`,
    filter: { version: 1, source: 'github', eventType: 'check_suite.completed' },
    deliveryPreference: {
      requested: 'existing_session_prompt',
      resolved: 'recorded_not_injected',
      target: AGENT_TARGET,
    },
    expiresAt: 60_000,
    ...overrides,
  });
}

function admitGithubEvent(sql: SqlStorage, env: Env, index: number) {
  return admitProjectEvent(sql, env, PROJECT_ID, {
    projectId: PROJECT_ID,
    source: 'github',
    eventType: 'check_suite.completed',
    subject: { type: 'pull_request', id: `pr-${index}` },
    severity: 'warning',
    deliveryKey: `delivery-${index}`,
    payloadFingerprint: `sha256:fingerprint-${index}`,
    metadata: { attempt: index, conclusion: 'failure' },
    display: { title: `CI failed ${index}`, summary: `Failure ${index}` },
    rawPayloadRef: {
      provider: 'r2',
      uri: `r2://private-payload-secret-${index}`,
      contentHash: `sha256:payload-${index}`,
    },
    occurredAt: 2_000 + index,
    receivedAt: 2_000 + index,
  });
}

function countRows(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function encodeCursor(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

describe('ProjectData project_event pull delivery tools', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  let env: Env;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    env = eventEnv();
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('cursor-paginates visible subscription events and keeps list summaries payload-free', () => {
    const subscription = createAgentSubscription(sql, env).subscription;
    admitGithubEvent(sql, env, 1);
    admitGithubEvent(sql, env, 2);
    admitGithubEvent(sql, env, 3);

    vi.setSystemTime(4_000);
    const first = listProjectEventSubscriptionEvents(sql, env, PROJECT_ID, {
      projectId: PROJECT_ID,
      subscriptionId: subscription.id,
      visibility: AGENT_VISIBILITY,
      limit: 2,
    });

    expect(first?.events.map((event) => event.id)).toHaveLength(2);
    expect(first?.events.map((event) => event.delivery.state)).toEqual(['delivered', 'delivered']);
    expect(first?.hasMore).toBe(true);
    expect(first?.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(first)).not.toContain('rawPayloadRef');
    expect(JSON.stringify(first)).not.toContain('private-payload-secret');
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM project_event_delivery_batches
           WHERE subscription_id = ? AND ack_required = 1 AND state = 'delivered'`
        )
        .get(subscription.id)
    ).toEqual({ count: 2 });

    admitGithubEvent(sql, env, 4);
    const second = listProjectEventSubscriptionEvents(sql, env, PROJECT_ID, {
      projectId: PROJECT_ID,
      subscriptionId: subscription.id,
      visibility: AGENT_VISIBILITY,
      limit: 2,
      cursor: first?.nextCursor,
    });

    expect(second?.events.map((event) => event.metadata.attempt)).toEqual([3, 4]);
    expect(second?.nextCursor).toBeNull();
    expect(second?.hasMore).toBe(false);
  });

  it('fetches one visible event with full canonical stored details', () => {
    createAgentSubscription(sql, env);
    const admitted = admitGithubEvent(sql, env, 1);

    vi.setSystemTime(5_000);
    const event = getProjectEvent(sql, env, PROJECT_ID, {
      projectId: PROJECT_ID,
      eventId: admitted.event.id,
      visibility: AGENT_VISIBILITY,
    });

    expect(event).toMatchObject({
      id: admitted.event.id,
      deliveryKey: 'delivery-1',
      payloadFingerprint: 'sha256:fingerprint-1',
      rawPayloadRef: { uri: 'r2://private-payload-secret-1' },
      delivery: {
        state: 'delivered',
        ackRequired: true,
        deliveredAt: 5_000,
      },
    });
  });

  it('rejects malformed and subscription-mismatched opaque cursors', () => {
    const subscription = createAgentSubscription(sql, env).subscription;
    const otherSubscription = createAgentSubscription(sql, env, {
      idempotencyKey: 'sub-other',
    }).subscription;
    admitGithubEvent(sql, env, 1);
    admitGithubEvent(sql, env, 2);

    expect(() =>
      listProjectEventSubscriptionEvents(sql, env, PROJECT_ID, {
        projectId: PROJECT_ID,
        subscriptionId: subscription.id,
        visibility: AGENT_VISIBILITY,
        limit: 1,
        cursor: 'not-a-cursor',
      })
    ).toThrow(ProjectEventCursorError);

    const first = listProjectEventSubscriptionEvents(sql, env, PROJECT_ID, {
      projectId: PROJECT_ID,
      subscriptionId: subscription.id,
      visibility: AGENT_VISIBILITY,
      limit: 1,
    });
    expect(first?.nextCursor).toEqual(expect.any(String));

    expect(() =>
      listProjectEventSubscriptionEvents(sql, env, PROJECT_ID, {
        projectId: PROJECT_ID,
        subscriptionId: otherSubscription.id,
        visibility: AGENT_VISIBILITY,
        limit: 1,
        cursor: first?.nextCursor,
      })
    ).toThrow(ProjectEventCursorError);

    expect(() =>
      listProjectEventSubscriptionEvents(sql, env, PROJECT_ID, {
        projectId: PROJECT_ID,
        subscriptionId: subscription.id,
        visibility: AGENT_VISIBILITY,
        limit: 1,
        cursor: encodeCursor({
          version: 1,
          subscriptionId: subscription.id,
          afterMatchedAt: 'bad',
          afterMatchId: '',
        }),
      })
    ).toThrow(ProjectEventCursorError);
  });

  it('enforces active, unexpired, nondisclosing visibility for list/get/ack', () => {
    const subscription = createAgentSubscription(sql, env, { expiresAt: 10_000 }).subscription;
    const admitted = admitGithubEvent(sql, env, 1);
    const listed = listProjectEventSubscriptionEvents(sql, env, PROJECT_ID, {
      projectId: PROJECT_ID,
      subscriptionId: subscription.id,
      visibility: AGENT_VISIBILITY,
      limit: 1,
    });
    const deliveryId = listed?.events[0]?.delivery.id ?? '';
    const wrongVisibility = {
      owner: AGENT_OWNER,
      target: { ...AGENT_TARGET, sessionId: 'session-other', taskId: 'task-other' },
    };

    expect(
      getProjectEvent(sql, env, PROJECT_ID, {
        projectId: PROJECT_ID,
        eventId: admitted.event.id,
        visibility: wrongVisibility,
      })
    ).toBeNull();
    expect(
      listProjectEventSubscriptionEvents(sql, env, PROJECT_ID, {
        projectId: PROJECT_ID,
        subscriptionId: subscription.id,
        visibility: wrongVisibility,
        limit: 1,
      })
    ).toBeNull();
    expect(
      ackProjectEventDelivery(sql, env, PROJECT_ID, {
        projectId: PROJECT_ID,
        deliveryId,
        visibility: wrongVisibility,
        acknowledgedBy: AGENT_OWNER,
      })
    ).toBeNull();

    db.prepare(
      "UPDATE project_event_subscriptions SET lifecycle_state = 'expired', expires_at = ? WHERE id = ?"
    ).run(2_000, subscription.id);
    vi.setSystemTime(3_000);

    expect(
      getProjectEvent(sql, env, PROJECT_ID, {
        projectId: PROJECT_ID,
        eventId: admitted.event.id,
        visibility: AGENT_VISIBILITY,
      })
    ).toBeNull();
    expect(
      listProjectEventSubscriptionEvents(sql, env, PROJECT_ID, {
        projectId: PROJECT_ID,
        subscriptionId: subscription.id,
        visibility: AGENT_VISIBILITY,
        limit: 1,
      })
    ).toBeNull();
    expect(
      ackProjectEventDelivery(sql, env, PROJECT_ID, {
        projectId: PROJECT_ID,
        deliveryId,
        visibility: AGENT_VISIBILITY,
        acknowledgedBy: AGENT_OWNER,
      })
    ).toBeNull();
  });

  it('allows active policy/system subscriptions targeted at the calling agent context', () => {
    const policySubscription = createAgentSubscription(sql, env, {
      owner: { type: 'policy', id: 'policy-1', name: 'Policy One' },
      idempotencyKey: 'policy-subscription',
      deliveryPreference: {
        requested: 'record_only',
        resolved: 'record_only',
        target: { ...AGENT_TARGET, agentId: null },
      },
    }).subscription;
    admitGithubEvent(sql, env, 1);

    const listed = listProjectEventSubscriptionEvents(sql, env, PROJECT_ID, {
      projectId: PROJECT_ID,
      subscriptionId: policySubscription.id,
      visibility: AGENT_VISIBILITY,
      limit: 10,
    });

    expect(listed?.events).toHaveLength(1);
    expect(listed?.events[0]?.delivery.ackRequired).toBe(true);
  });

  it('acks pull deliveries idempotently and rejects non-ack or invalid-state batches', () => {
    const subscription = createAgentSubscription(sql, env).subscription;
    const admitted = admitGithubEvent(sql, env, 1);

    const listed = listProjectEventSubscriptionEvents(sql, env, PROJECT_ID, {
      projectId: PROJECT_ID,
      subscriptionId: subscription.id,
      visibility: AGENT_VISIBILITY,
      limit: 1,
    });
    const deliveryId = listed?.events[0]?.delivery.id ?? '';
    vi.setSystemTime(6_000);

    const first = ackProjectEventDelivery(sql, env, PROJECT_ID, {
      projectId: PROJECT_ID,
      deliveryId,
      visibility: AGENT_VISIBILITY,
      acknowledgedBy: AGENT_OWNER,
    });
    const second = ackProjectEventDelivery(sql, env, PROJECT_ID, {
      projectId: PROJECT_ID,
      deliveryId,
      visibility: AGENT_VISIBILITY,
      acknowledgedBy: AGENT_OWNER,
    });

    expect(first).toMatchObject({
      acknowledged: true,
      idempotent: false,
      delivery: {
        id: deliveryId,
        eventId: admitted.event.id,
        state: 'acked',
        acknowledgedAt: 6_000,
      },
    });
    expect(second).toMatchObject({
      acknowledged: true,
      idempotent: true,
      delivery: { id: deliveryId, state: 'acked', acknowledgedAt: 6_000 },
    });

    const secondAdmitted = admitGithubEvent(sql, env, 2);
    const nonAckBatch = createProjectEventDeliveryBatch(sql, env, PROJECT_ID, {
      projectId: PROJECT_ID,
      subscriptionId: subscription.id,
      matchIds: [secondAdmitted.matches[0]!.id],
      idempotencyKey: 'non-pull-batch',
      requestedDelivery: 'record_only',
    });
    expect(() =>
      ackProjectEventDelivery(sql, env, PROJECT_ID, {
        projectId: PROJECT_ID,
        deliveryId: nonAckBatch.batch.id,
        visibility: AGENT_VISIBILITY,
        acknowledgedBy: AGENT_OWNER,
      })
    ).toThrow(ProjectEventAckPolicyError);

    const thirdAdmitted = admitGithubEvent(sql, env, 3);
    const failed = listProjectEventSubscriptionEvents(sql, env, PROJECT_ID, {
      projectId: PROJECT_ID,
      subscriptionId: subscription.id,
      visibility: AGENT_VISIBILITY,
      limit: 10,
    })?.events.find((event) => event.id === thirdAdmitted.event.id);
    db.prepare("UPDATE project_event_delivery_batches SET state = 'failed' WHERE id = ?").run(
      failed?.delivery.id
    );
    expect(() =>
      ackProjectEventDelivery(sql, env, PROJECT_ID, {
        projectId: PROJECT_ID,
        deliveryId: failed?.delivery.id ?? '',
        visibility: AGENT_VISIBILITY,
        acknowledgedBy: AGENT_OWNER,
      })
    ).toThrow(ProjectEventAckStateError);
  });

  it('protects unacked pull deliveries from canonical retention until acknowledgement', () => {
    const retentionEnv = eventEnv({ PROJECT_EVENT_RETENTION_DAYS: '0' });
    const subscription = createAgentSubscription(sql, retentionEnv).subscription;
    admitGithubEvent(sql, retentionEnv, 1);
    const listed = listProjectEventSubscriptionEvents(sql, retentionEnv, PROJECT_ID, {
      projectId: PROJECT_ID,
      subscriptionId: subscription.id,
      visibility: AGENT_VISIBILITY,
      limit: 1,
    });
    const deliveryId = listed?.events[0]?.delivery.id ?? '';

    vi.setSystemTime(5_000);
    const beforeAck = runProjectEventRetention(sql, retentionEnv, PROJECT_ID, {
      projectId: PROJECT_ID,
      now: 5_000,
      limit: 20,
    });
    expect(beforeAck.deletedBatches).toBe(0);
    expect(countRows(db, 'project_events')).toBe(1);
    expect(countRows(db, 'project_event_matches')).toBe(1);
    expect(countRows(db, 'project_event_delivery_batches')).toBe(1);

    vi.setSystemTime(6_000);
    ackProjectEventDelivery(sql, retentionEnv, PROJECT_ID, {
      projectId: PROJECT_ID,
      deliveryId,
      visibility: AGENT_VISIBILITY,
      acknowledgedBy: AGENT_OWNER,
    });
    const afterAck = runProjectEventRetention(sql, retentionEnv, PROJECT_ID, {
      projectId: PROJECT_ID,
      now: 7_000,
      limit: 20,
    });

    expect(afterAck).toMatchObject({
      deletedEvents: 1,
      deletedMatches: 1,
      deletedBatches: 1,
    });
  });

  it('uses the replay index for subscription pagination', () => {
    createAgentSubscription(sql, env);
    admitGithubEvent(sql, env, 1);

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT m.id AS match_id,
                e.id
         FROM project_event_matches m
         JOIN project_events e ON e.project_id = m.project_id AND e.id = m.event_id
         WHERE m.project_id = ?
           AND m.subscription_id = ?
           AND m.state NOT IN ('expired', 'cancelled')
           AND (m.matched_at > ? OR (m.matched_at = ? AND m.id > ?))
         ORDER BY m.matched_at ASC, m.id ASC
         LIMIT ?`
      )
      .all(PROJECT_ID, 'subscription-1', 0, 0, '', 2) as Array<{ detail: string }>;
    const details = plan.map((entry) => entry.detail).join('\n');

    expect(details).toContain('idx_project_event_matches_project_subscription_replay');
    expect(details).not.toContain('USE TEMP B-TREE');
  });
});
