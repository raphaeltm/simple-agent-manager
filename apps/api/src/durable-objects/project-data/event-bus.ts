import { expectJsonRecord, parseJsonRecord } from '../../lib/runtime-validation';
import { ulid } from '../../lib/ulid';

export const EVENT_BUS_SUBSCRIPTION_OWNER_TYPES = [
  'task',
  'session',
  'agent_session',
  'policy',
  'system',
] as const;

export type SamEventBusSubscriptionOwnerType =
  (typeof EVENT_BUS_SUBSCRIPTION_OWNER_TYPES)[number];

export const EVENT_BUS_DELIVERY_POLICIES = ['none', 'ack_required'] as const;

export type SamEventBusDeliveryPolicy = (typeof EVENT_BUS_DELIVERY_POLICIES)[number];

export const EVENT_BUS_DELIVERY_STATES = [
  'queued',
  'delivered',
  'acknowledged',
  'failed',
  'expired',
] as const;

export type SamEventBusDeliveryState = (typeof EVENT_BUS_DELIVERY_STATES)[number];

export interface SamEventBusReference {
  type: string;
  id: string | null;
}

export interface SamEventBusDeliveryInfo {
  id: string;
  subscriptionId: string;
  state: SamEventBusDeliveryState;
  policy: SamEventBusDeliveryPolicy;
  ackRequired: boolean;
  createdAt: number;
  deliveredAt: number | null;
  acknowledgedAt: number | null;
}

export interface SamEventBusDeliveryRecord extends SamEventBusDeliveryInfo {
  eventId: string;
}

export interface SamEventBusEventSummary {
  id: string;
  sequence: number;
  type: string;
  source: string;
  subject: SamEventBusReference;
  actor: SamEventBusReference;
  metadata: Record<string, unknown>;
  occurredAt: number;
  createdAt: number;
  payloadAvailable: true;
  delivery: SamEventBusDeliveryInfo;
}

export type SamEventBusStoredEvent = Omit<SamEventBusEventSummary, 'delivery'>;

export interface SamEventBusEvent extends SamEventBusEventSummary {
  payload: unknown;
}

export interface SamEventBusEventListResult {
  subscriptionId: string;
  events: SamEventBusEventSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SamEventBusAckResult {
  acknowledged: true;
  idempotent: boolean;
  delivery: SamEventBusDeliveryRecord;
}

export class EventBusCursorError extends Error {
  constructor(message = 'Invalid event bus cursor') {
    super(message);
    this.name = 'EventBusCursorError';
  }
}

export class EventBusAckPolicyError extends Error {
  constructor(message = 'Delivery does not require acknowledgement') {
    super(message);
    this.name = 'EventBusAckPolicyError';
  }
}

export class EventBusAckStateError extends Error {
  constructor(message = 'Delivery cannot be acknowledged in its current state') {
    super(message);
    this.name = 'EventBusAckStateError';
  }
}

export interface EventBusIdentity {
  projectId: string;
  userId: string;
  taskId?: string | null;
  sessionId?: string | null;
  workspaceId?: string | null;
  agentSessionId?: string | null;
}

export interface CreateEventBusSubscriptionInput {
  id?: string;
  ownerType: SamEventBusSubscriptionOwnerType;
  ownerId: string;
  targetTaskId?: string | null;
  targetSessionId?: string | null;
  targetAgentSessionId?: string | null;
  eventTypes?: string[] | null;
  subject?: SamEventBusReference | null;
  deliveryPolicy?: SamEventBusDeliveryPolicy;
  ackTimeoutMs?: number | null;
  maxAttempts?: number | null;
  expiresAt?: number | null;
  now?: number;
}

export interface EventBusSubscriptionRecord {
  id: string;
  ownerType: SamEventBusSubscriptionOwnerType;
  ownerId: string;
  targetTaskId: string | null;
  targetSessionId: string | null;
  targetAgentSessionId: string | null;
  eventTypes: string[] | null;
  subject: SamEventBusReference | null;
  state: 'active' | 'paused' | 'closed';
  deliveryPolicy: SamEventBusDeliveryPolicy;
  ackTimeoutMs: number | null;
  maxAttempts: number | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

export interface PublishEventBusEventInput {
  id?: string;
  type: string;
  source: string;
  subject: SamEventBusReference;
  actor: SamEventBusReference;
  metadata?: Record<string, unknown> | null;
  payload: unknown;
  occurredAt?: number;
  now?: number;
}

export interface EventBusPublishResult {
  event: SamEventBusStoredEvent;
  deliveryIds: string[];
}

export interface ListEventBusSubscriptionEventsInput {
  subscriptionId: string;
  limit: number;
  cursor?: string | null;
}

export interface AcknowledgeEventBusDeliveryInput {
  deliveryId: string;
}

interface EventBusCursor {
  version: 1;
  subscriptionId: string;
  afterSequence: number;
  afterDeliveryId: string;
}

interface EventBusEventRow {
  id: string;
  sequence: number;
  type: string;
  source: string;
  subject_type: string;
  subject_id: string | null;
  actor_type: string;
  actor_id: string | null;
  metadata: string;
  payload: string;
  occurred_at: number;
  created_at: number;
}

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
    normalizeNullablePositiveInteger(input.ackTimeoutMs ?? null),
    normalizeNullablePositiveInteger(input.maxAttempts ?? null),
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
    ackTimeoutMs: normalizeNullablePositiveInteger(input.ackTimeoutMs ?? null),
    maxAttempts: normalizeNullablePositiveInteger(input.maxAttempts ?? null),
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
      identity.taskId ?? null,
      identity.sessionId ?? null,
      identity.agentSessionId ?? null,
      identity.taskId ?? null,
      identity.sessionId ?? null,
      identity.agentSessionId ?? null
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
        version: 1,
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
      identity.taskId ?? null,
      identity.sessionId ?? null,
      identity.agentSessionId ?? null,
      identity.taskId ?? null,
      identity.sessionId ?? null,
      identity.agentSessionId ?? null
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
      identity.taskId ?? null,
      identity.sessionId ?? null,
      identity.agentSessionId ?? null,
      identity.taskId ?? null,
      identity.sessionId ?? null,
      identity.agentSessionId ?? null
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

function eventToSummary(
  event: EventBusEventRow,
  delivery: SamEventBusDeliveryInfo
): SamEventBusEventSummary {
  return {
    ...eventToStoredEvent(event),
    delivery,
  };
}

function eventToStoredEvent(event: EventBusEventRow): SamEventBusStoredEvent {
  return {
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    source: event.source,
    subject: { type: event.subject_type, id: event.subject_id },
    actor: { type: event.actor_type, id: event.actor_id },
    metadata: parseJsonRecord(event.metadata, `event_bus.events.${event.id}.metadata`),
    occurredAt: event.occurred_at,
    createdAt: event.created_at,
    payloadAvailable: true,
  };
}

function parseEventPayload(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

function parseEventRow(row: unknown): EventBusEventRow {
  const record = expectJsonRecord(row, 'event_bus.event.row');
  return {
    id: requireString(record.id, 'event_bus.event.id'),
    sequence: requireNumber(record.sequence, 'event_bus.event.sequence'),
    type: requireString(record.type, 'event_bus.event.type'),
    source: requireString(record.source, 'event_bus.event.source'),
    subject_type: requireString(record.subject_type, 'event_bus.event.subject_type'),
    subject_id: optionalString(record.subject_id),
    actor_type: requireString(record.actor_type, 'event_bus.event.actor_type'),
    actor_id: optionalString(record.actor_id),
    metadata: requireString(record.metadata, 'event_bus.event.metadata'),
    payload: requireString(record.payload, 'event_bus.event.payload'),
    occurred_at: requireNumber(record.occurred_at, 'event_bus.event.occurred_at'),
    created_at: requireNumber(record.created_at, 'event_bus.event.created_at'),
  };
}

function parseSubscriptionRow(row: unknown): EventBusSubscriptionRecord {
  const record = expectJsonRecord(row, 'event_bus.subscription.row');
  const ownerType = requireString(record.owner_type, 'event_bus.subscription.owner_type');
  assertOwnerType(ownerType);
  const policy = (optionalString(record.policy) ?? 'none') as SamEventBusDeliveryPolicy;
  assertDeliveryPolicy(policy);
  const state = requireString(record.state, 'event_bus.subscription.state');
  if (state !== 'active' && state !== 'paused' && state !== 'closed') {
    throw new Error(`Invalid event bus subscription state: ${state}`);
  }
  const subjectType = optionalString(record.subject_type);
  const subjectId = optionalString(record.subject_id);
  return {
    id: requireString(record.id, 'event_bus.subscription.id'),
    ownerType,
    ownerId: requireString(record.owner_id, 'event_bus.subscription.owner_id'),
    targetTaskId: optionalString(record.target_task_id),
    targetSessionId: optionalString(record.target_session_id),
    targetAgentSessionId: optionalString(record.target_agent_session_id),
    eventTypes: parseEventTypes(optionalString(record.event_types)),
    subject: subjectType ? { type: subjectType, id: subjectId } : null,
    state,
    deliveryPolicy: policy,
    ackTimeoutMs: optionalNumber(record.ack_timeout_ms),
    maxAttempts: optionalNumber(record.max_attempts),
    createdAt: requireNumber(record.created_at, 'event_bus.subscription.created_at'),
    updatedAt: requireNumber(record.updated_at, 'event_bus.subscription.updated_at'),
    expiresAt: optionalNumber(record.expires_at),
  };
}

function parseEventDeliveryJoinRow(row: unknown): {
  event: EventBusEventRow;
  delivery: SamEventBusDeliveryInfo;
} {
  const record = expectJsonRecord(row, 'event_bus.delivery.join_row');
  const event = parseEventRow(record);
  const deliveryState = requireString(record.delivery_state, 'event_bus.delivery.state');
  assertDeliveryState(deliveryState);
  const policy = (optionalString(record.policy) ?? 'none') as SamEventBusDeliveryPolicy;
  assertDeliveryPolicy(policy);
  return {
    event,
    delivery: {
      id: requireString(record.delivery_id, 'event_bus.delivery.id'),
      subscriptionId: requireString(record.subscription_id, 'event_bus.delivery.subscription_id'),
      state: deliveryState,
      policy,
      ackRequired: policy === 'ack_required',
      createdAt: requireNumber(record.delivery_created_at, 'event_bus.delivery.created_at'),
      deliveredAt: optionalNumber(record.delivered_at),
      acknowledgedAt: optionalNumber(record.acknowledged_at),
    },
  };
}

function parseDeliveryRecordRow(row: unknown): SamEventBusDeliveryRecord {
  const record = expectJsonRecord(row, 'event_bus.delivery.row');
  const state = requireString(record.state, 'event_bus.delivery.state');
  assertDeliveryState(state);
  const policy = (optionalString(record.policy) ?? 'none') as SamEventBusDeliveryPolicy;
  assertDeliveryPolicy(policy);
  return {
    id: requireString(record.id, 'event_bus.delivery.id'),
    subscriptionId: requireString(record.subscription_id, 'event_bus.delivery.subscription_id'),
    eventId: requireString(record.event_id, 'event_bus.delivery.event_id'),
    state,
    policy,
    ackRequired: policy === 'ack_required',
    createdAt: requireNumber(record.created_at, 'event_bus.delivery.created_at'),
    deliveredAt: optionalNumber(record.delivered_at),
    acknowledgedAt: optionalNumber(record.acknowledged_at),
  };
}

function subscriptionMatchesEvent(
  subscription: EventBusSubscriptionRecord,
  event: EventBusEventRow
): boolean {
  if (subscription.eventTypes && !subscription.eventTypes.includes(event.type)) return false;
  if (subscription.subject) {
    if (subscription.subject.type !== event.subject_type) return false;
    if (subscription.subject.id !== null && subscription.subject.id !== event.subject_id) {
      return false;
    }
  }
  return true;
}

function normalizeReference(value: SamEventBusReference | null, context: string): SamEventBusReference {
  if (!value) throw new Error(`${context} is required`);
  const type = value.type.trim();
  if (!type) throw new Error(`${context}.type is required`);
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : null;
  return { type, id };
}

function normalizeOptionalReference(
  value: SamEventBusReference | null,
  context: string
): SamEventBusReference | null {
  return value ? normalizeReference(value, context) : null;
}

function normalizeEventTypes(value: string[] | null): string[] | null {
  if (!value) return null;
  const normalized = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : null;
}

function parseEventTypes(raw: string | null): string[] | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function normalizeNullablePositiveInteger(value: number | null): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new Error(`${context} must be a string`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requireNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context} must be a finite number`);
  }
  return value;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function assertOwnerType(value: string): asserts value is SamEventBusSubscriptionOwnerType {
  if (!(EVENT_BUS_SUBSCRIPTION_OWNER_TYPES as readonly string[]).includes(value)) {
    throw new Error(`Invalid event bus subscription owner type: ${value}`);
  }
}

function assertDeliveryPolicy(value: string): asserts value is SamEventBusDeliveryPolicy {
  if (!(EVENT_BUS_DELIVERY_POLICIES as readonly string[]).includes(value)) {
    throw new Error(`Invalid event bus delivery policy: ${value}`);
  }
}

function assertDeliveryState(value: string): asserts value is SamEventBusDeliveryState {
  if (!(EVENT_BUS_DELIVERY_STATES as readonly string[]).includes(value)) {
    throw new Error(`Invalid event bus delivery state: ${value}`);
  }
}

function encodeEventBusCursor(cursor: EventBusCursor): string {
  return encodeBase64Url(JSON.stringify(cursor));
}

function decodeEventBusCursor(raw: string, subscriptionId: string): EventBusCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(raw)) as unknown;
  } catch {
    throw new EventBusCursorError();
  }
  const record = expectJsonRecord(parsed, 'event_bus.cursor');
  if (record.version !== 1) throw new EventBusCursorError();
  if (record.subscriptionId !== subscriptionId) throw new EventBusCursorError();
  if (
    typeof record.afterSequence !== 'number' ||
    !Number.isSafeInteger(record.afterSequence) ||
    record.afterSequence < 0
  ) {
    throw new EventBusCursorError();
  }
  if (typeof record.afterDeliveryId !== 'string') throw new EventBusCursorError();
  return {
    version: 1,
    subscriptionId,
    afterSequence: record.afterSequence,
    afterDeliveryId: record.afterDeliveryId,
  };
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    Math.ceil(value.length / 4) * 4,
    '='
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
