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

export class EventBusPayloadTooLargeError extends Error {
  constructor(
    public readonly actualBytes: number,
    public readonly maxBytes: number
  ) {
    super('Event bus payload exceeds configured byte limit');
    this.name = 'EventBusPayloadTooLargeError';
  }
}

export class EventBusMetadataTooLargeError extends Error {
  constructor(
    public readonly actualBytes: number,
    public readonly maxBytes: number
  ) {
    super('Event bus metadata exceeds configured byte limit');
    this.name = 'EventBusMetadataTooLargeError';
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

export interface EventBusCursor {
  version: 1;
  subscriptionId: string;
  afterSequence: number;
  afterDeliveryId: string;
}

export interface EventBusEventSummaryRow {
  id: string;
  sequence: number;
  type: string;
  source: string;
  subject_type: string;
  subject_id: string | null;
  actor_type: string;
  actor_id: string | null;
  metadata: string;
  occurred_at: number;
  created_at: number;
}

export interface EventBusEventRow extends EventBusEventSummaryRow {
  payload: string;
}
