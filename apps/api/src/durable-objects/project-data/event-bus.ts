import { expectJsonRecord } from '../../lib/runtime-validation';
import { ulid } from '../../lib/ulid';
import {
  DEFAULT_PROJECT_DATA_EVENT_BUS_MAX_ROUTED_SUBSCRIPTIONS,
  DEFAULT_PROJECT_DATA_EVENT_BUS_METADATA_MAX_BYTES,
  DEFAULT_PROJECT_DATA_EVENT_BUS_PAYLOAD_MAX_BYTES,
  DEFAULT_PROJECT_DATA_EVENT_BUS_RETENTION_BATCH_ROWS,
  DEFAULT_PROJECT_DATA_EVENT_BUS_RETENTION_DAYS,
  type EventBusStorageConfig,
} from './event-bus-config';
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
  EventBusMetadataTooLargeError,
  EventBusPayloadTooLargeError,
} from './event-bus-contracts';
import {
  decodeEventBusCursor,
  DEFAULT_MCP_EVENT_BUS_CURSOR_MAX_LENGTH,
  encodeEventBusCursor,
} from './event-bus-cursors';
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
  parseEventDeliverySummaryJoinRow,
  parseEventPayload,
  parseEventRow,
  parseSubscriptionRow,
  readRequiredStringColumn,
  subscriptionMatchesEvent,
} from './event-bus-row-parsers';

export type { EventBusStorageConfig } from './event-bus-config';
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
  EventBusMetadataTooLargeError,
  EventBusPayloadTooLargeError,
} from './event-bus-contracts';
export { DEFAULT_MCP_EVENT_BUS_CURSOR_MAX_LENGTH } from './event-bus-cursors';
export type { EventBusRetentionResult } from './event-bus-retention';
export { computeEventBusRetentionAlarmTime, runEventBusRetention } from './event-bus-retention';

const DEFAULT_EVENT_BUS_STORAGE_CONFIG: EventBusStorageConfig = {
  payloadMaxBytes: DEFAULT_PROJECT_DATA_EVENT_BUS_PAYLOAD_MAX_BYTES,
  metadataMaxBytes: DEFAULT_PROJECT_DATA_EVENT_BUS_METADATA_MAX_BYTES,
  maxRoutedSubscriptions: DEFAULT_PROJECT_DATA_EVENT_BUS_MAX_ROUTED_SUBSCRIPTIONS,
  retentionMs: DEFAULT_PROJECT_DATA_EVENT_BUS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  retentionBatchRows: DEFAULT_PROJECT_DATA_EVENT_BUS_RETENTION_BATCH_ROWS,
};

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
  if (eventTypes) {
    for (const eventType of eventTypes) {
      sql.exec(
        `INSERT OR IGNORE INTO event_bus_subscription_event_types
          (subscription_id, event_type, subject_type, subject_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        id,
        eventType,
        subject?.type ?? null,
        subject?.id ?? null,
        now
      );
    }
  }

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
  input: PublishEventBusEventInput,
  config: EventBusStorageConfig = DEFAULT_EVENT_BUS_STORAGE_CONFIG
): EventBusPublishResult {
  const id = input.id ?? ulid();
  const now = input.now ?? Date.now();
  const occurredAt = input.occurredAt ?? now;
  const subject = normalizeReference(input.subject, 'event_bus.event.subject');
  const actor = normalizeReference(input.actor, 'event_bus.event.actor');
  const metadata = expectJsonRecord(input.metadata ?? {}, 'event_bus.event.metadata');
  const metadataJson = serializeEventBusMetadata(metadata, config.metadataMaxBytes);
  const payloadJson = serializeEventBusPayload(input.payload, config.payloadMaxBytes);
  const subscriptions = selectMatchingSubscriptions(
    sql,
    subject,
    input.type,
    now,
    config.maxRoutedSubscriptions
  );

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
    metadataJson,
    payloadJson,
    occurredAt,
    now
  );

  const [eventRow] = sql.exec('SELECT * FROM event_bus_events WHERE id = ?', id).toArray();
  const event = parseEventRow(eventRow);

  const deliveryIds: string[] = [];
  for (const subscription of subscriptions) {
    const deliveryId = ulid();
    sql.exec(
      `INSERT OR IGNORE INTO event_bus_deliveries
        (id, subscription_id, event_id, event_sequence, state, created_at, delivered_at, acknowledged_at, last_error)
       VALUES (?, ?, ?, ?, 'queued', ?, NULL, NULL, NULL)`,
      deliveryId,
      subscription.id,
      id,
      event.sequence,
      now
    );
    const insertedRow = sql
      .exec(
        'SELECT id FROM event_bus_deliveries WHERE subscription_id = ? AND event_id = ?',
        subscription.id,
        id
      )
      .toArray()[0];
    if (insertedRow) {
      deliveryIds.push(
        readRequiredStringColumn(insertedRow, 'id', 'event_bus.delivery.inserted_row')
      );
    }
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
         AND s.state = 'active'
         AND (s.expires_at IS NULL OR s.expires_at > ?)
         AND (
           (s.owner_type = 'task' AND s.owner_id = ?)
           OR (s.owner_type = 'session' AND s.owner_id = ?)
           OR (s.owner_type = 'agent_session' AND s.owner_id = ?)
           OR (s.owner_type IN ('policy', 'system') AND (
             (s.target_task_id IS NOT NULL AND s.target_task_id = ?)
             OR (s.target_session_id IS NOT NULL AND s.target_session_id = ?)
             OR (s.target_agent_session_id IS NOT NULL AND s.target_agent_session_id = ?)
           ))
         )
       ORDER BY d.created_at ASC, d.id ASC
       LIMIT 1`,
      eventId,
      now,
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
  now = Date.now(),
  cursorMaxLength = DEFAULT_MCP_EVENT_BUS_CURSOR_MAX_LENGTH
): SamEventBusEventListResult | null {
  const subscription = getVisibleSubscription(sql, input.subscriptionId, identity, now);
  if (!subscription) return null;

  const cursor = input.cursor
    ? decodeEventBusCursor(input.cursor, input.subscriptionId, cursorMaxLength)
    : {
        version: 1 as const,
        subscriptionId: input.subscriptionId,
        afterSequence: 0,
        afterDeliveryId: '',
      };

  const rows = sql
    .exec(
      `SELECT e.id,
              e.sequence,
              e.type,
              e.source,
              e.subject_type,
              e.subject_id,
              e.actor_type,
              e.actor_id,
              e.metadata,
              e.occurred_at,
              e.created_at,
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
         AND (d.event_sequence > ? OR (d.event_sequence = ? AND d.id > ?))
       ORDER BY d.event_sequence ASC, d.id ASC
       LIMIT ?`,
      input.subscriptionId,
      cursor.afterSequence,
      cursor.afterSequence,
      cursor.afterDeliveryId,
      input.limit + 1
    )
    .toArray()
    .map(parseEventDeliverySummaryJoinRow);

  const page = rows.slice(0, input.limit);
  const deliveries = markDeliveriesDeliveredIfQueued(
    sql,
    page.map((parsed) => parsed.delivery),
    now
  );
  const summaries = page.map((parsed, index) => {
    const delivery = deliveries[index];
    if (!delivery) throw new Error('Event bus delivery page index mismatch');
    return eventToSummary(parsed.event, delivery);
  });
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
  const delivery = getVisibleDelivery(sql, input.deliveryId, identity, now);
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

  const updated = getVisibleDelivery(sql, input.deliveryId, identity, now);
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
  identity: EventBusIdentity,
  now: number
): EventBusSubscriptionRecord | null {
  const [row] = sql
    .exec(
      `SELECT s.*, p.policy, p.ack_timeout_ms, p.max_attempts
       FROM event_bus_subscriptions s
       LEFT JOIN event_bus_delivery_policies p ON p.subscription_id = s.id
       WHERE s.id = ?
         AND s.state = 'active'
         AND (s.expires_at IS NULL OR s.expires_at > ?)
         AND (
           (s.owner_type = 'task' AND s.owner_id = ?)
           OR (s.owner_type = 'session' AND s.owner_id = ?)
           OR (s.owner_type = 'agent_session' AND s.owner_id = ?)
           OR (s.owner_type IN ('policy', 'system') AND (
             (s.target_task_id IS NOT NULL AND s.target_task_id = ?)
             OR (s.target_session_id IS NOT NULL AND s.target_session_id = ?)
             OR (s.target_agent_session_id IS NOT NULL AND s.target_agent_session_id = ?)
           ))
         )
       LIMIT 1`,
      subscriptionId,
      now,
      ...visibilityParams(identity)
    )
    .toArray();
  return row ? parseSubscriptionRow(row) : null;
}

function getVisibleDelivery(
  sql: SqlStorage,
  deliveryId: string,
  identity: EventBusIdentity,
  now: number
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
         AND s.state = 'active'
         AND (s.expires_at IS NULL OR s.expires_at > ?)
         AND (
           (s.owner_type = 'task' AND s.owner_id = ?)
           OR (s.owner_type = 'session' AND s.owner_id = ?)
           OR (s.owner_type = 'agent_session' AND s.owner_id = ?)
           OR (s.owner_type IN ('policy', 'system') AND (
             (s.target_task_id IS NOT NULL AND s.target_task_id = ?)
             OR (s.target_session_id IS NOT NULL AND s.target_session_id = ?)
             OR (s.target_agent_session_id IS NOT NULL AND s.target_agent_session_id = ?)
           ))
         )
       LIMIT 1`,
      deliveryId,
      now,
      ...visibilityParams(identity)
    )
    .toArray();
  return row ? parseDeliveryRecordRow(row) : null;
}

function selectMatchingSubscriptions(
  sql: SqlStorage,
  subject: { type: string; id: string | null },
  eventType: string,
  now: number,
  maxRoutedSubscriptions: number
): EventBusSubscriptionRecord[] {
  const routeLimit = Number.isSafeInteger(maxRoutedSubscriptions)
    ? Math.max(maxRoutedSubscriptions, 1)
    : DEFAULT_PROJECT_DATA_EVENT_BUS_MAX_ROUTED_SUBSCRIPTIONS;
  const subscriptionsById = new Map<string, EventBusSubscriptionRecord>();
  for (const branch of subjectRoutingBranches(subject)) {
    collectSubscriptionRows(
      subscriptionsById,
      sql
        .exec(
          wildcardEventTypeRoutingSql(branch.subscriptionWhere),
          ...branch.params,
          now,
          routeLimit + 1
        )
        .toArray(),
      routeLimit
    );
    collectSubscriptionRows(
      subscriptionsById,
      sql
        .exec(
          exactEventTypeRoutingSql(branch.eventTypeWhere),
          eventType,
          ...branch.params,
          now,
          routeLimit + 1
        )
        .toArray(),
      routeLimit
    );
  }
  const subscriptions = [...subscriptionsById.values()]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .filter((subscription) =>
      subscriptionMatchesEvent(subscription, {
        id: '',
        sequence: 0,
        type: eventType,
        source: '',
        subject_type: subject.type,
        subject_id: subject.id,
        actor_type: '',
        actor_id: null,
        metadata: '{}',
        occurred_at: now,
        created_at: now,
      })
    );
  if (subscriptions.length > routeLimit) {
    throw new Error('Event bus routed subscription limit exceeded');
  }
  return subscriptions;
}

interface SubjectRoutingBranch {
  subscriptionWhere: string;
  eventTypeWhere: string;
  params: unknown[];
}

function subjectRoutingBranches(subject: { type: string; id: string | null }): SubjectRoutingBranch[] {
  const branches: SubjectRoutingBranch[] = [
    {
      subscriptionWhere: 's.subject_type IS NULL AND s.subject_id IS NULL',
      eventTypeWhere: 'et.subject_type IS NULL AND et.subject_id IS NULL',
      params: [],
    },
    {
      subscriptionWhere: 's.subject_type = ? AND s.subject_id IS NULL',
      eventTypeWhere: 'et.subject_type = ? AND et.subject_id IS NULL',
      params: [subject.type],
    },
  ];
  if (subject.id !== null) {
    branches.push({
      subscriptionWhere: 's.subject_type = ? AND s.subject_id = ?',
      eventTypeWhere: 'et.subject_type = ? AND et.subject_id = ?',
      params: [subject.type, subject.id],
    });
  }
  return branches;
}

function wildcardEventTypeRoutingSql(subjectWhere: string): string {
  return `SELECT s.*, p.policy, p.ack_timeout_ms, p.max_attempts
          FROM event_bus_subscriptions s
          LEFT JOIN event_bus_delivery_policies p ON p.subscription_id = s.id
          WHERE s.state = 'active'
            AND ${subjectWhere}
            AND (s.expires_at IS NULL OR s.expires_at > ?)
            AND NOT EXISTS (
              SELECT 1
              FROM event_bus_subscription_event_types et_any
              WHERE et_any.subscription_id = s.id
            )
          ORDER BY s.created_at ASC, s.id ASC
          LIMIT ?`;
}

function exactEventTypeRoutingSql(subjectWhere: string): string {
  return `SELECT s.*, p.policy, p.ack_timeout_ms, p.max_attempts
          FROM event_bus_subscription_event_types et
          JOIN event_bus_subscriptions s ON s.id = et.subscription_id
          LEFT JOIN event_bus_delivery_policies p ON p.subscription_id = s.id
          WHERE et.event_type = ?
            AND ${subjectWhere}
            AND s.state = 'active'
            AND (s.expires_at IS NULL OR s.expires_at > ?)
          ORDER BY et.created_at ASC, et.subscription_id ASC
          LIMIT ?`;
}

function collectSubscriptionRows(
  subscriptions: Map<string, EventBusSubscriptionRecord>,
  rows: unknown[],
  routeLimit: number
): void {
  for (const row of rows) {
    const subscription = parseSubscriptionRow(row);
    subscriptions.set(subscription.id, subscription);
    if (subscriptions.size > routeLimit) {
      throw new Error('Event bus routed subscription limit exceeded');
    }
  }
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
  const [updated] = markDeliveriesDeliveredIfQueued(sql, [delivery], now);
  return updated ?? delivery;
}

function markDeliveriesDeliveredIfQueued(
  sql: SqlStorage,
  deliveries: SamEventBusDeliveryInfo[],
  now: number
): SamEventBusDeliveryInfo[] {
  const queuedIds = deliveries
    .filter((delivery) => delivery.state === 'queued')
    .map((delivery) => delivery.id);
  if (queuedIds.length > 0) {
    const placeholders = queuedIds.map(() => '?').join(', ');
    sql.exec(
      `UPDATE event_bus_deliveries
       SET state = 'delivered', delivered_at = COALESCE(delivered_at, ?)
       WHERE state = 'queued' AND id IN (${placeholders})`,
      now,
      ...queuedIds
    );
  }
  return deliveries.map((delivery) =>
    delivery.state === 'queued' ? asDeliveredDelivery(delivery, now) : delivery
  );
}

function asDeliveredDelivery(
  delivery: SamEventBusDeliveryInfo,
  now: number
): SamEventBusDeliveryInfo {
  return {
    ...delivery,
    state: 'delivered',
    deliveredAt: delivery.deliveredAt ?? now,
  };
}

function serializeEventBusMetadata(value: Record<string, unknown>, maxBytes: number): string {
  const raw = stringifyJson(value);
  const actualBytes = byteLength(raw);
  if (actualBytes > maxBytes) throw new EventBusMetadataTooLargeError(actualBytes, maxBytes);
  return raw;
}

function serializeEventBusPayload(value: unknown, maxBytes: number): string {
  const raw = stringifyJson(value);
  const actualBytes = byteLength(raw);
  if (actualBytes > maxBytes) throw new EventBusPayloadTooLargeError(actualBytes, maxBytes);
  return raw;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
