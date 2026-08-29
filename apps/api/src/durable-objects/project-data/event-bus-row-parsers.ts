import { expectJsonRecord, parseJsonRecord } from '../../lib/runtime-validation';
import type {
  EventBusEventRow,
  EventBusEventSummaryRow,
  EventBusSubscriptionRecord,
  SamEventBusDeliveryInfo,
  SamEventBusDeliveryPolicy,
  SamEventBusDeliveryRecord,
  SamEventBusDeliveryState,
  SamEventBusEventSummary,
  SamEventBusReference,
  SamEventBusStoredEvent,
  SamEventBusSubscriptionOwnerType,
} from './event-bus-contracts';
import {
  EVENT_BUS_DELIVERY_POLICIES,
  EVENT_BUS_DELIVERY_STATES,
  EVENT_BUS_SUBSCRIPTION_OWNER_TYPES,
} from './event-bus-contracts';

export function eventToSummary(
  event: EventBusEventSummaryRow,
  delivery: SamEventBusDeliveryInfo
): SamEventBusEventSummary {
  return {
    ...eventToStoredEvent(event),
    delivery,
  };
}

export function eventToStoredEvent(event: EventBusEventSummaryRow): SamEventBusStoredEvent {
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

export function parseEventPayload(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

export function parseEventSummaryRow(row: unknown): EventBusEventSummaryRow {
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
    occurred_at: requireNumber(record.occurred_at, 'event_bus.event.occurred_at'),
    created_at: requireNumber(record.created_at, 'event_bus.event.created_at'),
  };
}

export function parseEventRow(row: unknown): EventBusEventRow {
  const record = expectJsonRecord(row, 'event_bus.event.row');
  return {
    ...parseEventSummaryRow(record),
    payload: requireString(record.payload, 'event_bus.event.payload'),
  };
}

export function parseSubscriptionRow(row: unknown): EventBusSubscriptionRecord {
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

export function parseEventDeliveryJoinRow(row: unknown): {
  event: EventBusEventRow;
  delivery: SamEventBusDeliveryInfo;
} {
  const record = expectJsonRecord(row, 'event_bus.delivery.join_row');
  return {
    event: parseEventRow(record),
    delivery: parseDeliveryInfo(record),
  };
}

export function parseEventDeliverySummaryJoinRow(row: unknown): {
  event: EventBusEventSummaryRow;
  delivery: SamEventBusDeliveryInfo;
} {
  const record = expectJsonRecord(row, 'event_bus.delivery.summary_join_row');
  return {
    event: parseEventSummaryRow(record),
    delivery: parseDeliveryInfo(record),
  };
}

function parseDeliveryInfo(record: Record<string, unknown>): SamEventBusDeliveryInfo {
  const deliveryState = requireString(record.delivery_state, 'event_bus.delivery.state');
  assertDeliveryState(deliveryState);
  const policy = (optionalString(record.policy) ?? 'none') as SamEventBusDeliveryPolicy;
  assertDeliveryPolicy(policy);
  return {
    id: requireString(record.delivery_id, 'event_bus.delivery.id'),
    subscriptionId: requireString(record.subscription_id, 'event_bus.delivery.subscription_id'),
    state: deliveryState,
    policy,
    ackRequired: policy === 'ack_required',
    createdAt: requireNumber(record.delivery_created_at, 'event_bus.delivery.created_at'),
    deliveredAt: optionalNumber(record.delivered_at),
    acknowledgedAt: optionalNumber(record.acknowledged_at),
  };
}

export function parseDeliveryRecordRow(row: unknown): SamEventBusDeliveryRecord {
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

export function readRequiredStringColumn(row: unknown, column: string, context: string): string {
  const record = expectJsonRecord(row, context);
  return requireString(record[column], `${context}.${column}`);
}

export function readOptionalNumberColumn(
  row: unknown,
  column: string,
  context: string
): number | null {
  if (!row) return null;
  const record = expectJsonRecord(row, context);
  const value = record[column];
  return value === null || value === undefined
    ? null
    : requireNumber(value, `${context}.${column}`);
}

export function subscriptionMatchesEvent(
  subscription: EventBusSubscriptionRecord,
  event: EventBusEventSummaryRow
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

export function normalizeReference(
  value: SamEventBusReference | null,
  context: string
): SamEventBusReference {
  if (!value) throw new Error(`${context} is required`);
  const type = value.type.trim();
  if (!type) throw new Error(`${context}.type is required`);
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : null;
  return { type, id };
}

export function normalizeOptionalReference(
  value: SamEventBusReference | null,
  context: string
): SamEventBusReference | null {
  return value ? normalizeReference(value, context) : null;
}

export function normalizeEventTypes(value: string[] | null): string[] | null {
  if (!value) return null;
  const normalized = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : null;
}

export function normalizeNullablePositiveInteger(value: number | null): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

export function assertOwnerType(value: string): asserts value is SamEventBusSubscriptionOwnerType {
  if (!(EVENT_BUS_SUBSCRIPTION_OWNER_TYPES as readonly string[]).includes(value)) {
    throw new Error(`Invalid event bus subscription owner type: ${value}`);
  }
}

export function assertDeliveryPolicy(value: string): asserts value is SamEventBusDeliveryPolicy {
  if (!(EVENT_BUS_DELIVERY_POLICIES as readonly string[]).includes(value)) {
    throw new Error(`Invalid event bus delivery policy: ${value}`);
  }
}

function assertDeliveryState(value: string): asserts value is SamEventBusDeliveryState {
  if (!(EVENT_BUS_DELIVERY_STATES as readonly string[]).includes(value)) {
    throw new Error(`Invalid event bus delivery state: ${value}`);
  }
}

function parseEventTypes(raw: string | null): string[] | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new TypeError(`${context} must be a string`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function requireNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${context} must be a finite number`);
  }
  return value;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
