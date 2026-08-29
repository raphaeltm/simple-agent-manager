import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  acknowledgeEventBusDelivery,
  createEventBusSubscription,
  EventBusAckPolicyError,
  EventBusCursorError,
  getEventBusEventForIdentity,
  listEventBusSubscriptionEvents,
  publishEventBusEvent,
} from '../../../src/durable-objects/project-data/event-bus';
import { createSqlStorage } from './sql-storage-test-utils';

function identity(overrides: Parameters<typeof getEventBusEventForIdentity>[2] = {}) {
  return {
    projectId: 'project-1',
    userId: 'user-1',
    taskId: 'task-1',
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    agentSessionId: 'agent-session-1',
    ...overrides,
  };
}

describe('ProjectData event bus', () => {
  let db: Database.Database;
  let sql: SqlStorage;

  beforeEach(() => {
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
  });

  afterEach(() => db.close());

  function createTaskSubscription(
    overrides: Partial<Parameters<typeof createEventBusSubscription>[1]> = {}
  ) {
    return createEventBusSubscription(
      sql,
      {
        id: 'sub-task-1',
        ownerType: 'task',
        ownerId: 'task-1',
        targetTaskId: 'task-1',
        targetSessionId: 'session-1',
        targetAgentSessionId: 'agent-session-1',
        eventTypes: ['task.completed', 'task.failed'],
        deliveryPolicy: 'ack_required',
        now: 1_000,
        ...overrides,
      }
    );
  }

  function publish(id: string, type = 'task.completed') {
    return publishEventBusEvent(sql, {
      id,
      type,
      source: 'orchestrator',
      subject: { type: 'task', id: 'child-task-1' },
      actor: { type: 'system', id: null },
      metadata: { reason: 'condition_met', attempt: id },
      payload: { secret: `payload-secret-${id}`, output: `result-${id}` },
      occurredAt: 2_000,
      now: 2_100,
    });
  }

  it('fetches one authorized event by stable event id with normalized metadata and payload', () => {
    createTaskSubscription();
    publish('event-1');

    const event = getEventBusEventForIdentity(sql, 'event-1', identity(), 3_000);

    expect(event).toMatchObject({
      id: 'event-1',
      type: 'task.completed',
      source: 'orchestrator',
      subject: { type: 'task', id: 'child-task-1' },
      actor: { type: 'system', id: null },
      metadata: { reason: 'condition_met', attempt: 'event-1' },
      payload: { secret: 'payload-secret-event-1', output: 'result-event-1' },
      delivery: {
        subscriptionId: 'sub-task-1',
        state: 'delivered',
        policy: 'ack_required',
        ackRequired: true,
        deliveredAt: 3_000,
      },
    });
    expect(event?.sequence).toBeGreaterThan(0);
    expect(
      db.prepare('SELECT state, delivered_at FROM event_bus_deliveries WHERE event_id = ?').get(
        'event-1'
      )
    ).toEqual({ state: 'delivered', delivered_at: 3_000 });
  });

  it('returns the same null result for nonexistent and unauthorized event ids', () => {
    createTaskSubscription();
    publish('event-1');

    const unauthorized = getEventBusEventForIdentity(
      sql,
      'event-1',
      identity({ taskId: 'other-task', sessionId: 'other-session', agentSessionId: 'other-agent' })
    );
    const nonexistent = getEventBusEventForIdentity(sql, 'missing-event', identity());

    expect(unauthorized).toBeNull();
    expect(nonexistent).toBeNull();
    expect(JSON.stringify({ unauthorized, nonexistent })).not.toContain('payload-secret');
  });

  it('cursor-paginates missed subscription events without payload leakage in summaries', () => {
    createTaskSubscription();
    publish('event-1');
    publish('event-2');
    publish('event-3');

    const first = listEventBusSubscriptionEvents(
      sql,
      { subscriptionId: 'sub-task-1', limit: 2 },
      identity(),
      4_000
    );

    expect(first.events.map((event) => event.id)).toEqual(['event-1', 'event-2']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(first.events)).not.toContain('payload-secret');
    expect(
      db.prepare(
        "SELECT COUNT(*) AS cnt FROM event_bus_deliveries WHERE subscription_id = ? AND state = 'delivered'"
      ).get('sub-task-1')
    ).toEqual({ cnt: 2 });

    const late = publish('event-4');
    expect(late.deliveryIds).toHaveLength(1);

    const second = listEventBusSubscriptionEvents(
      sql,
      { subscriptionId: 'sub-task-1', limit: 2, cursor: first.nextCursor },
      identity(),
      5_000
    );

    expect(second.events.map((event) => event.id)).toEqual(['event-3', 'event-4']);
    expect(second.nextCursor).toBeNull();
    expect(second.hasMore).toBe(false);
  });

  it('rejects malformed or subscription-mismatched cursors', () => {
    createTaskSubscription();
    createTaskSubscription({
      id: 'sub-other',
      ownerId: 'task-1',
      targetTaskId: 'task-1',
      deliveryPolicy: 'ack_required',
    });
    publish('event-1');
    publish('event-2');

    expect(() =>
      listEventBusSubscriptionEvents(
        sql,
        { subscriptionId: 'sub-task-1', limit: 2, cursor: 'not-a-cursor' },
        identity()
      )
    ).toThrow(EventBusCursorError);

    const first = listEventBusSubscriptionEvents(
      sql,
      { subscriptionId: 'sub-task-1', limit: 1 },
      identity()
    );

    expect(() =>
      listEventBusSubscriptionEvents(
        sql,
        { subscriptionId: 'sub-other', limit: 1, cursor: first.nextCursor },
        identity()
      )
    ).toThrow(EventBusCursorError);
  });

  it('enforces subscription ownership boundaries across task, session, and agent-session owners', () => {
    createEventBusSubscription(sql, {
      id: 'sub-session',
      ownerType: 'session',
      ownerId: 'session-1',
      targetSessionId: 'session-1',
      deliveryPolicy: 'none',
      now: 1_000,
    });
    createEventBusSubscription(sql, {
      id: 'sub-agent',
      ownerType: 'agent_session',
      ownerId: 'agent-session-1',
      targetAgentSessionId: 'agent-session-1',
      deliveryPolicy: 'none',
      now: 1_000,
    });
    createEventBusSubscription(sql, {
      id: 'sub-policy',
      ownerType: 'policy',
      ownerId: 'policy-1',
      targetTaskId: 'task-1',
      deliveryPolicy: 'none',
      now: 1_000,
    });
    publish('event-1');

    expect(
      listEventBusSubscriptionEvents(
        sql,
        { subscriptionId: 'sub-session', limit: 5 },
        identity({ sessionId: 'session-1' })
      )?.events
    ).toHaveLength(1);
    expect(
      listEventBusSubscriptionEvents(
        sql,
        { subscriptionId: 'sub-agent', limit: 5 },
        identity({ agentSessionId: 'agent-session-1' })
      )?.events
    ).toHaveLength(1);
    expect(
      listEventBusSubscriptionEvents(
        sql,
        { subscriptionId: 'sub-policy', limit: 5 },
        identity({ taskId: 'task-1' })
      )?.events
    ).toHaveLength(1);
    expect(
      listEventBusSubscriptionEvents(
        sql,
        { subscriptionId: 'sub-session', limit: 5 },
        identity({ sessionId: 'other-session' })
      )
    ).toBeNull();
  });

  it('keeps routing semantics independent from acknowledgement policy', () => {
    createEventBusSubscription(sql, {
      id: 'sub-ack',
      ownerType: 'task',
      ownerId: 'task-1',
      targetTaskId: 'task-1',
      eventTypes: ['task.completed'],
      deliveryPolicy: 'ack_required',
      now: 1_000,
    });
    createEventBusSubscription(sql, {
      id: 'sub-no-ack',
      ownerType: 'task',
      ownerId: 'task-1',
      targetTaskId: 'task-1',
      eventTypes: ['task.completed'],
      deliveryPolicy: 'none',
      now: 1_000,
    });

    publish('event-1');

    const deliveries = db
      .prepare(
        'SELECT subscription_id, state FROM event_bus_deliveries WHERE event_id = ? ORDER BY subscription_id'
      )
      .all('event-1');
    expect(deliveries).toEqual([
      { subscription_id: 'sub-ack', state: 'queued' },
      { subscription_id: 'sub-no-ack', state: 'queued' },
    ]);
  });

  it('acknowledges ack-required deliveries idempotently and rejects non-ack policy', () => {
    createTaskSubscription();
    createTaskSubscription({
      id: 'sub-no-ack',
      deliveryPolicy: 'none',
    });
    publish('event-1');

    const ackDelivery = db
      .prepare('SELECT id FROM event_bus_deliveries WHERE subscription_id = ?')
      .get('sub-task-1') as { id: string };
    const noAckDelivery = db
      .prepare('SELECT id FROM event_bus_deliveries WHERE subscription_id = ?')
      .get('sub-no-ack') as { id: string };

    const first = acknowledgeEventBusDelivery(
      sql,
      { deliveryId: ackDelivery.id },
      identity(),
      6_000
    );
    const second = acknowledgeEventBusDelivery(
      sql,
      { deliveryId: ackDelivery.id },
      identity(),
      7_000
    );

    expect(first).toMatchObject({
      acknowledged: true,
      idempotent: false,
      delivery: {
        id: ackDelivery.id,
        state: 'acknowledged',
        acknowledgedAt: 6_000,
        deliveredAt: 6_000,
      },
    });
    expect(second).toMatchObject({
      acknowledged: true,
      idempotent: true,
      delivery: {
        id: ackDelivery.id,
        state: 'acknowledged',
        acknowledgedAt: 6_000,
      },
    });
    expect(() =>
      acknowledgeEventBusDelivery(sql, { deliveryId: noAckDelivery.id }, identity())
    ).toThrow(EventBusAckPolicyError);
  });
});
