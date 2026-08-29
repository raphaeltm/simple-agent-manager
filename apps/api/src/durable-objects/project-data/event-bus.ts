import { expectJsonRecord } from '../../lib/runtime-validation';
import { ulid } from '../../lib/ulid';
import type {
  AcknowledgeEventBusDeliveryInput,
  CreateEventBusSubscriptionInput,
  EventBusIdentity,
  EventBusPublishResult,
  EventBusSubscriptionRecord,
  ListEventBusSubscriptionEventsInput,
  PublishEventBusEventInput,
  SamEventBusAckResult,
  SamEventBusDeliveryInfo,
  SamEventBusDeliveryRecord,
  SamEventBusEvent,
  SamEventBusEventListResult,
} from './event-bus-contracts';
import {
  EventBusAckPolicyError,
  EventBusAckStateError,
} from './event-bus-contracts';
import { decodeEventBusCursor, encodeEventBusCursor } from './event-bus-cursors';
import {
  assertDeliveryPolicy,
  assertOwnerType,
  eventToStoredEvent,
  eventToSummary,
  normalizeEventTypes,
  normalizeNullablePositiveInteger,
  normalizeOptionalReference,
  normalizeReference,
  parseDeliveryRecordRow,
  parseEventDeliveryJoinRow,
  parseEventPayload,
  parseEventRow,
  parseSubscriptionRow,
  subscriptionMatchesEvent,
} from './event-bus-row-parsers';

export type {
  AcknowledgeEventBusDeliveryInput,
  CreateEventBusSubscriptionInput,
  EventBusIdentity,
  EventBusPublishResult,
  EventBusSubscriptionRecord,
  ListEventBusSubscriptionEventsInput,
  PublishEventBusEventInput,
  SamEventBusAckResult,
  SamEventBusDeliveryInfo,
  SamEventBusDeliveryPolicy,
  SamEventBusDeliveryRecord,
  SamEventBusDeliveryState,
  SamEventBusEvent,
  SamEventBusEventListResult,
  SamEventBusEventSummary,
  SamEventBusReference,
  SamEventBusStoredEvent,
  SamEventBusSubscriptionOwnerType,
} from './event-bus-contracts';
export {
  EVENT_BUS_DELIVERY_POLICIES,
  EVENT_BUS_DELIVERY_STATES,
  EVENT_BUS_SUBSCRIPTION_OWNER_TYPES,
  EventBusAckPolicyError,
  EventBusAckStateError,
  EventBusCursorError,
} from './event-bus-contracts';

export function createEventBusSubscription(
  sql: SqlStorage,
  input: CreateEventBusSubscriptionInput
): EventBusSubscriptionRecord {
  const id = input.id ?? ulid();
  const now = input.now ?? Date.now();
  const deliveryPolicy = input.deliveryPolicy ?? 'none';
  assertOwnerType(input.ownerType);
  assertDeliveryPolicy(deliveryPolicy);
  const eventTypes = normalizeEventTypes(input.eventTypes ?? null);
  const subject = normalizeOptionalReference(
    input.subject ?? null,
    'event_bus.subscription.subject'
  );
  const ackTimeoutMs = normalizeNullablePositiveInteger(input.ackTimeoutMs ?? null);
  const maxAttempts = normalizeNullablePositiveInteger(input.maxAttempts ?? null);

  sql.exec(
    `INSERT INTO event_bus_subscriptions
      (id, owner_type, owner_id, target_task_id, target_session_id, target_agent_session_id,
       event_types, subject_type, subject_id, state, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    id,
    input.ownerType,
    input.ownerId,
    input.targetTaskId ?? null,
    input.targetSessionId ?? null,
    input.targetAgentSessionId ?? null,
    eventTypes ? JSON.stringify(eventTypes) : null,
    subject?.type ?? null,
    subject?.id ?? null,
    now,
    now,
    input.expiresAt ?? null
  );
  sql.exec(
    `INSERT INTO event_bus_delivery_policies
      (subscription_id, policy, ack_timeout_ms, max_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    deliveryPolicy,
    ackTimeoutMs,
    maxAttempts,
    now,
    now
  );

  return {
    id,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    targetTaskId: input.targetTaskId ?? null,
    targetSessionId: input.targetSessionId ?? null,
    targetAgentSessionId: input.targetAgentSessionId ?? null,
    eventTypes,
    subject,
    state: 'active',
    deliveryPolicy,
    ackTimeoutMs,
    maxAttempts,
    createdAt: now,
    updatedAt: now,
    expiresAt: input.expiresAt ?? null,
  };
}

export function publishEventBusEvent(
  sql: SqlStorage,
  input: PublishEventBusEventInput
): EventBusPublishResult {
  const id = input.id ?? ulid();
  const now = input.now ?? Date.now();
  const occurredAt = input.occurredAt ?? now;
  const subject = normalizeReference(input.subject, 'event_bus.event.subject');
  const actor = normalizeReference(input.actor, 'event_bus.event.actor');
  const metadata = expectJsonRecord(input.metadata ?? {}, 'event_bus.event.metadata');

  sql.exec(
    `INSERT INTO event_bus_events
      (id, type, source, subject_type, subject_id, actor_type, actor_id,
       metadata, payload, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.type,
    input.source,
    subject.type,
    subject.id,
    actor.type,
    actor.id,
    JSON.stringify(metadata),
    JSON.stringify(input.payload),
    occurredAt,
    now
  );

  const [eventRow] = sql.exec('SELECT * FROM event_bus_events WHERE id = ?', id).toArray();
  const event = parseEventRow(eventRow);
  const subscriptions = sql
    .exec(
      `SELECT s.*, p.policy, p.ack_timeout_ms, p.max_attempts
       FROM event_bus_subscriptions s
       LEFT JOIN event_bus_delivery_policies p ON p.subscription_id = s.id
       WHERE s.state = 'active'
         AND (s.expires_at IS NULL OR s.expires_at > ?)
         AND (s.subject_type IS NULL OR s.subject_type = ?)
         AND (s.subject_id IS NULL OR s.subject_id = ?)`,
      now,
      subject.type,
      subject.id
    )
    .toArray()
    .map(parseSubscriptionRow)
    .filter((subscription) => subscriptionMatchesEvent(subscription, event));

  const deliveryIds: string[] = [];
  for (const subscription of subscriptions) {
    const deliveryId = ulid();
    sql.exec(
      `INSERT OR IGNORE INTO event_bus_deliveries
        (id, subscription_id, event_id, state, created_at, delivered_at, acknowledged_at, last_error)
       VALUES (?, ?, ?, 'queued', ?, NULL, NULL, NULL)`,
      deliveryId,
      subscription.id,
      id,
      now
    );
    const inserted = sql
      .exec(
        'SELECT id FROM event_bus_deliveries WHERE subscription_id = ? AND event_id = ?',
        subscription.id,
        id
      )
      .toArray()[0] as { id: string } | undefined;
    if (inserted) deliveryIds.push(inserted.id);
  }

  return {
    event: eventToStoredEvent(event),
    deliveryIds,
  };
}

export function getEventBusEventForIdentity(
  sql: SqlStorage,
  eventId: string,
  identity: EventBusIdentity,
  now = Date.now()
): SamEventBusEvent | null {
  const [row] = sql
    .exec(
      `SELECT e.*,
              d.id AS delivery_id,
              d.subscription_id AS subscription_id,
              d.state AS delivery_state,
              d.created_at AS delivery_created_at,
              d.delivered_at AS delivered_at,
              d.acknowledged_at AS acknowledged_at,
              p.policy AS policy
       FROM event_bus_deliveries d
       JOIN event_bus_events e ON e.id = d.event_id
       JOIN event_bus_subscriptions s ON s.id = d.subscription_id
       LEFT JOIN event_bus_delivery_policies p ON p.subscription_id = s.id
       WHERE e.id = ?
         AND ${visibilitySqlPredicate()}
       ORDER BY d.created_at ASC, d.id ASC
       LIMIT 1`,
      eventId,
      ...visibilityParams(identity)
    )
    .toArray();

  if (!row) return null;
  const parsed = parseEventDeliveryJoinRow(row);
  const delivery = markDeliveryDeliveredIfQueued(sql, parsed.delivery, now);
  return {
    ...eventToSummary(parsed.event, delivery),
    payload: parseEventPayload(parsed.event.payload),
  };
}

export function listEventBusSubscriptionEvents(
  sql: SqlStorage,
  input: ListEventBusSubscriptionEventsInput,
  identity: EventBusIdentity,
  now = Date.now()
): SamEventBusEventListResult | null {
  const subscription = getVisibleSubscription(sql, input.subscriptionId, identity);
  if (!subscription) return null;

  const cursor = input.cursor
    ? decodeEventBusCursor(input.cursor, input.subscriptionId)
    : {
        version: 1 as const,
        subscriptionId: input.subscriptionId,
        afterSequence: 0,
        afterDeliveryId: '',
      };

  const rows = sql
    .exec(
      `SELECT e.*,
              d.id AS delivery_id,
              d.subscription_id AS subscription_id,
              d.state AS delivery_state,
              d.created_at AS delivery_created_at,
              d.delivered_at AS delivered_at,
              d.acknowledged_at AS acknowledged_at,
              p.policy AS policy
       FROM event_bus_deliveries d
       JOIN event_bus_events e ON e.id = d.event_id
       LEFT JOIN event_bus_delivery_policies p ON p.subscription_id = d.subscription_id
       WHERE d.subscription_id = ?
         AND (e.sequence > ? OR (e.sequence = ? AND d.id > ?))
       ORDER BY e.sequence ASC, d.id ASC
       LIMIT ?`,
      input.subscriptionId,
      cursor.afterSequence,
      cursor.afterSequence,
      cursor.afterDeliveryId,
      input.limit + 1
    )
    .toArray()
    .map(parseEventDeliveryJoinRow);

  const page = rows.slice(0, input.limit);
  const summaries = page.map((parsed) =>
    eventToSummary(parsed.event, markDeliveryDeliveredIfQueued(sql, parsed.delivery, now))
  );
  const last = page.at(-1);

  return {
    subscriptionId: input.subscriptionId,
    events: summaries,
    nextCursor:
      rows.length > input.limit && last
        ? encodeEventBusCursor({
            version: 1,
            subscriptionId: input.subscriptionId,
            afterSequence: last.event.sequence,
            afterDeliveryId: last.delivery.id,
          })
        : null,
    hasMore: rows.length > input.limit,
  };
}

export function acknowledgeEventBusDelivery(
  sql: SqlStorage,
  input: AcknowledgeEventBusDeliveryInput,
  identity: EventBusIdentity,
  now = Date.now()
): SamEventBusAckResult | null {
  const delivery = getVisibleDelivery(sql, input.deliveryId, identity);
  if (!delivery) return null;
  if (delivery.policy !== 'ack_required') {
    throw new EventBusAckPolicyError();
  }
  if (delivery.state === 'acknowledged') {
    return {
      acknowledged: true,
      idempotent: true,
      delivery,
    };
  }
  if (delivery.state !== 'queued' && delivery.state !== 'delivered') {
    throw new EventBusAckStateError();
  }

  sql.exec(
    `UPDATE event_bus_deliveries
     SET state = 'acknowledged',
         delivered_at = COALESCE(delivered_at, ?),
         acknowledged_at = COALESCE(acknowledged_at, ?)
     WHERE id = ?
       AND state IN ('queued', 'delivered')`,
    now,
    now,
    input.deliveryId
  );

  const updated = getVisibleDelivery(sql, input.deliveryId, identity);
  if (!updated) return null;
  return {
    acknowledged: true,
    idempotent: false,
    delivery: updated,
  };
}

function getVisibleSubscription(
  sql: SqlStorage,
  subscriptionId: string,
  identity: EventBusIdentity
): EventBusSubscriptionRecord | null {
  const [row] = sql
    .exec(
      `SELECT s.*, p.policy, p.ack_timeout_ms, p.max_attempts
       FROM event_bus_subscriptions s
       LEFT JOIN event_bus_delivery_policies p ON p.subscription_id = s.id
       WHERE s.id = ?
         AND ${visibilitySqlPredicate()}
       LIMIT 1`,
      subscriptionId,
      ...visibilityParams(identity)
    )
    .toArray();
  return row ? parseSubscriptionRow(row) : null;
}

function getVisibleDelivery(
  sql: SqlStorage,
  deliveryId: string,
  identity: EventBusIdentity
): SamEventBusDeliveryRecord | null {
  const [row] = sql
    .exec(
      `SELECT d.id,
              d.subscription_id,
              d.event_id,
              d.state,
              d.created_at,
              d.delivered_at,
              d.acknowledged_at,
              p.policy
       FROM event_bus_deliveries d
       JOIN event_bus_subscriptions s ON s.id = d.subscription_id
       LEFT JOIN event_bus_delivery_policies p ON p.subscription_id = s.id
       WHERE d.id = ?
         AND ${visibilitySqlPredicate()}
       LIMIT 1`,
      deliveryId,
      ...visibilityParams(identity)
    )
    .toArray();
  return row ? parseDeliveryRecordRow(row) : null;
}

function visibilitySqlPredicate(): string {
  return `(
    (s.owner_type = 'task' AND s.owner_id = ?)
    OR (s.owner_type = 'session' AND s.owner_id = ?)
    OR (s.owner_type = 'agent_session' AND s.owner_id = ?)
    OR (s.owner_type IN ('policy', 'system') AND (
      (s.target_task_id IS NOT NULL AND s.target_task_id = ?)
      OR (s.target_session_id IS NOT NULL AND s.target_session_id = ?)
      OR (s.target_agent_session_id IS NOT NULL AND s.target_agent_session_id = ?)
    ))
  )`;
}

function visibilityParams(identity: EventBusIdentity): unknown[] {
  return [
    identity.taskId ?? null,
    identity.sessionId ?? null,
    identity.agentSessionId ?? null,
    identity.taskId ?? null,
    identity.sessionId ?? null,
    identity.agentSessionId ?? null,
  ];
}

function markDeliveryDeliveredIfQueued(
  sql: SqlStorage,
  delivery: SamEventBusDeliveryInfo,
  now: number
): SamEventBusDeliveryInfo {
  if (delivery.state !== 'queued') return delivery;
  sql.exec(
    `UPDATE event_bus_deliveries
     SET state = 'delivered', delivered_at = COALESCE(delivered_at, ?)
     WHERE id = ? AND state = 'queued'`,
    now,
    delivery.id
  );
  return {
    ...delivery,
    state: 'delivered',
    deliveredAt: delivery.deliveredAt ?? now,
  };
}
